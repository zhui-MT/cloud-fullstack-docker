const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runRDeEnrich } = require('../src/r-runner');

async function withMockREngine(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('runRDeEnrich uses remote r-engine when R_ENGINE_URL is set', async () => {
  await withMockREngine(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/run/de-enrich') {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(body);

    assert.equal(parsed.mode, 'de-enrich');
    assert.equal(parsed.payload.engine, 'limma');

    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        meta: { mode: 'de-enrich', service: 'r-engine' },
        result: {
          de: { summary: { totalGenes: 1, significantGenes: 1 }, topTable: [] },
          significantGenes: ['TP53'],
          enrichment: { go: [], kegg: [] },
        },
      })
    );
  }, async (baseUrl) => {
    const prev = process.env.R_ENGINE_URL;
    process.env.R_ENGINE_URL = baseUrl;

    const logs = [];
    const appendLog = (level, message) => logs.push({ level, message });

    try {
      const output = await runRDeEnrich(
        {
          mode: 'de-enrich',
          payload: {
            engine: 'limma',
          },
        },
        appendLog
      );

      assert.deepEqual(output.significantGenes, ['TP53']);
      assert.ok(logs.some((item) => item.message.includes('Trying remote r-engine')));
      assert.ok(logs.some((item) => item.message.includes('Remote r-engine completed')));
    } finally {
      if (prev === undefined) {
        delete process.env.R_ENGINE_URL;
      } else {
        process.env.R_ENGINE_URL = prev;
      }
    }
  });
});
