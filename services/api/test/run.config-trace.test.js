const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { InMemoryConfigRepository } = require('../src/configRepository');

function makeValidConfig(overrides = {}) {
  return {
    seed: 20260221,
    filtering: {
      algorithm: 'rule-based',
      params: {
        contaminant_filter: true,
        reverse_decoy_filter: true,
        low_coverage_filter: true,
        min_coverage: 0.5,
      },
    },
    imputation: {
      algorithm: 'KNN',
      params: { k: 5 },
    },
    normalization: {
      algorithm: 'median',
      params: {},
    },
    batch_correction: {
      algorithm: 'none',
      params: {},
    },
    ...overrides,
  };
}

async function withServer(fn) {
  const configRepository = new InMemoryConfigRepository();
  const app = createApp({
    pool: {
      query: async () => ({ rows: [] }),
    },
    configRepository,
  });
  const server = app.listen(0);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitForJob(base, jobId) {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`${base}/api/job/${jobId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job timeout: ${jobId}`);
}

test('POST /api/run/:module binds latest config trace from session', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-run-latest';
    const rev1 = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeValidConfig(),
      }),
    });
    assert.equal(rev1.status, 201);

    const rev2 = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeValidConfig({
          normalization: { algorithm: 'quantile', params: {} },
        }),
      }),
    });
    assert.equal(rev2.status, 201);
    const rev2Body = await rev2.json();
    assert.equal(rev2Body.config_rev, 2);

    const runRes = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        engine: 'limma',
      }),
    });
    assert.equal(runRes.status, 202);
    const runBody = await runRes.json();
    assert.equal(runBody.config_trace.config_rev, 2);
    assert.equal(runBody.config_trace.config_hash, rev2Body.config_hash);

    const job = await waitForJob(base, runBody.jobId);
    assert.equal(job.config_trace.config_rev, 2);
    assert.equal(job.config_trace.config_hash, rev2Body.config_hash);
    assert.equal(job.result.config_trace.config_rev, 2);
    assert.equal(job.result.config_trace.config_hash, rev2Body.config_hash);
  });
});

test('POST /api/run/:module supports explicit config_rev/config_hash binding and rejects mismatch', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-run-explicit';

    const rev1Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeValidConfig(),
      }),
    });
    assert.equal(rev1Res.status, 201);
    const rev1 = await rev1Res.json();

    const rev2Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeValidConfig({
          imputation: { algorithm: 'SVD', params: { rank: 3 } },
        }),
      }),
    });
    assert.equal(rev2Res.status, 201);
    const rev2 = await rev2Res.json();
    assert.equal(rev2.config_rev, 2);

    const runByRev = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config_rev: 1,
        config_hash: rev1.config_hash,
        engine: 'limma',
      }),
    });
    assert.equal(runByRev.status, 202);
    const runByRevBody = await runByRev.json();
    assert.equal(runByRevBody.config_trace.config_rev, 1);
    assert.equal(runByRevBody.config_trace.config_hash, rev1.config_hash);

    const runByHash = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config_hash: rev2.config_hash,
        engine: 'limma',
      }),
    });
    assert.equal(runByHash.status, 202);
    const runByHashBody = await runByHash.json();
    assert.equal(runByHashBody.config_trace.config_rev, 2);
    assert.equal(runByHashBody.config_trace.config_hash, rev2.config_hash);

    const mismatch = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config_rev: 1,
        config_hash: rev2.config_hash,
        engine: 'limma',
      }),
    });
    assert.equal(mismatch.status, 409);
    const mismatchBody = await mismatch.json();
    assert.equal(mismatchBody.error, 'config_hash mismatch for config_rev=1');
  });
});
