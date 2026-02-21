const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { createApp } = require('../server');
const { InMemoryUploadBlobStore } = require('../src/uploadBlobStore');

async function withServer(fn, options = {}) {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const uploadBlobStore = options.uploadBlobStore || new InMemoryUploadBlobStore();

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
  const sessionRes = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(sessionRes.status, 201);
  const sessionJson = await sessionRes.json();
  assert.ok(sessionJson.sessionId);
  return sessionJson.sessionId;
}

async function uploadSample(base, sessionId, fileName) {
  const samplePath = path.join(__dirname, '..', 'samples', fileName);
  const content = fs.readFileSync(samplePath);
  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('file', new Blob([content]), fileName);

  const uploadRes = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(uploadRes.status, 201);
  return uploadRes.json();
}

async function uploadSampleWithSnakeSession(base, sessionId, fileName) {
  const samplePath = path.join(__dirname, '..', 'samples', fileName);
  const content = fs.readFileSync(samplePath);
  const form = new FormData();
  form.append('session_id', sessionId);
  form.append('file', new Blob([content]), fileName);

  const uploadRes = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: form,
  });
  assert.equal(uploadRes.status, 201);
  return uploadRes.json();
}

async function fetchUploadDetail(base, uploadId) {
  const response = await fetch(`${base}/api/upload/${uploadId}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function fetchMappedRowsPage(base, uploadId, query = '') {
  const response = await fetch(`${base}/api/upload/${uploadId}/mapped-rows${query}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function fetchSessionUploads(base, sessionId, query = '') {
  const response = await fetch(`${base}/api/session/${sessionId}/uploads${query}`);
  return response;
}

async function deleteUpload(base, uploadId) {
  return fetch(`${base}/api/upload/${uploadId}`, { method: 'DELETE' });
}

async function deleteSessionUploads(base, sessionId) {
  return fetch(`${base}/api/session/${sessionId}/uploads`, { method: 'DELETE' });
}

test('POST /api/session + POST /api/upload parses FragPipe protein sample', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-fragpipe');
    const body = await uploadSample(base, sessionId, 'fragpipe_protein.tsv');

    assert.equal(body.detected.sourceTool, 'FragPipe');
    assert.equal(body.detected.entityType, 'protein');
    assert.equal(body.summary.sampleCount, 2);
    assert.equal(body.summary.entityCount, 3);
    assert.ok(Array.isArray(body.summary.availableColumns));
    assert.ok(body.summary.availableColumns.includes('accession'));
    assert.ok(body.summary.availableColumns.includes('quantities'));
    assert.ok(Array.isArray(body.summary.warnings));
    assert.equal(body.summary.warnings.length, 0);
    assert.equal(body.preview.length, 3);
    assert.ok(Array.isArray(body.summary.sampleColumns));
    assert.equal(body.summary.sampleColumns.length, 2);
    assert.equal(body.detailUrl, `/api/upload/${body.uploadId}`);
    assert.equal(body.storage.mode, 'blob');
    assert.ok(typeof body.storage.key === 'string');
  });
});

test('POST /api/session + POST /api/upload parses DIA-NN peptide sample', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-diann');
    const body = await uploadSample(base, sessionId, 'diann_peptide.tsv');

    assert.equal(body.detected.sourceTool, 'DIA-NN');
    assert.equal(body.detected.entityType, 'peptide');
    assert.equal(body.summary.sampleCount, 2);
    assert.equal(body.summary.entityCount, 2);
    assert.ok(body.summary.availableColumns.includes('modifiedSequence'));
    assert.ok(body.summary.availableColumns.includes('proteinGroup'));
    assert.ok(body.summary.availableColumns.includes('quantities'));
    assert.equal(body.summary.warnings.length, 0);
  });
});

test('POST /api/session + POST /api/upload parses MaxQuant protein sample', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-maxquant');
    const body = await uploadSample(base, sessionId, 'maxquant_protein.txt');

    assert.equal(body.detected.sourceTool, 'MaxQuant');
    assert.equal(body.detected.entityType, 'protein');
    assert.equal(body.summary.sampleCount, 2);
    assert.equal(body.summary.entityCount, 2);
    assert.ok(body.summary.availableColumns.includes('accession'));
    assert.ok(body.summary.availableColumns.includes('quantities'));
    assert.equal(body.summary.warnings.length, 0);
  });
});

test('POST /api/upload accepts session_id field in multipart body', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-snake-case');
    const body = await uploadSampleWithSnakeSession(base, sessionId, 'fragpipe_protein.tsv');

    assert.equal(body.sessionId, sessionId);
    assert.equal(body.detected.sourceTool, 'FragPipe');
    assert.equal(body.detected.entityType, 'protein');
  });
});

