const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');

function createFakePool() {
  return {
    async query(sql) {
      if (sql.includes('SELECT NOW')) {
        return { rows: [{ now: new Date('2026-02-21T00:00:00.000Z').toISOString() }] };
      }
      if (sql.includes('FROM messages')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function run() {
  const app = createApp({ pool: createFakePool() });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const result = {
    date: new Date().toISOString(),
    status: 'pass',
    checks: [],
  };

  try {
    const first = await fetch(`${base}/api/analysis?config_rev=rev-0005`).then((r) => r.json());
    const second = await fetch(`${base}/api/analysis?config_rev=rev-0005`).then((r) => r.json());

    assert.equal(first.config_rev, 'rev-0005');
    assert.deepEqual(first.views.pca.data.points.slice(0, 12), second.views.pca.data.points.slice(0, 12));
    assert.deepEqual(first.views.correlation.data.matrix, second.views.correlation.data.matrix);
    result.checks.push('Same config_rev returns deterministic PCA/correlation data');

    const rev6 = await fetch(`${base}/api/analysis?config_rev=rev-0006`).then((r) => r.json());
    assert.notDeepEqual(first.views.pca.data.points.slice(0, 10), rev6.views.pca.data.points.slice(0, 10));
    result.checks.push('Different config_rev changes analysis output');

    const csvRes = await fetch(`${base}${first.views.pca.downloads.csv}`);
    const metaHeader = csvRes.headers.get('x-artifact-meta');
    assert.ok(metaHeader);
    const meta = JSON.parse(metaHeader);
    assert.equal(meta.config_rev, 'rev-0005');
    assert.equal(meta.format, 'csv');
    result.checks.push('CSV download includes artifact metadata and config_rev traceability');

    const pngPayload = await fetch(`${base}${first.views.pca.downloads.png}`).then((r) => r.json());
    assert.equal(pngPayload.metadata.config_rev, 'rev-0005');
    assert.equal(pngPayload.artifact.format, 'png-source');
    result.checks.push('PNG payload endpoint returns config_rev metadata for frontend rendering');
  } catch (error) {
    result.status = 'fail';
    result.error = error.message;
    throw error;
  } finally {
    server.close();
    fs.writeFileSync(path.join(__dirname, '../reports/regression-summary.json'), JSON.stringify(result, null, 2));
  }

  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
