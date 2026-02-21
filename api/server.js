const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const { createJobManager } = require('./src/jobManager');
const { createJobStore } = require('./src/jobStore');
const { buildModuleRunners, SUPPORTED_ENGINES } = require('./src/modules/deEnrich');

function createDbPool() {
  return new Pool({
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'appdb',
  });
}

function createApp(options = {}) {
  const pool = options.pool || createDbPool();
  const app = express();
  const queueMode = options.queueMode || process.env.JOB_QUEUE_MODE || 'memory';
  const storeMode = options.storeMode || process.env.JOB_STORE_MODE || 'memory';
  const redisOptions = {
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 1000);
    },
    connectTimeout: 1000,
    ...(options.redisOptions || {}),
  };
  const jobStore = createJobStore({
    mode: storeMode,
    pool,
  });
  const moduleRunners = options.moduleRunners || buildModuleRunners();
  const jobManager = createJobManager({
    moduleRunners,
    queueMode,
    redisOptions,
    jobStore,
  });

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.locals.jobManager = jobManager;
  app.locals.jobStore = jobStore;
  app.locals.queueMode = queueMode;
  app.locals.storeMode = storeMode;

  const loadJob = async (id) => {
    const fromQueue = await jobManager.getJob(id);
    if (fromQueue) return fromQueue;
    return jobStore.getJob(id);
  };

  app.get('/api/health', async (_req, res) => {
    try {
      const result = await pool.query('SELECT NOW() AS now');
      res.json({ ok: true, service: 'api', dbTime: result.rows[0].now });
    } catch (err) {
      res.status(500).json({ ok: false, service: 'api', error: err.message });
    }
  });

  app.get('/api/modules', (_req, res) => {
    const queue = typeof jobManager.getQueueInfo === 'function' ? jobManager.getQueueInfo() : { mode: queueMode };
    res.json({
      modules: jobManager.listModules(),
      deEngines: SUPPORTED_ENGINES,
      implementedDeEngine: ['limma'],
      queue,
      store: { mode: storeMode },
    });
  });

  app.post('/api/run/:module', async (req, res) => {
    const moduleName = req.params.module;
    const knownModules = jobManager.listModules();

    if (!knownModules.includes(moduleName)) {
      return res.status(404).json({
        error: `unsupported module: ${moduleName}`,
        allowedModules: knownModules,
      });
    }

    let job;
    try {
      job = await jobManager.createJob(moduleName, req.body || {}, {
        retryOf: null,
        retryCount: 0,
      });
    } catch (error) {
      return res.status(500).json({
        error: 'failed to enqueue job',
        details: error.message,
      });
    }

    return res.status(202).json({
      ok: true,
      jobId: job.id,
      module: job.module,
      status: job.status,
      createdAt: job.createdAt,
      canceledAt: job.canceledAt || null,
      canceledBy: job.canceledBy || null,
      retryOf: job.retryOf || null,
      retryCount: Number.isInteger(job.retryCount) ? job.retryCount : 0,
      statusUrl: `/api/job/${job.id}`,
    });
  });

  app.get('/api/job/:id', async (req, res) => {
    let job;
    try {
      job = await loadJob(req.params.id);
    } catch (error) {
      return res.status(500).json({
        error: 'failed to query job',
        details: error.message,
      });
    }
    if (!job) {
      return res.status(404).json({ error: 'job not found' });
    }

    return res.json({
      id: job.id,
      module: job.module,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      canceledAt: job.canceledAt || null,
      canceledBy: job.canceledBy || null,
      retryOf: job.retryOf || null,
      retryCount: Number.isInteger(job.retryCount) ? job.retryCount : 0,
      request: job.request,
      result: job.result,
      error: job.error,
      logs: job.logs,
    });
  });

  app.post('/api/job/:id/cancel', async (req, res) => {
    const jobId = req.params.id;
    const canceledBy =
      req.body && typeof req.body.canceledBy === 'string' ? req.body.canceledBy : undefined;
    let canceled;
    try {
      canceled = await jobManager.cancelJob(jobId, { canceledBy });
    } catch (error) {
      return res.status(500).json({
        error: 'failed to cancel job',
        details: error.message,
      });
    }

    if (!canceled || !canceled.found) {
      return res.status(404).json({ error: 'job not found' });
    }

    if (!canceled.canceled) {
      return res.status(409).json({
        error: canceled.message || 'job cannot be canceled',
        code: canceled.code || 'JOB_NOT_CANCELABLE',
        status: canceled.job?.status || null,
      });
    }

    return res.status(canceled.pending ? 202 : 200).json({
      ok: true,
      jobId,
      pending: Boolean(canceled.pending),
      status: canceled.job?.status || null,
      canceledAt: canceled.job?.canceledAt || null,
      canceledBy: canceled.job?.canceledBy || null,
      statusUrl: `/api/job/${jobId}`,
    });
  });

  app.post('/api/job/:id/retry', async (req, res) => {
    const sourceId = req.params.id;
    let sourceJob;

    try {
      sourceJob = await loadJob(sourceId);
    } catch (error) {
      return res.status(500).json({
        error: 'failed to load source job',
        details: error.message,
      });
    }

    if (!sourceJob) {
      return res.status(404).json({ error: 'source job not found' });
    }

    if (sourceJob.status !== 'failed') {
      return res.status(409).json({
        error: 'only failed jobs can be retried',
        sourceStatus: sourceJob.status,
      });
    }

    const retryRequest =
      req.body && typeof req.body.request === 'object' && req.body.request !== null
        ? req.body.request
        : sourceJob.request || {};

    let retryJob;
    const nextRetryCount =
      Number.isInteger(sourceJob.retryCount) && sourceJob.retryCount >= 0 ? sourceJob.retryCount + 1 : 1;
    try {
      retryJob = await jobManager.createJob(sourceJob.module, retryRequest, {
        retryOf: sourceJob.id,
        retryCount: nextRetryCount,
      });
    } catch (error) {
      return res.status(500).json({
        error: 'failed to enqueue retry job',
        details: error.message,
      });
    }

    return res.status(202).json({
      ok: true,
      sourceJobId: sourceId,
      retryJobId: retryJob.id,
      module: retryJob.module,
      status: retryJob.status,
      createdAt: retryJob.createdAt,
      retryOf: retryJob.retryOf || sourceJob.id,
      retryCount: Number.isInteger(retryJob.retryCount) ? retryJob.retryCount : nextRetryCount,
      statusUrl: `/api/job/${retryJob.id}`,
    });
  });

  app.get('/api/jobs', async (req, res) => {
    const limit = Number.parseInt(req.query.limit || '50', 10);
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const moduleName = typeof req.query.module === 'string' ? req.query.module : undefined;
    let decodedCursor = null;

    if (typeof req.query.cursor === 'string' && req.query.cursor.trim() !== '') {
      try {
        decodedCursor = decodeCursor(req.query.cursor.trim());
      } catch (error) {
        return res.status(400).json({
          error: 'invalid cursor',
          details: error.message,
        });
      }
    }

    try {
      const page = await jobStore.listJobs({
        limit: safeLimit,
        status,
        module: moduleName,
        cursor: decodedCursor,
      });

      const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;
      return res.json({
        items: page.items,
        total: page.items.length,
        limit: safeLimit,
        nextCursor,
      });
    } catch (error) {
      return res.status(500).json({
        error: 'failed to list jobs',
        details: error.message,
      });
    }
  });

  app.get('/api/messages', async (_req, res) => {
    try {
      const result = await pool.query('SELECT id, content, created_at FROM messages ORDER BY id DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/messages', async (req, res) => {
    const { content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }

    try {
      const result = await pool.query(
        'INSERT INTO messages(content) VALUES($1) RETURNING id, content, created_at',
        [content]
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw) {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('cursor payload must include createdAt and id');
  }
  if (Number.isNaN(Date.parse(parsed.createdAt))) {
    throw new Error('cursor createdAt is invalid');
  }
  return parsed;
}

function startServer(port = Number(process.env.API_PORT || 4000)) {
  const app = createApp();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`API running on port ${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
};
