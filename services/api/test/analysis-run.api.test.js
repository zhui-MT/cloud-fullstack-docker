const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { createApp } = require('../server');
const { InMemoryUploadBlobStore } = require('../src/upload-blob-store');

async function withServer(fn) {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const uploadBlobStore = new InMemoryUploadBlobStore();
  const app = createApp({ pool, uploadBlobStore });
  const server = app.listen(0);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

async function createSession(base, name) {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return body.sessionId;
}

async function uploadFragpipe(base, sessionId) {
  const samplePath = path.join(__dirname, '..', 'samples', 'fragpipe-protein.tsv');
  const content = fs.readFileSync(samplePath);
  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('file', new Blob([content]), 'fragpipe-protein.tsv');
  const response = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 201);
  return response.json();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunTerminal(base, runId, maxAttempts = 80) {
  let latest = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${base}/api/analysis/run/${runId}`);
    assert.equal(response.status, 200);
    latest = await response.json();
    if (latest.status === 'succeeded' || latest.status === 'failed') {
      return latest;
    }
    await wait(25);
  }
  throw new Error(`run ${runId} did not reach terminal state in time`);
}

function defaultRunRequest(sessionId, uploadId, overrides = {}) {
  return {
    sessionId,
    uploadId,
    engine: 'limma',
    de: {
      groupA: 'Control',
      groupB: 'Treatment',
      log2fcThreshold: 0.58,
      padjThreshold: 0.05,
    },
    enrichment: {
      species: 'human',
      pvalueCutoff: 0.05,
      qvalueCutoff: 0.2,
    },
    sampleGroups: {
      'Intensity S1': 'Control',
      'Intensity S2': 'Treatment',
    },
    config_tag: 'rev-0005',
    ...overrides,
  };
}

test('POST /api/analysis/run -> GET /api/analysis/run/:id reaches terminal and exposes artifacts', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'analysis-run-success');
    const upload = await uploadFragpipe(base, sessionId);

    const runCreate = await fetch(`${base}/api/analysis/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultRunRequest(sessionId, upload.uploadId)),
    });
    assert.equal(runCreate.status, 202);
    const runCreateBody = await runCreate.json();
    assert.ok(runCreateBody.runId);
    assert.equal(runCreateBody.binding.sessionId, sessionId);
    assert.equal(runCreateBody.binding.uploadId, upload.uploadId);

    const terminal = await waitForRunTerminal(base, runCreateBody.runId);
    assert.equal(terminal.status, 'succeeded');
    assert.ok(terminal.result);
    assert.ok(terminal.result.views);
    assert.ok(terminal.result.views.pca.downloads.csv);
    assert.ok(terminal.result.views.correlation.downloads.svg);
    assert.ok(terminal.result.views.volcano.downloads.png);
    assert.ok(terminal.result.views.enrichment.downloads.meta);

    const csvResponse = await fetch(`${base}${terminal.result.views.pca.downloads.csv}`);
    assert.equal(csvResponse.status, 200);
    const csvText = await csvResponse.text();
    assert.ok(csvText.includes('sample_id'));

    const metaResponse = await fetch(`${base}${terminal.result.views.pca.downloads.meta}`);
    assert.equal(metaResponse.status, 200);
    const metaJson = await metaResponse.json();
    assert.equal(metaJson.metadata.run_id, runCreateBody.runId);
  });
});

test('POST /api/analysis/run returns 404 when upload does not exist', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'analysis-run-upload-missing');
    const response = await fetch(`${base}/api/analysis/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultRunRequest(sessionId, 999999)),
    });
    assert.equal(response.status, 404);
  });
});

test('POST /api/analysis/run returns 409 when upload/session mismatch', async () => {
  await withServer(async (base) => {
    const sessionA = await createSession(base, 'analysis-run-session-a');
    const sessionB = await createSession(base, 'analysis-run-session-b');
    const upload = await uploadFragpipe(base, sessionA);
    const response = await fetch(`${base}/api/analysis/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultRunRequest(sessionB, upload.uploadId)),
    });
    assert.equal(response.status, 409);
  });
});

test('POST /api/analysis/run returns 400 when sample groups are invalid', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'analysis-run-invalid-groups');
    const upload = await uploadFragpipe(base, sessionId);

    const response = await fetch(`${base}/api/analysis/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        defaultRunRequest(sessionId, upload.uploadId, {
          sampleGroups: {},
        })
      ),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(Array.isArray(body.details));
    assert.ok(body.details.some((item) => item.includes('both DE groups')));
  });
});

test('POST /api/analysis/run supports failed terminal status path', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'analysis-run-failed');
    const upload = await uploadFragpipe(base, sessionId);

    const runCreate = await fetch(`${base}/api/analysis/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        defaultRunRequest(sessionId, upload.uploadId, {
          engine: 'DEqMS',
        })
      ),
    });
    assert.equal(runCreate.status, 202);
    const created = await runCreate.json();

    const terminal = await waitForRunTerminal(base, created.runId);
    assert.equal(terminal.status, 'failed');
    assert.ok(terminal.error);
  });
});

test('GET /api/analysis demo compatibility remains available', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/analysis?config_rev=demo-compat`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.views);
    assert.ok(body.views.pca);
    assert.ok(body.views.pca.downloads.csv);
  });
});
