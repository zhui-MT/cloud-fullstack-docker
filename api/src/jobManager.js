const { randomUUID } = require('crypto');

class InMemoryJobManager {
  constructor({ moduleRunners, jobStore = null }) {
    this.jobs = new Map();
    this.queue = [];
    this.processing = false;
    this.runningControllers = new Map();
    this.moduleRunners = moduleRunners;
    this.jobStore = jobStore;
  }

  listModules() {
    return Object.keys(this.moduleRunners);
  }

  async createJob(moduleName, payload, meta = {}) {
    const id = randomId();
    const now = new Date().toISOString();
    const retryOf = typeof meta.retryOf === 'string' ? meta.retryOf : null;
    const retryCount = Number.isInteger(meta.retryCount) && meta.retryCount >= 0 ? meta.retryCount : 0;
    const job = {
      id,
      module: moduleName,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      canceledAt: null,
      canceledBy: null,
      retryOf,
      retryCount,
      request: payload,
      result: null,
      error: null,
      logs: [{ ts: now, level: 'info', message: `Job queued: ${moduleName}` }],
    };

    this.jobs.set(id, job);
    await this._persistJob(job);
    this.queue.push(id);
    this._drain();
    return job;
  }

  async getJob(id) {
    return this.jobs.get(id) || null;
  }

  async cancelJob(id, options = {}) {
    const job = this.jobs.get(id);
    if (!job) {
      return { found: false };
    }
    const canceledBy = ensureCanceledBy(options.canceledBy);

    if (isTerminalStatus(job.status)) {
      return {
        found: true,
        canceled: false,
        code: 'JOB_NOT_CANCELABLE',
        message: `job status '${job.status}' cannot be canceled`,
        job,
      };
    }

    if (job.status === 'queued') {
      this.queue = this.queue.filter((jobId) => jobId !== id);
      job.status = 'canceled';
      job.finishedAt = new Date().toISOString();
      job.canceledAt = new Date().toISOString();
      job.canceledBy = canceledBy;
      job.error = {
        code: 'JOB_CANCELED',
        message: 'job canceled before execution',
      };
      job.logs.push({
        ts: new Date().toISOString(),
        level: 'warn',
        message: 'Job canceled before execution',
      });
      await this._persistJob(job);
      return {
        found: true,
        canceled: true,
        pending: false,
        job,
      };
    }

    if (job.status === 'running') {
      job.cancelRequested = true;
      if (!job.canceledBy) {
        job.canceledBy = canceledBy;
      }
      const controller = this.runningControllers.get(id);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
      job.logs.push({
        ts: new Date().toISOString(),
        level: 'warn',
        message: 'Cancellation requested while running',
      });
      await this._persistJob(job);
      return {
        found: true,
        canceled: true,
        pending: true,
        job,
      };
    }

    return {
      found: true,
      canceled: false,
      code: 'JOB_NOT_CANCELABLE',
      message: `job status '${job.status}' cannot be canceled`,
      job,
    };
  }

  async close() {
    return undefined;
  }

  getQueueInfo() {
    return {
      mode: 'memory',
      fallbackActive: false,
    };
  }

  async _drain() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job) continue;
      await this._runJob(job);
    }

    this.processing = false;
  }

  async _runJob(job) {
    const appendLog = (level, message) => {
      job.logs.push({ ts: new Date().toISOString(), level, message });
    };

    const runner = this.moduleRunners[job.module];
    if (!runner) {
      job.status = 'failed';
      job.startedAt = new Date().toISOString();
      job.finishedAt = new Date().toISOString();
      job.error = { code: 'MODULE_NOT_FOUND', message: `unsupported module: ${job.module}` };
      appendLog('error', job.error.message);
      await this._persistJob(job);
      return;
    }

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    appendLog('info', `Job started: ${job.module}`);
    await this._persistJob(job);

    const controller = new AbortController();
    this.runningControllers.set(job.id, controller);
    const context = {
      signal: controller.signal,
      throwIfCanceled: () => {
        if (job.cancelRequested || controller.signal.aborted) {
          throw makeCanceledError();
        }
      },
    };

    try {
      context.throwIfCanceled();
      job.result = await runner(job.request || {}, appendLog, context);
      context.throwIfCanceled();
      if (job.cancelRequested || controller.signal.aborted) {
        job.status = 'canceled';
        job.result = null;
        job.canceledAt = new Date().toISOString();
        if (!job.canceledBy) {
          job.canceledBy = 'system';
        }
        job.error = {
          code: 'JOB_CANCELED',
          message: 'job canceled during execution',
        };
        appendLog('warn', 'Job canceled during execution');
      } else {
        job.status = 'succeeded';
        appendLog('info', 'Job completed');
      }
    } catch (error) {
      if (job.cancelRequested || isCanceledError(error)) {
        job.status = 'canceled';
        job.result = null;
        job.canceledAt = new Date().toISOString();
        if (!job.canceledBy) {
          job.canceledBy = 'system';
        }
        job.error = {
          code: 'JOB_CANCELED',
          message: 'job canceled during execution',
        };
        appendLog('warn', 'Job canceled during execution');
      } else {
        job.status = 'failed';
        job.error = {
          code: error.code || 'MODULE_EXECUTION_FAILED',
          message: error.message,
        };
        appendLog('error', error.message);
      }
    } finally {
      this.runningControllers.delete(job.id);
      job.finishedAt = new Date().toISOString();
      await this._persistJob(job);
    }
  }

  async _persistJob(job) {
    if (!this.jobStore) return;
    try {
      await this.jobStore.upsertJob(job);
    } catch (_error) {
      // Ignore persistence failures to avoid blocking execution.
    }
  }
}

