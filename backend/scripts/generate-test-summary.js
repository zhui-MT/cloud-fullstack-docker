const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run() {
  const regression = readJson(path.join(__dirname, '../reports/regression-summary.json'));
  const performance = readJson(path.join(__dirname, '../reports/performance-summary.json'));

  const markdown = `# Round 5 Test Summary\n\n- Generated at: ${new Date().toISOString()}\n- Regression status: **${regression.status.toUpperCase()}**\n\n## Regression Coverage\n${regression.checks.map((c) => `- ${c}`).join('\n')}\n\n## Performance Snapshot\n- Analysis API samples: ${performance.samples.analysis_count}\n- Download API samples: ${performance.samples.download_count}\n- Analysis latency (ms): p50=${performance.analysis_ms.p50}, p95=${performance.analysis_ms.p95}, max=${performance.analysis_ms.max}\n- Download latency (ms): p50=${performance.download_ms.p50}, p95=${performance.download_ms.p95}, max=${performance.download_ms.max}\n\n## Notes\n- Performance results are from local Node process loopback benchmarks (non-containerized).\n- For release gate, compare against your deployment environment baseline and keep deltas within agreed threshold.\n`;

  fs.writeFileSync(path.join(__dirname, '../../docs/ROUND5_TEST_SUMMARY.md'), markdown);
  console.log('docs/ROUND5_TEST_SUMMARY.md generated');
}

run();
