const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

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
  const app = createApp({
    pool: {
      query: async () => ({ rows: [] }),
    },
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

test('POST /api/config blocks illegal params', async () => {
  await withServer(async (base) => {
    const invalid = makeValidConfig({
      imputation: {
        algorithm: 'KNN',
        params: { k: 0 },
      },
    });

    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'sess-invalid',
        config: invalid,
      }),
    });

    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.error, 'invalid config');
    assert.ok(Array.isArray(json.details));
    assert.ok(json.details.some((msg) => msg.includes('imputation.params invalid')));
  });
});

test('same config with fixed seed is reproducible', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-repro-fixed-seed';
    const configA = makeValidConfig();
    const configB = {
      batch_correction: { params: {}, algorithm: 'none' },
      filtering: configA.filtering,
      normalization: { algorithm: 'median', params: {} },
      imputation: { params: { k: 5 }, algorithm: 'KNN' },
      seed: 20260221,
    };

    const first = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, config: configA }),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.config_rev, 1);

    const second = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, config: configB }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.reused, true);
    assert.equal(secondBody.config_rev, 1);
    assert.equal(secondBody.config_hash, firstBody.config_hash);
    assert.equal(secondBody.reproducibility_token, firstBody.reproducibility_token);

    const latest = await fetch(`${base}/api/config/${sessionId}`);
    assert.equal(latest.status, 200);
    const latestBody = await latest.json();
    assert.equal(latestBody.config_rev, 1);
    assert.equal(latestBody.config_hash, firstBody.config_hash);
    assert.equal(latestBody.reproducibility_token, firstBody.reproducibility_token);
  });
});

test('POST /api/config accepts camelCase sessionId field', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-camel-case',
        config: makeValidConfig(),
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.session_id, 'sess-camel-case');
    assert.equal(body.config_rev, 1);
  });
});

test('GET /api/config/:session_id/revisions and /diff return revision history and changes', async () => {
  await withServer(async (base) => {
    const sessionId = 'sess-revisions';
    const rev1Config = makeValidConfig();
    const rev2Config = makeValidConfig({
      normalization: {
        algorithm: 'quantile',
        params: {},
      },
    });

    const first = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, config: rev1Config }),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.config_rev, 1);

    const second = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, config: rev2Config }),
    });
    assert.equal(second.status, 201);
    const secondBody = await second.json();
    assert.equal(secondBody.config_rev, 2);
    assert.notEqual(secondBody.config_hash, firstBody.config_hash);

    const revisions = await fetch(`${base}/api/config/${sessionId}/revisions`);
    assert.equal(revisions.status, 200);
    const revisionsBody = await revisions.json();
    assert.equal(revisionsBody.total, 2);
    assert.deepEqual(
      revisionsBody.revisions.map((row) => row.config_rev),
      [1, 2]
    );

    const diff = await fetch(`${base}/api/config/${sessionId}/diff?from_rev=1&to_rev=2`);
    assert.equal(diff.status, 200);
    const diffBody = await diff.json();
    assert.equal(diffBody.same, false);
    assert.ok(diffBody.change_count >= 1);
    assert.ok(
      diffBody.changes.some(
        (change) => change.path === 'normalization.algorithm' && change.from === 'median' && change.to === 'quantile'
      )
    );
  });
});
