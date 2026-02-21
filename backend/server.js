const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const { JobManager } = require('./src/jobManager');
const { buildModuleRunners, SUPPORTED_ENGINES } = require('./src/modules/deEnrich');

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'appdb',
});

const jobManager = new JobManager({ moduleRunners: buildModuleRunners() });

app.get('/api/health', async (_req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, dbTime: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/modules', (_req, res) => {
  res.json({
    modules: jobManager.listModules(),
    deEngines: SUPPORTED_ENGINES,
    implementedDeEngine: ['limma'],
  });
});

app.post('/api/run/:module', (req, res) => {
  const moduleName = req.params.module;
  const knownModules = jobManager.listModules();

  if (!knownModules.includes(moduleName)) {
    return res.status(404).json({
      error: `unsupported module: ${moduleName}`,
      allowedModules: knownModules,
    });
  }

  const job = jobManager.createJob(moduleName, req.body || {});

  return res.status(202).json({
    ok: true,
    jobId: job.id,
    module: job.module,
    status: job.status,
    createdAt: job.createdAt,
    statusUrl: `/api/job/${job.id}`,
  });
});

app.get('/api/job/:id', (req, res) => {
  const job = jobManager.getJob(req.params.id);
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
    request: job.request,
    result: job.result,
    error: job.error,
    logs: job.logs,
  });
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

app.listen(port, () => {
  console.log(`API running at http://localhost:${port}`);
});