test('GET /api/upload/:id returns persisted normalized rows and summary', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-detail');
    const upload = await uploadSample(base, sessionId, 'diann_peptide.tsv');
    const detail = await fetchUploadDetail(base, upload.uploadId);

    assert.equal(detail.uploadId, upload.uploadId);
    assert.equal(detail.sessionId, sessionId);
    assert.equal(detail.detected.sourceTool, 'DIA-NN');
    assert.equal(detail.detected.entityType, 'peptide');
    assert.equal(detail.summary.rowCount, 2);
    assert.equal(detail.summary.sampleCount, 2);
    assert.equal(detail.summary.entityCount, 2);
    assert.ok(Array.isArray(detail.summary.sourceColumns));
    assert.ok(Array.isArray(detail.summary.sampleColumns));
    assert.equal(detail.summary.sampleColumns.length, 2);
    assert.equal(detail.mappedRowCount, 2);
    assert.equal(detail.preview.length, 2);
    assert.equal(detail.preview[0].sequence, 'AAAAK');
    assert.equal(detail.preview[0].accession, 'P12345');
    assert.equal(detail.storage.mode, 'blob');
    assert.ok(typeof detail.storage.key === 'string');
  });
});

test('GET /api/upload/:id/mapped-rows supports pagination', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-page');
    const upload = await uploadSample(base, sessionId, 'diann_peptide.tsv');

    const page0 = await fetchMappedRowsPage(base, upload.uploadId, '?limit=1&offset=0');
    assert.equal(page0.total, 2);
    assert.equal(page0.returned, 1);
    assert.equal(page0.mappedRows[0].sequence, 'AAAAK');
    assert.equal(page0.storage.mode, 'blob');

    const page1 = await fetchMappedRowsPage(base, upload.uploadId, '?limit=1&offset=1');
    assert.equal(page1.total, 2);
    assert.equal(page1.returned, 1);
    assert.equal(page1.mappedRows[0].sequence, 'BBBBR');
  });
});

test('GET /api/session/:id/uploads lists uploads with pagination', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-list');
    const up1 = await uploadSample(base, sessionId, 'fragpipe_protein.tsv');
    const up2 = await uploadSample(base, sessionId, 'diann_peptide.tsv');

    const listResponse = await fetchSessionUploads(base, sessionId, '?limit=1&offset=0');
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();

    assert.equal(listBody.session.sessionId, sessionId);
    assert.equal(listBody.total, 2);
    assert.equal(listBody.returned, 1);
    assert.equal(listBody.limit, 1);
    assert.equal(listBody.offset, 0);
    assert.equal(listBody.uploads[0].uploadId, up2.uploadId);
    assert.equal(listBody.uploads[0].detailUrl, `/api/upload/${up2.uploadId}`);
    assert.equal(listBody.uploads[0].storage.mode, 'blob');
    assert.ok(Array.isArray(listBody.uploads[0].summary.availableColumns));

    const listPage2Response = await fetchSessionUploads(base, sessionId, '?limit=1&offset=1');
    assert.equal(listPage2Response.status, 200);
    const listPage2 = await listPage2Response.json();
    assert.equal(listPage2.returned, 1);
    assert.equal(listPage2.uploads[0].uploadId, up1.uploadId);
  });
});

test('GET /api/session/:id/uploads returns 404 for unknown session', async () => {
  await withServer(async (base) => {
    const response = await fetchSessionUploads(base, 'session-not-exists');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.ok(String(body.error || '').includes('session not found'));
  });
});

test('DELETE /api/upload/:id removes upload and updates session list', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-delete');
    const upload = await uploadSample(base, sessionId, 'fragpipe_protein.tsv');

    const remove = await deleteUpload(base, upload.uploadId);
    assert.equal(remove.status, 200);
    const removedBody = await remove.json();
    assert.equal(removedBody.ok, true);
    assert.equal(removedBody.uploadId, upload.uploadId);
    assert.equal(removedBody.sessionId, sessionId);
    assert.equal(removedBody.blobDeleted, true);
    assert.equal(removedBody.warnings.length, 0);

    const detail = await fetch(`${base}/api/upload/${upload.uploadId}`);
    assert.equal(detail.status, 404);

    const list = await fetchSessionUploads(base, sessionId);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.total, 0);
    assert.equal(listBody.returned, 0);
  });
});

