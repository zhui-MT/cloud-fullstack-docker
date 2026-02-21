const crypto = require('crypto');

class JobManager {
  constructor({ moduleRunners }) {
    this.jobs = new Map();
    this.queue = [];
    this.processing = false;
    this.moduleRunners = moduleRunners;
  }

  createJob(moduleName, payload) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      module: moduleName,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      request: payload,
      result: null,
      error: null,
      logs: [{ ts: now, level: 'info', message: `Job queued: ${moduleName}` }],
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    this._drain();
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  listModules() {
    return Object.keys(this.moduleRunners);
  }

  async _drain() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job) {
        continue;
      }
      await this._runJob(job);
    }

    this.processing = false;
  }

  async _runJob(job) {
    const runner = this.moduleRunners[job.module];
    const appendLog = (level, message) => {
      job.logs.push({ ts: new Date().toISOString(), level, message });
    };

    if (!runner) {
      job.status = 'failed';
      job.startedAt = new Date().toISOString();
      job.finishedAt = new Date().toISOString();
      job.error = {
        code: 'MODULE_NOT_FOUND',
        message: `unsupported module: ${job.module}`,
      };
      appendLog('error', job.error.message);
      return;
    }

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    appendLog('info', `Job started: ${job.module}`);

    try {
      job.result = await runner(job.request || {}, appendLog);
      job.status = 'succeeded';
      appendLog('info', 'Job completed');
    } catch (error) {
      job.status = 'failed';
      job.error = {
        code: error.code || 'MODULE_EXECUTION_FAILED',
        message: error.message,
      };
      appendLog('error', error.message);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }
}

module.exports = {
  JobManager,
};
