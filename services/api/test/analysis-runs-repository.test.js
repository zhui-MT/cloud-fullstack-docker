const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { AnalysisRunsRepository } = require('../src/analysis-runs-repository');

async function withRepository(fn) {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();

  await pool.query(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE uploads (
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
  await pool.query(`
    CREATE TABLE analysis_runs (
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

  await pool.query(`INSERT INTO sessions(id, name) VALUES ('sess-1', 'session-1')`);
  await pool.query(`
    INSERT INTO uploads(
      session_id, filename, source_tool, entity_type, row_count, sample_count, entity_count, available_columns, warnings
    ) VALUES (
      'sess-1', 'file.tsv', 'FragPipe', 'protein', 3, 2, 3, '[]'::jsonb, '[]'::jsonb
    )
  `);

  const repository = new AnalysisRunsRepository(pool);
  try {
    await fn(repository);
  } finally {
    await pool.end();
  }
}

test('analysis-runs-repository handles queued->running->succeeded with artifact_index', async () => {
  await withRepository(async (repository) => {
    const queued = await repository.createQueuedRun({
      sessionId: 'sess-1',
      uploadId: 1,
      configRev: 2,
      configTag: 'rev-0002',
      configHash: 'hash-2',
      status: 'queued',
      engine: 'limma',
      de: { groupA: 'Control', groupB: 'Treatment' },
      enrichment: { species: 'human' },
      sampleGroups: { S1: 'Control', S2: 'Treatment' },
      requestHash: 'req-1',
      configTrace: { config_rev: 2, config_hash: 'hash-2' },
    });

    assert.equal(queued.status, 'queued');
    assert.equal(queued.config_rev, 2);

    const running = await repository.setJobBinding(queued.id, {
      jobId: 'job-1',
      status: 'running',
      startedAt: '2026-02-22T10:00:00.000Z',
    });
    assert.equal(running.job_id, 'job-1');
    assert.equal(running.status, 'running');

    const succeeded = await repository.finalizeSucceeded(queued.id, {
      runtime: { backend: 'JS_FALLBACK' },
      result: { module: 'de-enrich' },
      views: { pca: { points: [] } },
      artifactIndex: { generated_at: '2026-02-22T10:01:00.000Z', items: { pca: { csvId: 'art-1' } } },
      finishedAt: '2026-02-22T10:01:00.000Z',
    });

    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.artifact_index.items.pca.csvId, 'art-1');
    assert.equal(succeeded.runtime_json.backend, 'JS_FALLBACK');
  });
});

test('analysis-runs-repository records failed status and error payload', async () => {
  await withRepository(async (repository) => {
    const queued = await repository.createQueuedRun({
      sessionId: 'sess-1',
      uploadId: 1,
      status: 'queued',
      engine: 'DEqMS',
      requestHash: 'req-2',
    });

    await repository.setJobBinding(queued.id, {
      jobId: 'job-2',
      status: 'running',
    });
    const failed = await repository.finalizeFailed(queued.id, {
      runtime: { backend: 'R' },
      error: { code: 'ENGINE_NOT_IMPLEMENTED', message: 'engine not implemented' },
    });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_json.code, 'ENGINE_NOT_IMPLEMENTED');
    assert.equal(failed.runtime_json.backend, 'R');
  });
});
