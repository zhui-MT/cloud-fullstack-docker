const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
require('dotenv').config();

const { JobManager } = require('./src/job-manager');
const { buildModuleRunners, SUPPORTED_ENGINES } = require('./src/modules/de-enrich');
const { validateAndNormalizeConfig } = require('./src/config-validation');
const { computeConfigHash, reproducibilityToken } = require('./src/config-hash');
const { PgConfigRepository, InMemoryConfigRepository } = require('./src/config-repository');
const { AnalysisRunsRepository } = require('./src/analysis-runs-repository');
const { diffConfigs } = require('./src/config-diff');
const { buildAnalysisRunViews } = require('./src/analysis-run-view-builder');
const { buildArtifacts, createAnalysisBundle, hashString } = require('./lib/analysis');
const { parseProteomicsFile } = require('./proteomics-parser');
const { AnalysisPayloadValidationError, uploadToAnalysisPayload } = require('./src/upload-to-analysis-payload');
const { createDefaultUploadBlobStore } = require('./src/upload-blob-store');

function createDbPool() {
  return new Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'appdb',
  });
}

function buildArtifactId(configRev, kind, format, generatedAt) {
  const base = `${configRev}:${kind}:${format}:${generatedAt}`;
  return `art_${hashString(base).toString(16)}`;
}

function computeRequestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function toArtifactMeta(artifact) {
  const meta = {
    artifact_id: artifact.id,
    kind: artifact.kind,
    format: artifact.format,
    file_name: artifact.fileName,
    config_rev: artifact.configRev,
    generated_at: artifact.generatedAt,
  };
  if (artifact.metadata) {
    meta.metadata = artifact.metadata;
  }
  return meta;
}

function pickSessionId(payload = {}) {
  if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
    return payload.sessionId.trim();
  }
  if (typeof payload.session_id === 'string' && payload.session_id.trim()) {
    return payload.session_id.trim();
  }
  return '';
}