test('DELETE /api/upload/:id still deletes db row when blob delete fails', async () => {
  const deleteFailStore = {
    async saveMappedRows({ uploadId, sessionId }) {
      return `uploads/${sessionId}/${uploadId}.json`;
    },
    async readMappedRows() {
      return [];
    },
    async deleteMappedRows() {
      throw new Error('simulated blob delete failure');
    },
  };

  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-delete-fallback');
    const upload = await uploadSample(base, sessionId, 'diann_peptide.tsv');
    const remove = await deleteUpload(base, upload.uploadId);
    assert.equal(remove.status, 200);

    const removedBody = await remove.json();
    assert.equal(removedBody.ok, true);
    assert.equal(removedBody.blobDeleted, false);
    assert.ok(removedBody.warnings.some((msg) => msg.includes('failed to delete mapped rows blob')));

    const detail = await fetch(`${base}/api/upload/${upload.uploadId}`);
    assert.equal(detail.status, 404);
  }, { uploadBlobStore: deleteFailStore });
});

test('DELETE /api/session/:id/uploads removes all uploads in a session', async () => {
  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-session-delete');
    await uploadSample(base, sessionId, 'fragpipe_protein.tsv');
    await uploadSample(base, sessionId, 'diann_peptide.tsv');

    const remove = await deleteSessionUploads(base, sessionId);
    assert.equal(remove.status, 200);
    const body = await remove.json();
    assert.equal(body.ok, true);
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.deletedCount, 2);
    assert.equal(body.blobDeletedCount, 2);
    assert.equal(body.warnings.length, 0);

    const list = await fetchSessionUploads(base, sessionId);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.total, 0);
    assert.equal(listBody.returned, 0);
  });
});

test('DELETE /api/session/:id/uploads deletes db rows even when blob delete fails', async () => {
  const deleteFailStore = {
    async saveMappedRows({ uploadId, sessionId }) {
      return `uploads/${sessionId}/${uploadId}.json`;
    },
    async readMappedRows() {
      return [];
    },
    async deleteMappedRows() {
      throw new Error('simulated bulk blob delete failure');
    },
  };

  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-session-delete-fallback');
    await uploadSample(base, sessionId, 'fragpipe_protein.tsv');
    await uploadSample(base, sessionId, 'maxquant_protein.txt');

    const remove = await deleteSessionUploads(base, sessionId);
    assert.equal(remove.status, 200);
    const body = await remove.json();
    assert.equal(body.ok, true);
    assert.equal(body.deletedCount, 2);
    assert.equal(body.blobDeletedCount, 0);
    assert.ok(body.warnings.length >= 2);
    assert.ok(body.warnings.every((msg) => msg.includes('failed to delete mapped rows blob')));

    const list = await fetchSessionUploads(base, sessionId);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.total, 0);
  }, { uploadBlobStore: deleteFailStore });
});

test('POST /api/upload falls back to db mode when blob save fails', async () => {
  const failingStore = {
    async saveMappedRows() {
      throw new Error('simulated blob save failure');
    },
    async readMappedRows() {
      throw new Error('should not be called when save fails');
    },
  };

  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-fallback-save-fail');
    const upload = await uploadSample(base, sessionId, 'fragpipe_protein.tsv');

    assert.equal(upload.storage.mode, 'db');
    assert.equal(upload.storage.key, null);
    assert.ok(upload.summary.warnings.some((msg) => msg.includes('blob persistence failed')));

    const detail = await fetchUploadDetail(base, upload.uploadId);
    assert.equal(detail.storage.mode, 'db');
    assert.equal(detail.mappedRowCount, 3);
    assert.equal(detail.preview.length, 3);
  }, { uploadBlobStore: failingStore });
});

test('GET /api/upload/:id uses db fallback when blob read fails', async () => {
  const readFailStore = {
    async saveMappedRows({ uploadId, sessionId }) {
      return `uploads/${sessionId}/${uploadId}.json`;
    },
    async readMappedRows() {
      throw new Error('simulated blob read failure');
    },
  };

  await withServer(async (base) => {
    const sessionId = await createSession(base, 'round2-upload-fallback-read-fail');
    const upload = await uploadSample(base, sessionId, 'diann_peptide.tsv');
    assert.equal(upload.storage.mode, 'blob');

    const detail = await fetchUploadDetail(base, upload.uploadId);
    assert.equal(detail.storage.mode, 'blob');
    assert.equal(detail.mappedRowCount, 2);
    assert.equal(detail.preview.length, 2);
    assert.ok(detail.summary.warnings.some((msg) => msg.includes('failed to load mapped rows from blob')));

    const page = await fetchMappedRowsPage(base, upload.uploadId, '?limit=2&offset=0');
    assert.equal(page.returned, 2);
    assert.ok(page.warnings.some((msg) => msg.includes('failed to load mapped rows from blob')));
  }, { uploadBlobStore: readFailStore });
});
