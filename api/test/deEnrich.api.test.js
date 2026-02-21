const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function withServer(fn, appOptions = {}) {
  const app = createApp({
    pool: {
      query: async () => ({ rows: [{ now: new Date().toISOString() }] }),
    },
    queueMode: 'memory',
    storeMode: 'memory',
    ...appOptions,
  });
  const server = app.listen(0);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.jobManager?.close?.();
  }
}

async function waitJob(base, jobId) {
  for (let i = 0; i < 30; i += 1) {
    const res = await fetch(`${base}/api/job/${jobId}`);
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed' || body.status === 'canceled') {
      return body;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job wait timeout');
}

test('POST /api/run/de-enrich and GET /api/job/:id works in api service', async () => {
  const prev = process.env.R_ENGINE_URL;
  delete process.env.R_ENGINE_URL;

  try {
    await withServer(async (base) => {
      const runRes = await fetch(`${base}/api/run/de-enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'limma' }),
      });

      assert.equal(runRes.status, 202);
      const runBody = await runRes.json();
      assert.equal(runBody.module, 'de-enrich');
      assert.equal(typeof runBody.jobId, 'string');

      const job = await waitJob(base, runBody.jobId);
      assert.equal(job.status, 'succeeded');
      assert.equal(job.result.module, 'de-enrich');
      assert.equal(job.result.engine, 'limma');
      assert.equal(job.result.de.summary.totalGenes, 20);
      assert.equal(job.result.runtime.backend, 'JS_FALLBACK');
      assert.equal(job.retryOf, null);
      assert.equal(job.retryCount, 0);
      assert.equal(job.canceledAt, null);
      assert.equal(job.canceledBy, null);
      assert.ok(Array.isArray(job.logs));
      assert.ok(job.logs.some((x) => x.message.includes('fallback')));

      const listRes = await fetch(`${base}/api/jobs?limit=5`);
      assert.equal(listRes.status, 200);
      const listBody = await listRes.json();
      assert.ok(Array.isArray(listBody.items));
      assert.ok(listBody.items.some((item) => item.id === runBody.jobId));
      assert.equal(typeof listBody.nextCursor === 'string' || listBody.nextCursor === null, true);
    });
  } finally {
    if (prev === undefined) {
      delete process.env.R_ENGINE_URL;
    } else {
      process.env.R_ENGINE_URL = prev;
    }
  }
});

test('DEqMS is exposed but not implemented in api service', async () => {
  await withServer(async (base) => {
    const runRes = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'DEqMS' }),
    });

    assert.equal(runRes.status, 202);
    const runBody = await runRes.json();

    const job = await waitJob(base, runBody.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'ENGINE_NOT_IMPLEMENTED');
  });
});

test('POST /api/job/:id/retry retries failed jobs with override request', async () => {
  await withServer(async (base) => {
    const failedRun = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'DEqMS' }),
    });
    assert.equal(failedRun.status, 202);
    const failedRunBody = await failedRun.json();
    const failedJob = await waitJob(base, failedRunBody.jobId);
    assert.equal(failedJob.status, 'failed');

    const retryRes = await fetch(`${base}/api/job/${failedRunBody.jobId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: { engine: 'limma' },
      }),
    });
    assert.equal(retryRes.status, 202);
    const retryBody = await retryRes.json();
    assert.equal(retryBody.sourceJobId, failedRunBody.jobId);
    assert.equal(typeof retryBody.retryJobId, 'string');
    assert.equal(retryBody.retryOf, failedRunBody.jobId);
    assert.equal(retryBody.retryCount, 1);

    const retried = await waitJob(base, retryBody.retryJobId);
    assert.equal(retried.status, 'succeeded');
    assert.equal(retried.result.engine, 'limma');
    assert.equal(retried.retryOf, failedRunBody.jobId);
    assert.equal(retried.retryCount, 1);
  });
});

