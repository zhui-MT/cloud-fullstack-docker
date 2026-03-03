const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { InMemoryConfigRepository } = require('../src/configRepository');

function makeBaseConfig(imputationAlgorithm, imputationParams = {}, seed = 20260221) {
  return {
    seed,
    filtering: {
      algorithm: 'rule-based',
      params: {
        contaminant_filter: true,
        reverse_decoy_filter: true,
        low_coverage_filter: true,
      },
    },
    imputation: {
      algorithm: imputationAlgorithm,
      params: imputationParams,
    },
    normalization: {
      algorithm: 'no-normalization',
      params: {},
    },
    batch_correction: {
      algorithm: 'none',
      params: {},
    },
  };
}

function makePayloadWithMissingValue() {
  return {
    engine: 'limma',
    de: {
      groupA: 'A',
      groupB: 'B',
      log2fcThreshold: 0.1,
      padjThreshold: 0.5,
    },
    samples: [
      { sample: 'A1', group: 'A' },
      { sample: 'A2', group: 'A' },
      { sample: 'A3', group: 'A' },
      { sample: 'B1', group: 'B' },
      { sample: 'B2', group: 'B' },
      { sample: 'B3', group: 'B' },
    ],
    matrix: [
      { gene: 'G1', values: [10, null, 10.5, 12, 12.2, 11.9] },
      { gene: 'G2', values: [8, 8.2, 8.1, 9.2, 9.1, 9.3] },
      { gene: 'G3', values: [7, 7.1, 7.05, 7.3, 7.2, 7.35] },
    ],
  };
}

function makePayloadForImputationContrast() {
  return {
    engine: 'limma',
    de: {
      groupA: 'A',
      groupB: 'B',
      log2fcThreshold: 0.1,
      padjThreshold: 0.5,
    },
    samples: [
      { sample: 'A1', group: 'A' },
      { sample: 'A2', group: 'A' },
      { sample: 'A3', group: 'A' },
      { sample: 'B1', group: 'B' },
      { sample: 'B2', group: 'B' },
      { sample: 'B3', group: 'B' },
    ],
    matrix: [
      { gene: 'G1', values: [10, null, 10, 20, 20, 20] },
      { gene: 'G2', values: [11, 11, 11, 21, 21, 21] },
      { gene: 'G3', values: [9, 9, 9, 19, 19, 19] },
      { gene: 'G4', values: [30, 30, 30, 40, 40, 40] },
    ],
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

test('executionContext.config affects preprocessing and job outcome by revision', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-preprocess-by-revision';

    const rev1Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeBaseConfig('none'),
      }),
    });
    assert.equal(rev1Res.status, 201);

    const rev2Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeBaseConfig('min-half'),
      }),
    });
    assert.equal(rev2Res.status, 201);

    const payload = makePayloadWithMissingValue();

    const runRev1 = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 1,
      }),
    });
    assert.equal(runRev1.status, 202);
    const runRev1Body = await runRev1.json();
    const jobRev1 = await waitForJob(base, runRev1Body.jobId);
    assert.equal(jobRev1.status, 'failed');
    assert.equal(jobRev1.error.code, 'INVALID_NUMERIC_MATRIX');

    const runRev2 = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 2,
      }),
    });
    assert.equal(runRev2.status, 202);
    const runRev2Body = await runRev2.json();
    const jobRev2 = await waitForJob(base, runRev2Body.jobId);
    assert.equal(jobRev2.status, 'succeeded');
    assert.ok(Array.isArray(jobRev2.result.significantGenes));
    assert.equal(jobRev2.config_trace.config_rev, 2);
  });
});

test('different imputation algorithms (KNN vs SVD) lead to different DE outputs', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-imputation-contrast';

    const rev1Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeBaseConfig('KNN', { k: 1 }),
      }),
    });
    assert.equal(rev1Res.status, 201);

    const rev2Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: makeBaseConfig('SVD', { rank: 3 }),
      }),
    });
    assert.equal(rev2Res.status, 201);

    const payload = makePayloadForImputationContrast();

    const runRev1 = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 1,
      }),
    });
    assert.equal(runRev1.status, 202);
    const runRev1Body = await runRev1.json();
    const jobRev1 = await waitForJob(base, runRev1Body.jobId);
    assert.equal(jobRev1.status, 'succeeded');

    const runRev2 = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 2,
      }),
    });
    assert.equal(runRev2.status, 202);
    const runRev2Body = await runRev2.json();
    const jobRev2 = await waitForJob(base, runRev2Body.jobId);
    assert.equal(jobRev2.status, 'succeeded');

    const g1Rev1 = jobRev1.result.de.topTable.find((row) => row.gene === 'G1');
    const g1Rev2 = jobRev2.result.de.topTable.find((row) => row.gene === 'G1');
    assert.ok(g1Rev1);
    assert.ok(g1Rev2);
    assert.notEqual(g1Rev1.logFC, g1Rev2.logFC);
  });
});

test('left-shift-gaussian imputation is deterministic for same seed and changes with different seed', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-imputation-seed-determinism';
    const configA = makeBaseConfig(
      'left-shift-gaussian',
      {
        downshift: 1.8,
        width: 0.3,
      },
      20260221
    );
    const configB = makeBaseConfig(
      'left-shift-gaussian',
      {
        downshift: 1.8,
        width: 0.3,
      },
      20260222
    );

    const rev1Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: configA,
      }),
    });
    assert.equal(rev1Res.status, 201);
    const rev1Body = await rev1Res.json();
    assert.equal(rev1Body.config_rev, 1);

    const rev2Res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        config: configB,
      }),
    });
    assert.equal(rev2Res.status, 201);
    const rev2Body = await rev2Res.json();
    assert.equal(rev2Body.config_rev, 2);

    const payload = makePayloadWithMissingValue();
    const runRev1A = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 1,
      }),
    });
    assert.equal(runRev1A.status, 202);
    const runRev1ABody = await runRev1A.json();
    const jobRev1A = await waitForJob(base, runRev1ABody.jobId);
    assert.equal(jobRev1A.status, 'succeeded');

    const runRev1B = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 1,
      }),
    });
    assert.equal(runRev1B.status, 202);
    const runRev1BBody = await runRev1B.json();
    const jobRev1B = await waitForJob(base, runRev1BBody.jobId);
    assert.equal(jobRev1B.status, 'succeeded');

    const runRev2 = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        session_id: sessionId,
        config_rev: 2,
      }),
    });
    assert.equal(runRev2.status, 202);
    const runRev2Body = await runRev2.json();
    const jobRev2 = await waitForJob(base, runRev2Body.jobId);
    assert.equal(jobRev2.status, 'succeeded');

    const g1Rev1A = jobRev1A.result.de.topTable.find((row) => row.gene === 'G1');
    const g1Rev1B = jobRev1B.result.de.topTable.find((row) => row.gene === 'G1');
    const g1Rev2 = jobRev2.result.de.topTable.find((row) => row.gene === 'G1');
    assert.ok(g1Rev1A);
    assert.ok(g1Rev1B);
    assert.ok(g1Rev2);

    assert.equal(g1Rev1A.logFC, g1Rev1B.logFC);
    assert.notEqual(g1Rev1A.logFC, g1Rev2.logFC);
  });
});
