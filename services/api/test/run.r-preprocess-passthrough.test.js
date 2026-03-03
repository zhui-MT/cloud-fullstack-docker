const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { InMemoryConfigRepository } = require('../src/config-repository');

async function withMockREngine(fn) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/run/de-enrich') {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push(body);

    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        meta: { from: 'mock-r-engine' },
        result: {
          de: { summary: { totalGenes: 3, significantGenes: 1 }, topTable: [] },
          significantGenes: ['G1'],
          enrichment: { go: [], kegg: [] },
        },
      })
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn({ baseUrl, received });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withApiServer(fn) {
  const app = createApp({
    pool: {
      query: async () => ({ rows: [] }),
    },
    configRepository: new InMemoryConfigRepository(),
  });
  const server = app.listen(0);
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
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

test('preprocessing config is passed through to remote r-engine payload', async () => {
  await withMockREngine(async ({ baseUrl, received }) => {
    const prev = process.env.R_ENGINE_URL;
    process.env.R_ENGINE_URL = baseUrl;
    try {
      await withApiServer(async (base) => {
        const sessionId = 'sess-r-pass-through';
        const configRes = await fetch(`${base}/api/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            config: {
              seed: 20260221,
              filtering: { algorithm: 'rule-based', params: { low_variance_filter: false } },
              imputation: { algorithm: 'QRILC', params: { tune_sigma: 1.2 } },
              normalization: { algorithm: 'z-score', params: { by: 'feature' } },
              batch_correction: { algorithm: 'none', params: {} },
            },
          }),
        });
        assert.equal(configRes.status, 201);

        const runRes = await fetch(`${base}/api/run/de-enrich`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            engine: 'limma',
            de: { groupA: 'A', groupB: 'B', log2fcThreshold: 0.1, padjThreshold: 0.5 },
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
          }),
        });
        assert.equal(runRes.status, 202);
        const runBody = await runRes.json();
        const jobBody = await waitForJob(base, runBody.jobId);
        assert.equal(jobBody.status, 'succeeded');
        assert.equal(jobBody.result.runtime.backend, 'R');

        assert.equal(received.length, 1);
        const sent = received[0];
        assert.equal(sent.mode, 'de-enrich');
        assert.equal(sent.payload.preprocessing_config.imputation.algorithm, 'QRILC');
        assert.equal(sent.payload.preprocessing_config.normalization.algorithm, 'z-score');
        assert.equal(sent.payload.preprocessing.imputation.algorithm, 'QRILC');
        assert.ok(sent.payload.preprocessing.imputation.imputed_count >= 1);
        assert.equal(sent.payload.preprocessing.config_seed, 20260221);
      });
    } finally {
      if (prev === undefined) {
        delete process.env.R_ENGINE_URL;
      } else {
        process.env.R_ENGINE_URL = prev;
      }
    }
  });
});