test('POST /api/job/:id/retry returns 409 for non-failed jobs', async () => {
  await withServer(async (base) => {
    const runRes = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'limma' }),
    });
    assert.equal(runRes.status, 202);
    const runBody = await runRes.json();
    const completed = await waitJob(base, runBody.jobId);
    assert.equal(completed.status, 'succeeded');

    const retryRes = await fetch(`${base}/api/job/${runBody.jobId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(retryRes.status, 409);
    const retryBody = await retryRes.json();
    assert.equal(retryBody.error, 'only failed jobs can be retried');
  });
});

test('POST /api/job/:id/cancel cancels running in-memory jobs', async () => {
  await withServer(
    async (base) => {
      const runRes = await fetch(`${base}/api/run/slow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(runRes.status, 202);
      const runBody = await runRes.json();

      const cancelRes = await fetch(`${base}/api/job/${runBody.jobId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canceledBy: 'qa-user' }),
      });
      assert.ok(cancelRes.status === 200 || cancelRes.status === 202);
      const cancelBody = await cancelRes.json();
      assert.equal(cancelBody.ok, true);
      assert.equal(cancelBody.canceledBy, 'qa-user');

      const job = await waitJob(base, runBody.jobId);
      assert.equal(job.status, 'canceled');
      assert.equal(job.error.code, 'JOB_CANCELED');
      assert.equal(job.canceledBy, 'qa-user');
      assert.equal(typeof job.canceledAt, 'string');
    },
    {
      moduleRunners: {
        slow: async (_payload, appendLog) => {
          appendLog('info', 'slow task started');
          await new Promise((resolve) => setTimeout(resolve, 120));
          appendLog('info', 'slow task finished');
          return { ok: true };
        },
      },
    }
  );
});

test('POST /api/job/:id/cancel returns conflict for completed jobs and 404 for unknown', async () => {
  await withServer(async (base) => {
    const runRes = await fetch(`${base}/api/run/de-enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'limma' }),
    });
    assert.equal(runRes.status, 202);
    const runBody = await runRes.json();
    const completed = await waitJob(base, runBody.jobId);
    assert.equal(completed.status, 'succeeded');

    const cancelCompleted = await fetch(`${base}/api/job/${runBody.jobId}/cancel`, {
      method: 'POST',
    });
    assert.equal(cancelCompleted.status, 409);
    const cancelCompletedBody = await cancelCompleted.json();
    assert.equal(cancelCompletedBody.code, 'JOB_NOT_CANCELABLE');

    const cancelUnknown = await fetch(`${base}/api/job/not-exists/cancel`, {
      method: 'POST',
    });
    assert.equal(cancelUnknown.status, 404);
  });
});

test('POST /api/job/:id/cancel cancels queued job before execution', async () => {
  await withServer(
    async (base) => {
      const runRes = await fetch(`${base}/api/run/slow-queued`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(runRes.status, 202);
      const runBody = await runRes.json();

      const cancelRes = await fetch(`${base}/api/job/${runBody.jobId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canceledBy: 'ops-user' }),
      });
      assert.ok(cancelRes.status === 200 || cancelRes.status === 202);
      const cancelBody = await cancelRes.json();
      assert.ok(cancelBody.status === 'canceled' || cancelBody.status === 'running');
      assert.equal(cancelBody.canceledBy, 'ops-user');

      const job = await waitJob(base, runBody.jobId);
      assert.equal(job.status, 'canceled');
      assert.equal(job.canceledBy, 'ops-user');
      assert.equal(typeof job.canceledAt, 'string');
      assert.equal(job.error.code, 'JOB_CANCELED');
    },
    {
      moduleRunners: {
        'slow-queued': async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { ok: true };
        },
      },
    }
  );
});

test('GET /api/jobs supports cursor paging', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/api/run/de-enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'limma' }),
      });
      assert.equal(res.status, 202);
      const runBody = await res.json();
      await waitJob(base, runBody.jobId);
      await new Promise((r) => setTimeout(r, 2));
    }

    const page1Res = await fetch(`${base}/api/jobs?limit=2`);
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.equal(page1.items.length, 2);
    assert.equal(typeof page1.nextCursor, 'string');

    const page2Res = await fetch(`${base}/api/jobs?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.ok(page2.items.length >= 1);

    const ids1 = page1.items.map((x) => x.id);
    const ids2 = page2.items.map((x) => x.id);
    assert.ok(ids2.every((id) => !ids1.includes(id)));
  });
});

test('bullmq mode falls back to memory when redis is unavailable', async () => {
  await withServer(
    async (base) => {
      const modulesRes = await fetch(`${base}/api/modules`);
      assert.equal(modulesRes.status, 200);
      const modulesBody = await modulesRes.json();
      assert.equal(modulesBody.queue.mode, 'bullmq');

      const runRes = await fetch(`${base}/api/run/de-enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'limma' }),
      });

      assert.equal(runRes.status, 202);
      const runBody = await runRes.json();
      const job = await waitJob(base, runBody.jobId);
      assert.equal(job.status, 'succeeded');
      assert.equal(job.result.runtime.backend, 'JS_FALLBACK');

      const modulesResAfter = await fetch(`${base}/api/modules`);
      assert.equal(modulesResAfter.status, 200);
      const modulesBodyAfter = await modulesResAfter.json();
      assert.equal(modulesBodyAfter.queue.mode, 'memory-fallback');
      assert.equal(modulesBodyAfter.queue.fallbackActive, true);
      assert.equal(modulesBodyAfter.store.mode, 'memory');
    },
    {
      queueMode: 'bullmq',
      redisOptions: {
        host: '127.0.0.1',
        port: 1,
        connectTimeout: 100,
        retryStrategy() {
          return null;
        },
      },
    }
  );
});
