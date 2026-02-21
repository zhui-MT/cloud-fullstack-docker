#!/usr/bin/env node

const http = require('node:http');

const port = Number.parseInt(process.env.MOCK_R_ENGINE_PORT || process.argv[2] || '8001', 10);
const host = process.env.MOCK_R_ENGINE_HOST || '127.0.0.1';

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function buildResult(mode) {
  if (mode === 'de') {
    return {
      de: {
        summary: {
          totalGenes: 20,
          significantGenes: 3,
          thresholds: { log2fc: 0.58, padj: 0.05 },
        },
        topTable: [
          { gene: 'IL6', logFC: 1.2, pvalue: 0.0001, adjPValue: 0.001 },
          { gene: 'TNF', logFC: 1.1, pvalue: 0.0002, adjPValue: 0.002 },
          { gene: 'STAT3', logFC: 0.9, pvalue: 0.001, adjPValue: 0.01 },
        ],
      },
      significantGenes: ['IL6', 'TNF', 'STAT3'],
    };
  }

  const base = buildResult('de');
  const enrichment = {
    go: [
      {
        db: 'GO',
        id: 'GO:0006954',
        description: 'inflammatory response',
        geneRatio: '3/3',
        bgRatio: '5/20000',
        pvalue: 0.0001,
        qvalue: 0.0002,
        genes: ['IL6', 'TNF', 'STAT3'],
      },
    ],
    kegg: [
      {
        db: 'KEGG',
        id: 'hsa04060',
        description: 'Cytokine-cytokine receptor interaction',
        geneRatio: '2/3',
        bgRatio: '10/20000',
        pvalue: 0.001,
        qvalue: 0.002,
        genes: ['IL6', 'TNF'],
      },
    ],
  };

  if (mode === 'enrichment') {
    return {
      de: base.de,
      significantGenes: base.significantGenes,
      enrichment,
    };
  }

  return {
    de: base.de,
    significantGenes: base.significantGenes,
    enrichment,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, service: 'mock-r-engine' });
  }

  if (req.method === 'POST' && req.url === '/run/de-enrich') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');

    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return json(res, 400, { ok: false, error: `invalid json: ${error.message}` });
    }

    return json(res, 200, {
      ok: true,
      meta: {
        service: 'mock-r-engine',
        mode: parsed.mode || null,
        timestamp: new Date().toISOString(),
      },
      result: buildResult(parsed.mode),
    });
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, host, () => {
  process.stdout.write(`mock-r-engine listening on http://${host}:${port}\n`);
});
