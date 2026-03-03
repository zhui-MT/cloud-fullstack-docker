const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createApp } = require('../server');

function createFakePool() {
  return {
    async query() {
      return { rows: [] };
    },
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, idx)].toFixed(2));
}

async function timedFetch(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  await res.text();
  return performance.now() - t0;
}

async function run() {
  const app = createApp({ pool: createFakePool() });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const analysisSamples = [];
  const downloadSamples = [];
  let downloadUrls = null;

  try {
    for (let i = 0; i < 3; i += 1) {
      await timedFetch(`${base}/api/analysis?config_rev=rev-0005`);
    }

    for (let i = 0; i < 40; i += 1) {
      const latency = await timedFetch(`${base}/api/analysis?config_rev=rev-${String(500 + i).padStart(4, '0')}`);
      analysisSamples.push(latency);
    }

    const sample = await fetch(`${base}/api/analysis?config_rev=rev-perf`).then((r) => r.json());
    downloadUrls = Object.values(sample.views).flatMap((view) => [view.downloads.csv, view.downloads.svg, view.downloads.png]);

    for (let i = 0; i < 5; i += 1) {
      for (const url of downloadUrls) {
        const latency = await timedFetch(`${base}${url}`);
        downloadSamples.push(latency);
      }
    }

    const summary = {
      date: new Date().toISOString(),
      samples: {
        analysis_count: analysisSamples.length,
        download_count: downloadSamples.length,
      },
      analysis_ms: {
        p50: percentile(analysisSamples, 50),
        p95: percentile(analysisSamples, 95),
        max: Number(Math.max(...analysisSamples).toFixed(2)),
      },
      download_ms: {
        p50: percentile(downloadSamples, 50),
        p95: percentile(downloadSamples, 95),
        max: Number(Math.max(...downloadSamples).toFixed(2)),
      },
    };

    fs.writeFileSync(path.join(__dirname, '../reports/performance-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    server.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