class BullmqJobManager {
  constructor({ moduleRunners, redisOptions, queueName = 'analysis-jobs', jobStore = null }) {
    const IORedis = require('ioredis');
    const { Queue, Worker, QueueEvents } = require('bullmq');

    this.moduleRunners = moduleRunners;
    this.jobStore = jobStore;
    this.queueName = queueName;
    this.connection = new IORedis(redisOptions);
    this.queue = new Queue(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
    this.queueEvents = new QueueEvents(queueName, { connection: this.connection });

    this.worker = new Worker(
      queueName,
      async (job) => this._processJob(job),
      {
        connection: this.connection,
      }
    );

    this.connection.on('error', () => {});
    this.queue.on('error', () => {});
    this.queueEvents.on('error', () => {});
    this.worker.on('error', () => {});
  }

  listModules() {
    return Object.keys(this.moduleRunners);
  }

  async createJob(moduleName, payload, meta = {}) {
    const jobId = randomId();
    const retryOf = typeof meta.retryOf === 'string' ? meta.retryOf : null;
    const retryCount = Number.isInteger(meta.retryCount) && meta.retryCount >= 0 ? meta.retryCount : 0;
    const job = await this.queue.add(
      moduleName,
      {
        module: moduleName,
        request: payload,
        retryOf,
        retryCount,
      },
      { jobId }
    );

    const snapshot = {
      id: String(job.id),
      module: moduleName,
      status: mapBullState('waiting'),
      createdAt: new Date(job.timestamp).toISOString(),
      canceledAt: null,
      canceledBy: null,
      retryOf,
      retryCount,
    };
    await this._persistJob(snapshot);
    return snapshot;
  }

  async getJob(id) {
    const job = await this.queue.getJob(id);
    if (!job) return null;

    const state = await job.getState();
    const status = mapBullState(state);
    const logs = await this._readLogs(job);

    let result = null;
    let error = null;

    if (status === 'succeeded' && job.returnvalue) {
      result = job.returnvalue.result || null;
    }

    if (status === 'failed') {
      error = parseBullError(job.failedReason);
    }

    const snapshot = {
      id: String(job.id),
      module: job.data.module,
      status,
      createdAt: toIso(job.timestamp),
      startedAt: toIso(job.processedOn),
      finishedAt: toIso(job.finishedOn),
      canceledAt: null,
      canceledBy: null,
      retryOf: job.data.retryOf || null,
      retryCount: Number.isInteger(job.data.retryCount) ? job.data.retryCount : 0,
      request: job.data.request,
      result,
      error,
      logs,
    };
    await this._persistJob(snapshot);
    return snapshot;
  }

  async cancelJob(id, options = {}) {
    const job = await this.queue.getJob(id);
    if (!job) {
      return { found: false };
    }
    const canceledBy = ensureCanceledBy(options.canceledBy);

    const state = await job.getState();
    const mapped = mapBullState(state);

    if (mapped === 'queued') {
      await job.remove();
      const snapshot = {
        id: String(job.id),
        module: job.data.module,
        status: 'canceled',
        createdAt: toIso(job.timestamp),
        startedAt: null,
        finishedAt: new Date().toISOString(),
        canceledAt: new Date().toISOString(),
        canceledBy,
        retryOf: job.data.retryOf || null,
        retryCount: Number.isInteger(job.data.retryCount) ? job.data.retryCount : 0,
        request: job.data.request || {},
        result: null,
        error: {
          code: 'JOB_CANCELED',
          message: 'job canceled before execution',
        },
        logs: [
          {
            ts: new Date().toISOString(),
            level: 'warn',
            message: 'Job canceled before execution',
          },
        ],
      };
      await this._persistJob(snapshot);
      return {
        found: true,
        canceled: true,
        pending: false,
        job: snapshot,
      };
    }

    if (mapped === 'running') {
      return {
        found: true,
        canceled: false,
        code: 'CANCEL_NOT_SUPPORTED_ACTIVE',
        message: 'active bullmq jobs cannot be canceled without cooperative cancellation',
        job: await this.getJob(id),
      };
    }

    return {
      found: true,
      canceled: false,
      code: 'JOB_NOT_CANCELABLE',
      message: `job status '${mapped}' cannot be canceled`,
      job: await this.getJob(id),
    };
  }

  async close() {
    await Promise.allSettled([
      this.worker?.close(),
      this.queueEvents?.close(),
      this.queue?.close(),
      this.connection?.quit(),
    ]);
  }

  getQueueInfo() {
    return {
      mode: 'bullmq',
      fallbackActive: false,
    };
  }

  async _processJob(job) {
    const runner = this.moduleRunners[job.data.module];
    const logs = [];

    const appendLog = async (level, message) => {
      const entry = { ts: new Date().toISOString(), level, message };
      logs.push(entry);
      try {
        await job.log(JSON.stringify(entry));
      } catch (_error) {
        // Ignore log write failures and keep processing.
      }
    };

    if (!runner) {
      await appendLog('error', `unsupported module: ${job.data.module}`);
      await this._persistJob({
        id: String(job.id),
        module: job.data.module,
        status: 'failed',
        createdAt: toIso(job.timestamp),
        startedAt: toIso(job.processedOn) || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        retryOf: job.data.retryOf || null,
        retryCount: Number.isInteger(job.data.retryCount) ? job.data.retryCount : 0,
        request: job.data.request || {},
        result: null,
        error: {
          code: 'MODULE_NOT_FOUND',
          message: `unsupported module: ${job.data.module}`,
        },
        logs,
      });
      const err = new Error(
        JSON.stringify({
          code: 'MODULE_NOT_FOUND',
          message: `unsupported module: ${job.data.module}`,
          logs,
        })
      );
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }

    await appendLog('info', `Job started: ${job.data.module}`);

    try {
      const result = await runner(
        job.data.request || {},
        (level, message) => appendLog(level, message),
        {
          signal: null,
          throwIfCanceled: () => {},
        }
      );
      await appendLog('info', 'Job completed');
      await this._persistJob({
        id: String(job.id),
        module: job.data.module,
        status: 'succeeded',
        createdAt: toIso(job.timestamp),
        startedAt: toIso(job.processedOn) || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        retryOf: job.data.retryOf || null,
        retryCount: Number.isInteger(job.data.retryCount) ? job.data.retryCount : 0,
        request: job.data.request || {},
        result,
        error: null,
        logs,
      });
      return { result, logs };
    } catch (error) {
      await appendLog('error', error.message);
      await this._persistJob({
        id: String(job.id),
        module: job.data.module,
        status: 'failed',
        createdAt: toIso(job.timestamp),
        startedAt: toIso(job.processedOn) || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        retryOf: job.data.retryOf || null,
        retryCount: Number.isInteger(job.data.retryCount) ? job.data.retryCount : 0,
        request: job.data.request || {},
        result: null,
        error: {
          code: error.code || 'MODULE_EXECUTION_FAILED',
          message: error.message,
        },
        logs,
      });
      const wrapped = new Error(
        JSON.stringify({
          code: error.code || 'MODULE_EXECUTION_FAILED',
          message: error.message,
          logs,
        })
      );
      wrapped.code = error.code || 'MODULE_EXECUTION_FAILED';
      throw wrapped;
    }
  }

  async _readLogs(job) {
    if (job.returnvalue?.logs && Array.isArray(job.returnvalue.logs)) {
      return job.returnvalue.logs;
    }

    const raw = await this.queue.getJobLogs(job.id, 0, 1000, true);
    const lines = raw?.logs || [];

    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return { ts: null, level: 'info', message: line };
        }
      })
      .filter(Boolean);
  }

  async _persistJob(job) {
    if (!this.jobStore) return;
    try {
      await this.jobStore.upsertJob(job);
    } catch (_error) {
      // Ignore persistence failures to avoid blocking queue execution.
    }
  }
}