function pickUploadId(payload = {}) {
  const raw = payload.uploadId ?? payload.upload_id;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function pickConfigTag(payload = {}) {
  const raw = payload.config_tag ?? payload.configTag;
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim();
}

function isTerminalRunStatus(status) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function createApp(options = {}) {
  const pool = options.pool || createDbPool();
  const configRepository =
    options.configRepository || (typeof pool.connect === 'function' ? new PgConfigRepository(pool) : new InMemoryConfigRepository());
  const analysisRunsRepository = options.analysisRunsRepository || new AnalysisRunsRepository(pool);
  const uploadBlobStore = options.uploadBlobStore || createDefaultUploadBlobStore();

  const app = express();
  const jobManager = new JobManager({ moduleRunners: buildModuleRunners() });
  const artifactStore = new Map();
  const runPayloadCache = new Map();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024,
    },
  });
  let uploadSchemaReady = null;

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  async function ensureUploadSchema() {
    if (uploadSchemaReady) {
      return uploadSchemaReady;
    }

    uploadSchemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS uploads (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          source_tool TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          sample_count INTEGER NOT NULL,
          entity_count INTEGER NOT NULL,
          available_columns JSONB NOT NULL,
          warnings JSONB NOT NULL,
          source_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
          sample_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
          mapped_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
          mapped_rows_storage TEXT NOT NULL DEFAULT 'db',
          mapped_rows_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS source_columns JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS sample_columns JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS mapped_rows JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS mapped_rows_storage TEXT NOT NULL DEFAULT 'db'`);
      await pool.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS mapped_rows_key TEXT`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS session_configs (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          config_rev INTEGER NOT NULL,
          config_hash TEXT NOT NULL,
          config_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(session_id, config_rev),
          UNIQUE(session_id, config_hash)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_configs_session_rev ON session_configs(session_id, config_rev DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_configs_session_hash ON session_configs(session_id, config_hash)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS analysis_runs (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          upload_id BIGINT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
          config_rev INTEGER,
          config_tag TEXT,
          config_hash TEXT,
          status TEXT NOT NULL,
          engine TEXT NOT NULL,
          de_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          enrichment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          sample_groups_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          request_hash TEXT NOT NULL,
          config_trace_json JSONB,
          runtime_json JSONB,
          result_json JSONB,
          views_json JSONB,
          artifact_index JSONB NOT NULL DEFAULT '{}'::jsonb,
          error_json JSONB,
          job_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS config_rev INTEGER`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS config_tag TEXT`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS config_hash TEXT`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS de_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS enrichment_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS sample_groups_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS request_hash TEXT`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS config_trace_json JSONB`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS runtime_json JSONB`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS result_json JSONB`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS views_json JSONB`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS artifact_index JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS error_json JSONB`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS job_id TEXT`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_analysis_runs_status_created_at ON analysis_runs(status, created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_analysis_runs_session_id_created_at ON analysis_runs(session_id, created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_analysis_runs_upload_id_created_at ON analysis_runs(upload_id, created_at DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_analysis_runs_artifact_index_gin ON analysis_runs USING GIN (artifact_index)`);
    })();

    try {
      await uploadSchemaReady;
    } catch (error) {
      uploadSchemaReady = null;
      throw error;
    }
  }

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

  app.post('/api/session', async (req, res) => {
    const rawName = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const sessionName = rawName || `session-${new Date().toISOString()}`;
    const sessionId = crypto.randomUUID();

    try {
      await ensureUploadSchema();
      const result = await pool.query(
        'INSERT INTO sessions(id, name) VALUES ($1, $2) RETURNING id, name, created_at',
        [sessionId, sessionName]
      );

      return res.status(201).json({
        sessionId: result.rows[0].id,
        name: result.rows[0].name,
        createdAt: result.rows[0].created_at,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id/uploads', async (req, res) => {
    const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'session id is required' });
    }

    const limitRaw = req.query.limit === undefined ? '50' : String(req.query.limit);
    const offsetRaw = req.query.offset === undefined ? '0' : String(req.query.offset);
    const limit = Number(limitRaw);
    const offset = Number(offsetRaw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    try {
      await ensureUploadSchema();

      const sessionResult = await pool.query('SELECT id, name, created_at FROM sessions WHERE id = $1', [sessionId]);
      if (!sessionResult.rows[0]) {
        return res.status(404).json({ error: `session not found: ${sessionId}` });
      }

      const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM uploads WHERE session_id = $1', [sessionId]);
      const total = Number(totalResult.rows[0]?.total || 0);

      const listResult = await pool.query(
        `SELECT
          id,
          filename,
          source_tool,
          entity_type,
          row_count,
          sample_count,
          entity_count,
          available_columns,
          warnings,
          source_columns,
          sample_columns,
          mapped_rows_storage,
          mapped_rows_key,
          created_at
        FROM uploads
        WHERE session_id = $1
        ORDER BY id DESC
        LIMIT $2 OFFSET $3`,
        [sessionId, limit, offset]
      );

      return res.json({
        session: {
          sessionId: sessionResult.rows[0].id,
          name: sessionResult.rows[0].name,
          createdAt: sessionResult.rows[0].created_at,
        },
        total,
        offset,
        limit,
        returned: listResult.rows.length,
        uploads: listResult.rows.map((row) => ({
          uploadId: Number(row.id),
          fileName: row.filename,
          detected: {
            sourceTool: row.source_tool,
            entityType: row.entity_type,
          },
          summary: {
            rowCount: Number(row.row_count),
            sampleCount: Number(row.sample_count),
            entityCount: Number(row.entity_count),
            availableColumns: row.available_columns || [],
            sourceColumns: row.source_columns || [],
            sampleColumns: row.sample_columns || [],
            warnings: row.warnings || [],
          },
          detailUrl: `/api/upload/${row.id}`,
          storage: {
            mode: row.mapped_rows_storage || 'db',
            key: row.mapped_rows_key || null,
          },
          createdAt: row.created_at,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/session/:id/uploads', async (req, res) => {
    const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'session id is required' });
    }

    try {
      await ensureUploadSchema();

      const sessionResult = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      if (!sessionResult.rows[0]) {
        return res.status(404).json({ error: `session not found: ${sessionId}` });
      }

      const uploadsResult = await pool.query(
        `SELECT
          id,
          mapped_rows_storage,
          mapped_rows_key
        FROM uploads
        WHERE session_id = $1`,
        [sessionId]
      );

      const warnings = [];
      let blobDeletedCount = 0;
      for (const row of uploadsResult.rows) {
        try {
          const blobDeleted = await deleteMappedRowsBlob(row);
          if (blobDeleted) {
            blobDeletedCount += 1;
          }
        } catch (blobError) {
          warnings.push(`upload ${row.id}: failed to delete mapped rows blob: ${blobError.message}`);
        }
      }

      const deletedResult = await pool.query('DELETE FROM uploads WHERE session_id = $1', [sessionId]);
      const deletedCount = Number(deletedResult.rowCount || 0);

      return res.json({
        ok: true,
        sessionId,
        deletedCount,
        blobDeletedCount,
        warnings,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/upload', upload.single('file'), async (req, res) => {
    const sessionId = pickSessionId(req.body || {});
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId (or session_id) is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file is required (multipart/form-data field: file)' });
    }

    try {
      await ensureUploadSchema();
      const sessionResult = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: `session not found: ${sessionId}` });
      }

      const parsed = parseProteomicsFile(req.file.buffer.toString('utf8'));
      const responseWarnings = Array.isArray(parsed.summary.warnings) ? [...parsed.summary.warnings] : [];
      const inserted = await pool.query(
        `INSERT INTO uploads(
          session_id,
          filename,
          source_tool,
          entity_type,
          row_count,
          sample_count,
          entity_count,
          available_columns,
          warnings,
          source_columns,
          sample_columns,
          mapped_rows,
          mapped_rows_storage,
          mapped_rows_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)
        RETURNING id, created_at`,
        [
          sessionId,
          req.file.originalname,
          parsed.detected.sourceTool,
          parsed.detected.entityType,
          parsed.rowCount,
          parsed.summary.sampleCount,
          parsed.summary.entityCount,
          JSON.stringify(parsed.summary.availableColumns),
          JSON.stringify(parsed.summary.warnings),
          JSON.stringify(parsed.summary.sourceColumns || []),
          JSON.stringify(parsed.sampleColumns || []),
          JSON.stringify(parsed.mappedRows || []),
          'db',
          null,
        ]
      );

      let storageMode = 'db';
      let storageKey = null;
      try {
        storageKey = await uploadBlobStore.saveMappedRows({
          uploadId: inserted.rows[0].id,
          sessionId,
          mappedRows: parsed.mappedRows || [],
        });
        storageMode = 'blob';
        await pool.query(
          'UPDATE uploads SET mapped_rows_storage = $2, mapped_rows_key = $3 WHERE id = $1',
          [inserted.rows[0].id, storageMode, storageKey]
        );
      } catch (storageError) {
        responseWarnings.push(`mapped rows blob persistence failed: ${storageError.message}`);
        await pool.query(
          'UPDATE uploads SET warnings = $2::jsonb WHERE id = $1',
          [inserted.rows[0].id, JSON.stringify(responseWarnings)]
        );
      }

      return res.status(201).json({
        uploadId: inserted.rows[0].id,
        sessionId,
        fileName: req.file.originalname,
        detected: {
          sourceTool: parsed.detected.sourceTool,
          entityType: parsed.detected.entityType,
          delimiter: parsed.delimiter,
        },
        summary: {
          rowCount: parsed.rowCount,
          sampleCount: parsed.summary.sampleCount,
          entityCount: parsed.summary.entityCount,
          availableColumns: parsed.summary.availableColumns,
          sampleColumns: parsed.sampleColumns || [],
          warnings: responseWarnings,
        },
        preview: parsed.preview,
        detailUrl: `/api/upload/${inserted.rows[0].id}`,
        storage: {
          mode: storageMode,
          key: storageKey,
        },
        createdAt: inserted.rows[0].created_at,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  async function resolveMappedRows(row) {
    if (row.mapped_rows_storage === 'blob' && row.mapped_rows_key) {
      try {
        const mappedRows = await uploadBlobStore.readMappedRows(row.mapped_rows_key);
        return { mappedRows: Array.isArray(mappedRows) ? mappedRows : [], loadWarning: null };
      } catch (error) {
        return {
          mappedRows: Array.isArray(row.mapped_rows) ? row.mapped_rows : [],
          loadWarning: `failed to load mapped rows from blob: ${error.message}`,
        };
      }
    }

    return {
      mappedRows: Array.isArray(row.mapped_rows) ? row.mapped_rows : [],
      loadWarning: null,
    };
  }

  async function deleteMappedRowsBlob(row) {
    if (row.mapped_rows_storage === 'blob' && row.mapped_rows_key) {
      await uploadBlobStore.deleteMappedRows(row.mapped_rows_key);
      return true;
    }
    return false;
  }

  function buildAnalysisRunBinding(row) {
    return {
      sessionId: row.session_id,
      uploadId: Number(row.upload_id),
      config_rev: row.config_rev ?? null,
      config_hash: row.config_hash || null,
      config_tag: row.config_tag || null,
    };
  }

  function toAnalysisRunResponse(row) {
    return {
      runId: Number(row.id),
      status: row.status,
      binding: buildAnalysisRunBinding(row),
      runtime: row.runtime_json || null,
      error: row.error_json || null,
      result: row.result_json || null,
    };
  }

  function registerViewArtifacts(options) {
    const {
      views,
      generatedAt,
      artifactMeta,
      fileLabel,
      configRevForArtifacts,
      scopeKey,
    } = options;
    const runViews = {};
    const artifactIndex = {};
    for (const [kind, payload] of Object.entries(views)) {
      const artifacts = buildArtifacts(kind, configRevForArtifacts, payload);
      const csvId = buildArtifactId(`${scopeKey}:${fileLabel}`, kind, 'csv', generatedAt);
      const svgId = buildArtifactId(`${scopeKey}:${fileLabel}`, kind, 'svg', generatedAt);
      const pngId = buildArtifactId(`${scopeKey}:${fileLabel}`, kind, 'png-source', generatedAt);

      artifactStore.set(csvId, {
        id: csvId,
        kind,
        format: 'csv',
        fileName: `${kind}-${fileLabel}.csv`,
        configRev: configRevForArtifacts,
        generatedAt,
        contentType: 'text/csv; charset=utf-8',
        body: artifacts.csv,
        metadata: artifactMeta,
      });

      artifactStore.set(svgId, {
        id: svgId,
        kind,
        format: 'svg',
        fileName: `${kind}-${fileLabel}.svg`,
        configRev: configRevForArtifacts,
        generatedAt,
        contentType: 'image/svg+xml; charset=utf-8',
        body: artifacts.svg,
        metadata: artifactMeta,
      });

      artifactStore.set(pngId, {
        id: pngId,
        kind,
        format: 'png-source',
        fileName: `${kind}-${fileLabel}.png`,
        configRev: configRevForArtifacts,
        generatedAt,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          svg: artifacts.png_source_svg,
          metadata: {
            ...artifactMeta,
            kind,
          },
        }),
        metadata: artifactMeta,
      });

      runViews[kind] = {
        data: payload,
        artifact_meta: {
          ...artifactMeta,
          kind,
        },
        downloads: {
          csv: `/api/artifacts/${csvId}/download`,
          svg: `/api/artifacts/${svgId}/download`,
          png: `/api/artifacts/${pngId}/png`,
          meta: `/api/artifacts/${csvId}/meta`,
        },
      };

      artifactIndex[kind] = {
        csvId,
        svgId,
        pngId,
      };
    }
    return { runViews, artifactIndex };
  }

  app.get('/api/upload/:id', async (req, res) => {
    const uploadId = Number(req.params.id);
    if (!Number.isInteger(uploadId) || uploadId <= 0) {
      return res.status(400).json({ error: 'upload id must be a positive integer' });
    }

    try {
      await ensureUploadSchema();
      const result = await pool.query(
        `SELECT
          id,
          session_id,
          filename,
          source_tool,
          entity_type,
          row_count,
          sample_count,
          entity_count,
          available_columns,
          warnings,
          source_columns,
          sample_columns,
          mapped_rows,
          mapped_rows_storage,
          mapped_rows_key,
          created_at
        FROM uploads
        WHERE id = $1`,
        [uploadId]
      );

      if (!result.rows[0]) {
        return res.status(404).json({ error: `upload not found: ${uploadId}` });
      }

      const row = result.rows[0];
      const resolved = await resolveMappedRows(row);
      const warnings = Array.isArray(row.warnings) ? [...row.warnings] : [];
      if (resolved.loadWarning) {
        warnings.push(resolved.loadWarning);
      }
      return res.json({
        uploadId: Number(row.id),
        sessionId: row.session_id,
        fileName: row.filename,
        detected: {
          sourceTool: row.source_tool,
          entityType: row.entity_type,
        },
        summary: {
          rowCount: Number(row.row_count),
          sampleCount: Number(row.sample_count),
          entityCount: Number(row.entity_count),
          availableColumns: row.available_columns || [],
          sourceColumns: row.source_columns || [],
          sampleColumns: row.sample_columns || [],
          warnings,
        },
        preview: resolved.mappedRows.slice(0, 3),
        mappedRowCount: resolved.mappedRows.length,
        storage: {
          mode: row.mapped_rows_storage || 'db',
          key: row.mapped_rows_key || null,
        },
        createdAt: row.created_at,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/upload/:id/mapped-rows', async (req, res) => {
    const uploadId = Number(req.params.id);
    if (!Number.isInteger(uploadId) || uploadId <= 0) {
      return res.status(400).json({ error: 'upload id must be a positive integer' });
    }

    const limitRaw = req.query.limit === undefined ? '200' : String(req.query.limit);
    const offsetRaw = req.query.offset === undefined ? '0' : String(req.query.offset);
    const limit = Number(limitRaw);
    const offset = Number(offsetRaw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 5000) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 5000' });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    try {
      await ensureUploadSchema();
      const result = await pool.query(
        `SELECT
          id,
          session_id,
          mapped_rows,
          mapped_rows_storage,
          mapped_rows_key,
          warnings
        FROM uploads
        WHERE id = $1`,
        [uploadId]
      );

      if (!result.rows[0]) {
        return res.status(404).json({ error: `upload not found: ${uploadId}` });
      }

      const row = result.rows[0];
      const resolved = await resolveMappedRows(row);
      const mappedRows = resolved.mappedRows;
      const page = mappedRows.slice(offset, offset + limit);
      const warnings = Array.isArray(row.warnings) ? [...row.warnings] : [];
      if (resolved.loadWarning) {
        warnings.push(resolved.loadWarning);
      }

      return res.json({
        uploadId: Number(row.id),
        sessionId: row.session_id,
        total: mappedRows.length,
        offset,
        limit,
        returned: page.length,
        storage: {
          mode: row.mapped_rows_storage || 'db',
          key: row.mapped_rows_key || null,
        },
        warnings,
        mappedRows: page,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/upload/:id', async (req, res) => {
    const uploadId = Number(req.params.id);
    if (!Number.isInteger(uploadId) || uploadId <= 0) {
      return res.status(400).json({ error: 'upload id must be a positive integer' });
    }

    try {
      await ensureUploadSchema();
      const existing = await pool.query(
        `SELECT
          id,
          session_id,
          filename,
          mapped_rows_storage,
          mapped_rows_key
        FROM uploads
        WHERE id = $1`,
        [uploadId]
      );

      if (!existing.rows[0]) {
        return res.status(404).json({ error: `upload not found: ${uploadId}` });
      }

      const row = existing.rows[0];
      const warnings = [];
      let blobDeleted = false;
      try {
        blobDeleted = await deleteMappedRowsBlob(row);
      } catch (blobError) {
        warnings.push(`failed to delete mapped rows blob: ${blobError.message}`);
      }

      await pool.query('DELETE FROM uploads WHERE id = $1', [uploadId]);

      return res.json({
        ok: true,
        uploadId: Number(row.id),
        sessionId: row.session_id,
        fileName: row.filename,
        blobDeleted,
        warnings,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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

    const payload = req.body || {};

    try {
      const resolution = await resolveRunConfigResolution(configRepository, payload);
      if (resolution.error) {
        return res.status(resolution.error.status).json(resolution.error.body);
      }

      const job = jobManager.createJob(moduleName, payload, {
        configTrace: resolution.configTrace,
        executionContext: {
          config: resolution.config,
          configTrace: resolution.configTrace,
        },
      });

      return res.status(202).json({
        ok: true,
        jobId: job.id,
        module: job.module,
        status: job.status,
        createdAt: job.createdAt,
        statusUrl: `/api/job/${job.id}`,
        config_trace: resolution.configTrace,
      });
    } catch (error) {
      return res.status(500).json({ error: 'failed to resolve run context', details: error.message });
    }
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
      config_trace: job.configTrace,
      request: job.request,
      result: job.result,
      error: job.error,
      logs: job.logs,
    });
  });

  app.post('/api/analysis/run', async (req, res) => {
    const payload = req.body || {};
    const sessionId = pickSessionId(payload);
    const uploadId = pickUploadId(payload);
    const configTag = pickConfigTag(payload);
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId (or session_id) is required' });
    }
    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId (or upload_id) must be a positive integer' });
    }

    try {
      await ensureUploadSchema();
      const uploadResult = await pool.query(
        `SELECT
          id,
          session_id,
          sample_columns,
          mapped_rows,
          mapped_rows_storage,
          mapped_rows_key
        FROM uploads
        WHERE id = $1`,
        [uploadId]
      );
      const uploadRow = uploadResult.rows[0];
      if (!uploadRow) {
        return res.status(404).json({ error: `upload not found: ${uploadId}` });
      }
      if (uploadRow.session_id !== sessionId) {
        return res.status(409).json({
          error: `upload ${uploadId} does not belong to session ${sessionId}`,
        });
      }

      const resolution = await resolveRunConfigResolution(configRepository, payload);
      if (resolution.error) {
        return res.status(resolution.error.status).json(resolution.error.body);
      }

      const mapped = await resolveMappedRows(uploadRow);
      const analysisPayload = uploadToAnalysisPayload({
        mappedRows: mapped.mappedRows,
        sampleColumns: Array.isArray(uploadRow.sample_columns) ? uploadRow.sample_columns : [],
        sampleGroups: payload.sampleGroups || payload.sample_groups || {},
        de: payload.de || {},
        enrichment: payload.enrichment || {},
        engine: payload.engine,
      });

      const requestHash = computeRequestHash({
        sessionId,
        uploadId,
        engine: analysisPayload.engine,
        de: analysisPayload.de,
        enrichment: analysisPayload.enrichment,
        sampleGroups: analysisPayload.resolvedSampleGroups,
        config_rev: resolution.configTrace?.config_rev ?? null,
        config_hash: resolution.configTrace?.config_hash || pickConfigHash(payload) || null,
        config_tag: configTag || null,
      });

      const runRow = await analysisRunsRepository.createQueuedRun({
        sessionId,
        uploadId,
        configRev: resolution.configTrace?.config_rev ?? null,
        configTag: configTag || null,
        configHash: resolution.configTrace?.config_hash || pickConfigHash(payload) || null,
        status: 'queued',
        engine: analysisPayload.engine,
        de: analysisPayload.de,
        enrichment: analysisPayload.enrichment,
        sampleGroups: analysisPayload.resolvedSampleGroups,
        requestHash,
        configTrace: resolution.configTrace,
      });

      runPayloadCache.set(String(runRow.id), analysisPayload);

      const job = jobManager.createJob('de-enrich', analysisPayload, {
        configTrace: resolution.configTrace,
        executionContext: {
          config: resolution.config,
          configTrace: resolution.configTrace,
        },
      });

      const bound = await analysisRunsRepository.setJobBinding(runRow.id, {
        jobId: job.id,
        status: 'running',
        startedAt: job.startedAt || new Date().toISOString(),
      });

      return res.status(202).json({
        runId: Number(bound.id),
        status: bound.status,
        statusUrl: `/api/analysis/run/${bound.id}`,
        createdAt: bound.created_at,
        binding: buildAnalysisRunBinding(bound),
      });
    } catch (error) {
      if (error instanceof AnalysisPayloadValidationError) {
        return res.status(400).json({
          error: error.message,
          details: error.details,
        });
      }
      return res.status(500).json({ error: 'failed to create analysis run', details: error.message });
    }
  });

  app.get('/api/analysis/run/:runId', async (req, res) => {
    const runId = Number(req.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      return res.status(400).json({ error: 'runId must be a positive integer' });
    }

    try {
      await ensureUploadSchema();
      let run = await analysisRunsRepository.getById(runId);
      if (!run) {
        return res.status(404).json({ error: `analysis run not found: ${runId}` });
      }

      if (!isTerminalRunStatus(run.status) && run.job_id) {
        const job = jobManager.getJob(run.job_id);
        if (job) {
          run = await analysisRunsRepository.syncStatus(run.id, {
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            runtime: job.result?.runtime || null,
            error: job.error || null,
          });

          if (job.status === 'failed') {
            run = await analysisRunsRepository.finalizeFailed(run.id, {
              runtime: job.result?.runtime || null,
              error: job.error || { code: 'ANALYSIS_FAILED', message: 'analysis job failed' },
              finishedAt: job.finishedAt || null,
            });
          } else if (job.status === 'succeeded' && !run.result_json) {
            const executionPayload = runPayloadCache.get(String(run.id)) || job.request || {};
            const built = buildAnalysisRunViews({
              runId: Number(run.id),
              configRev: run.config_rev,
              configTag: run.config_tag,
              result: job.result || {},
              executionPayload,
            });
            const fileLabel = run.config_tag || (run.config_rev !== null ? `rev-${run.config_rev}` : `run-${run.id}`);
            const configRevForArtifacts = run.config_rev !== null ? String(run.config_rev) : fileLabel;
            const { runViews, artifactIndex } = registerViewArtifacts({
              views: built.views,
              generatedAt: built.generatedAt,
              artifactMeta: built.artifactMeta,
              fileLabel,
              configRevForArtifacts,
              scopeKey: `run-${run.id}`,
            });

            const resultPayload = {
              module: job.result?.module || 'de-enrich',
              engine: run.engine,
              de: job.result?.de || null,
              significantGenes: job.result?.significantGenes || [],
              enrichment: job.result?.enrichment || null,
              config_trace: job.result?.config_trace || run.config_trace_json || null,
              generated_at: built.generatedAt,
              views: runViews,
            };

            run = await analysisRunsRepository.finalizeSucceeded(run.id, {
              runtime: job.result?.runtime || null,
              result: resultPayload,
              views: built.views,
              artifactIndex: {
                generated_at: built.generatedAt,
                items: artifactIndex,
              },
              finishedAt: job.finishedAt || null,
            });
            runPayloadCache.delete(String(run.id));
          }
        }
      }

      return res.json(toAnalysisRunResponse(run));
    } catch (error) {
      return res.status(500).json({ error: 'failed to load analysis run', details: error.message });
    }
  });

  app.post('/api/config', async (req, res) => {
    const payload = req.body || {};
    const sessionId = pickSessionId(payload);
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id (or sessionId) is required' });
    }

    const validation = validateAndNormalizeConfig(payload.config);
    if (!validation.ok) {
      return res.status(400).json({ error: 'invalid config', details: validation.errors });
    }

    const normalizedConfig = validation.config;
    const configHash = computeConfigHash(normalizedConfig);

    try {
      const saved = await configRepository.saveConfig(sessionId, normalizedConfig, configHash);
      const token = reproducibilityToken(saved.config_hash, normalizedConfig.seed);
      const status = saved.reused ? 200 : 201;
      return res.status(status).json({
        session_id: saved.session_id,
        config_rev: saved.config_rev,
        config_hash: saved.config_hash,
        config: saved.config,
        reproducibility_token: token,
        created_at: saved.created_at,
        reused: Boolean(saved.reused),
      });
    } catch (error) {
      return res.status(500).json({ error: 'failed to save config', details: error.message });
    }
  });

  app.get('/api/config/:session_id', async (req, res) => {
    const sessionId = typeof req.params.session_id === 'string' ? req.params.session_id.trim() : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    try {
      const latest = await configRepository.getLatestConfig(sessionId);
      if (!latest) {
        return res.status(404).json({ error: 'config not found' });
      }
      return res.json({
        session_id: latest.session_id,
        config_rev: latest.config_rev,
        config_hash: latest.config_hash,
        config: latest.config,
        reproducibility_token: reproducibilityToken(latest.config_hash, latest.config.seed),
        created_at: latest.created_at,
      });
    } catch (error) {
      return res.status(500).json({ error: 'failed to load config', details: error.message });
    }
  });

  app.get('/api/config/:session_id/revisions', async (req, res) => {
    const sessionId = typeof req.params.session_id === 'string' ? req.params.session_id.trim() : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    try {
      const revisions = await configRepository.listRevisions(sessionId);
      return res.json({
        session_id: sessionId,
        total: revisions.length,
        revisions: revisions.map((rev) => ({
          session_id: rev.session_id,
          config_rev: rev.config_rev,
          config_hash: rev.config_hash,
          created_at: rev.created_at,
        })),
      });
    } catch (error) {
      return res.status(500).json({ error: 'failed to list config revisions', details: error.message });
    }
  });

  app.get('/api/config/:session_id/diff', async (req, res) => {
    const sessionId = typeof req.params.session_id === 'string' ? req.params.session_id.trim() : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const fromRev = parsePositiveInt(req.query.from_rev);
    const toRev = parsePositiveInt(req.query.to_rev);
    if (fromRev === null || toRev === null) {
      return res.status(400).json({ error: 'from_rev and to_rev must be positive integers' });
    }

    try {
      const fromConfig = await configRepository.getConfigByRevision(sessionId, fromRev);
      if (!fromConfig) {
        return res.status(404).json({ error: `from_rev not found: ${fromRev}` });
      }

      const toConfig = await configRepository.getConfigByRevision(sessionId, toRev);
      if (!toConfig) {
        return res.status(404).json({ error: `to_rev not found: ${toRev}` });
      }

      const diff = diffConfigs(fromConfig.config, toConfig.config);
      return res.json({
        session_id: sessionId,
        from: {
          config_rev: fromConfig.config_rev,
          config_hash: fromConfig.config_hash,
          created_at: fromConfig.created_at,
        },
        to: {
          config_rev: toConfig.config_rev,
          config_hash: toConfig.config_hash,
          created_at: toConfig.created_at,
        },
        same: diff.same,
        change_count: diff.changes.length,
        changes: diff.changes,
      });
    } catch (error) {
      return res.status(500).json({ error: 'failed to diff configs', details: error.message });
    }
  });

  app.get('/api/analysis', (req, res) => {
    const configRev = String(req.query.config_rev || 'rev-0001');
    const bundle = createAnalysisBundle(configRev);

    const views = {};
    for (const [kind, payload] of Object.entries(bundle.views)) {
      const artifacts = buildArtifacts(kind, configRev, payload);
      const csvId = buildArtifactId(configRev, kind, 'csv', bundle.generated_at);
      const svgId = buildArtifactId(configRev, kind, 'svg', bundle.generated_at);
      const pngId = buildArtifactId(configRev, kind, 'png-source', bundle.generated_at);

      artifactStore.set(csvId, {
        id: csvId,
        kind,
        format: 'csv',
        fileName: `${kind}-${configRev}.csv`,
        configRev,
        generatedAt: bundle.generated_at,
        contentType: 'text/csv; charset=utf-8',
        body: artifacts.csv,
      });

      artifactStore.set(svgId, {
        id: svgId,
        kind,
        format: 'svg',
        fileName: `${kind}-${configRev}.svg`,
        configRev,
        generatedAt: bundle.generated_at,
        contentType: 'image/svg+xml; charset=utf-8',
        body: artifacts.svg,
      });

      artifactStore.set(pngId, {
        id: pngId,
        kind,
        format: 'png-source',
        fileName: `${kind}-${configRev}.png`,
        configRev,
        generatedAt: bundle.generated_at,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          svg: artifacts.png_source_svg,
          metadata: {
            config_rev: configRev,
            kind,
            generated_at: bundle.generated_at,
          },
        }),
      });

      views[kind] = {
        data: payload,
        artifact_meta: {
          config_rev: configRev,
          generated_at: bundle.generated_at,
        },
        downloads: {
          csv: `/api/artifacts/${csvId}/download`,
          svg: `/api/artifacts/${svgId}/download`,
          png: `/api/artifacts/${pngId}/png`,
          meta: `/api/artifacts/${csvId}/meta`,
        },
      };
    }

    return res.json({
      config_rev: configRev,
      generated_at: bundle.generated_at,
      views,
    });
  });

  app.get('/api/artifacts/:id/meta', (req, res) => {
    const artifact = artifactStore.get(req.params.id);
    if (!artifact) {
      return res.status(404).json({ error: 'artifact not found' });
    }

    return res.json(toArtifactMeta(artifact));
  });

  app.get('/api/artifacts/:id/download', (req, res) => {
    const artifact = artifactStore.get(req.params.id);
    if (!artifact) {
      return res.status(404).json({ error: 'artifact not found' });
    }

    if (artifact.format === 'png-source') {
      return res.status(400).json({ error: 'Use /png endpoint to fetch PNG source payload' });
    }

    const meta = toArtifactMeta(artifact);
    res.setHeader('X-Artifact-Meta', JSON.stringify(meta));
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    return res.send(artifact.body);
  });

  app.get('/api/artifacts/:id/png', (req, res) => {
    const artifact = artifactStore.get(req.params.id);
    if (!artifact) {
      return res.status(404).json({ error: 'artifact not found' });
    }

    if (artifact.format !== 'png-source') {
      return res.status(400).json({ error: 'This artifact is not a PNG source payload' });
    }

    return res.json({
      ...JSON.parse(artifact.body),
      artifact: toArtifactMeta(artifact),
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

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

function startServer(port = Number(process.env.PORT || 4000)) {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`API running at http://localhost:${port}`);
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

function parsePositiveInt(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function pickConfigRev(payload = {}) {
  if (payload.config_rev === undefined && payload.configRev === undefined) {
    return null;
  }
  const raw = payload.config_rev ?? payload.configRev;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    return parsePositiveInt(raw);
  }
  return null;
}

function pickConfigHash(payload = {}) {
  const raw = payload.config_hash ?? payload.configHash;
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim();
}

async function resolveRunConfigResolution(configRepository, payload) {
  const sessionId = pickSessionId(payload);
  const requestedRevRaw = payload.config_rev ?? payload.configRev;
  const requestedHashRaw = payload.config_hash ?? payload.configHash;
  const requestedHash = pickConfigHash(payload);
  const hasRequestedHash = requestedHash !== '';
  const hasRequestedRev = requestedRevRaw !== undefined && requestedRevRaw !== null && String(requestedRevRaw).trim() !== '';
  const requestedRev = pickConfigRev(payload);

  if ((hasRequestedRev || hasRequestedHash) && !sessionId) {
    return {
      error: {
        status: 400,
        body: { error: 'session_id (or sessionId) is required when binding config_rev/config_hash' },
      },
    };
  }

  if (hasRequestedRev && requestedRev === null) {
    return {
      error: {
        status: 400,
        body: { error: 'config_rev (or configRev) must be a positive integer' },
      },
    };
  }

  if (!sessionId) {
    return { config: null, configTrace: null };
  }

  if (requestedRev !== null) {
    const byRev = await configRepository.getConfigByRevision(sessionId, requestedRev);
    if (!byRev) {
      return { error: { status: 404, body: { error: `config_rev not found: ${requestedRev}` } } };
    }

    if (hasRequestedHash && byRev.config_hash !== requestedHash) {
      return {
        error: {
          status: 409,
          body: { error: `config_hash mismatch for config_rev=${requestedRev}` },
        },
      };
    }

    return {
      config: byRev.config,
      configTrace: toConfigTrace(byRev, 'explicit-config_rev'),
    };
  }

  if (hasRequestedHash) {
    const byHash = await configRepository.getConfigByHash(sessionId, requestedHash);
    if (!byHash) {
      return { error: { status: 404, body: { error: `config_hash not found: ${requestedHash}` } } };
    }
    return {
      config: byHash.config,
      configTrace: toConfigTrace(byHash, 'explicit-config_hash'),
    };
  }

  const latest = await configRepository.getLatestConfig(sessionId);
  if (!latest) {
    return { config: null, configTrace: null };
  }
  return {
    config: latest.config,
    configTrace: toConfigTrace(latest, 'latest-for-session'),
  };
}

function toConfigTrace(record, source) {
  return {
    session_id: record.session_id,
    config_rev: record.config_rev,
    config_hash: record.config_hash,
    created_at: record.created_at,
    source,
    reproducibility_token: reproducibilityToken(record.config_hash, record.config.seed),
  };
}