function createJobManager({ moduleRunners, queueMode = 'memory', redisOptions = {}, jobStore = null }) {
  if (queueMode === 'bullmq') {
    return new ResilientJobManager({
      primary: new BullmqJobManager({ moduleRunners, redisOptions, jobStore }),
      fallback: new InMemoryJobManager({ moduleRunners, jobStore }),
      jobStore,
    });
  }
  return new InMemoryJobManager({ moduleRunners, jobStore });
}

class ResilientJobManager {
  constructor({ primary, fallback, jobStore = null }) {
    this.primary = primary;
    this.fallback = fallback;
    this.useFallback = false;
    this.jobStore = jobStore;
  }

  listModules() {
    return this.primary.listModules();
  }

  async createJob(moduleName, payload, meta = {}) {
    if (this.useFallback) {
      return this.fallback.createJob(moduleName, payload, meta);
    }

    try {
      return await this.primary.createJob(moduleName, payload, meta);
    } catch (error) {
      if (!isRedisConnectionError(error)) {
        throw error;
      }

      this.useFallback = true;
      await this.primary.close();
      const snapshot = await this.fallback.createJob(moduleName, payload, meta);
      await this._persistJob(snapshot);
      return snapshot;
    }
  }

  async getJob(id) {
    if (this.useFallback) {
      const fromFallback = await this.fallback.getJob(id);
      if (fromFallback) return fromFallback;
      try {
        return await this.primary.getJob(id);
      } catch (error) {
        if (isRedisConnectionError(error)) return null;
        throw error;
      }
    }

    let fromPrimary;
    try {
      fromPrimary = await this.primary.getJob(id);
    } catch (error) {
      if (isRedisConnectionError(error)) {
        this.useFallback = true;
        await this.primary.close();
        return this.fallback.getJob(id);
      }
      throw error;
    }
    if (fromPrimary) return fromPrimary;
    return this.fallback.getJob(id);
  }

  async cancelJob(id, options = {}) {
    if (this.useFallback) {
      return this.fallback.cancelJob(id, options);
    }

    try {
      const canceled = await this.primary.cancelJob(id, options);
      if (canceled?.found) return canceled;
      return this.fallback.cancelJob(id, options);
    } catch (error) {
      if (isRedisConnectionError(error)) {
        this.useFallback = true;
        await this.primary.close();
        return this.fallback.cancelJob(id, options);
      }
      throw error;
    }
  }

  async close() {
    await Promise.allSettled([this.primary.close(), this.fallback.close()]);
  }

  getQueueInfo() {
    return {
      mode: this.useFallback ? 'memory-fallback' : 'bullmq',
      fallbackActive: this.useFallback,
    };
  }

  async _persistJob(job) {
    if (!this.jobStore) return;
    try {
      await this.jobStore.upsertJob(job);
    } catch (_error) {
      // Ignore persistence failures to avoid blocking execution.
    }
  }
}

function mapBullState(state) {
  if (state === 'waiting' || state === 'delayed' || state === 'paused') return 'queued';
  if (state === 'active') return 'running';
  if (state === 'completed') return 'succeeded';
  if (state === 'failed') return 'failed';
  return state || 'queued';
}

function isTerminalStatus(status) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function ensureCanceledBy(input) {
  if (typeof input === 'string' && input.trim() !== '') {
    return input.trim().slice(0, 128);
  }
  return 'api';
}

function parseBullError(failedReason) {
  if (!failedReason) {
    return { code: 'MODULE_EXECUTION_FAILED', message: 'job failed' };
  }

  try {
    const parsed = JSON.parse(failedReason);
    return {
      code: parsed.code || 'MODULE_EXECUTION_FAILED',
      message: parsed.message || failedReason,
    };
  } catch (_error) {
    const [prefix, ...rest] = String(failedReason).split(':');
    if (rest.length > 0 && /^[A-Z0-9_]+$/.test(prefix.trim())) {
      return {
        code: prefix.trim(),
        message: rest.join(':').trim() || failedReason,
      };
    }

    return {
      code: 'MODULE_EXECUTION_FAILED',
      message: failedReason,
    };
  }
}

function makeCanceledError(message = 'job canceled during execution') {
  const err = new Error(message);
  err.code = 'JOB_CANCELED';
  return err;
}

function isCanceledError(error) {
  if (!error) return false;
  return error.code === 'JOB_CANCELED' || error.name === 'AbortError';
}

function isRedisConnectionError(error) {
  if (!error) return false;
  const message = String(error.message || '');
  const code = String(error.code || '');

  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT' ||
    message.includes('ECONNREFUSED') ||
    message.includes('Connection is closed') ||
    message.includes('connect ETIMEDOUT')
  );
}

function randomId() {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toIso(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString();
}

module.exports = {
  createJobManager,
};
