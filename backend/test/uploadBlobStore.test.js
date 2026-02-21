const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FsUploadBlobStore,
  S3UploadBlobStore,
  createDefaultUploadBlobStore,
} = require('../src/uploadBlobStore');

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const snapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
    const value = overrides[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  }
}

test('createDefaultUploadBlobStore returns FsUploadBlobStore by default', () => {
  withEnv({
    UPLOAD_BLOB_BACKEND: null,
    UPLOAD_BLOB_DIR: null,
  }, () => {
    const store = createDefaultUploadBlobStore();
    assert.ok(store instanceof FsUploadBlobStore);
  });
});

test('createDefaultUploadBlobStore returns S3UploadBlobStore when configured', () => {
  withEnv(
    {
      UPLOAD_BLOB_BACKEND: 's3',
      UPLOAD_BLOB_BUCKET: 'bioid-artifacts',
      UPLOAD_BLOB_ENDPOINT: 'http://minio:9000',
      UPLOAD_BLOB_REGION: 'us-east-1',
      UPLOAD_BLOB_ACCESS_KEY_ID: 'minioadmin',
      UPLOAD_BLOB_SECRET_ACCESS_KEY: 'minioadmin',
      UPLOAD_BLOB_FORCE_PATH_STYLE: 'true',
      UPLOAD_BLOB_PREFIX: 'uploads',
    },
    () => {
      const store = createDefaultUploadBlobStore();
      assert.ok(store instanceof S3UploadBlobStore);
      assert.equal(store.bucket, 'bioid-artifacts');
      assert.equal(store.prefix, 'uploads');
    }
  );
});

test('createDefaultUploadBlobStore throws when s3 backend misses bucket', () => {
  withEnv(
    {
      UPLOAD_BLOB_BACKEND: 's3',
      UPLOAD_BLOB_BUCKET: null,
      UPLOAD_BLOB_ENDPOINT: 'http://minio:9000',
    },
    () => {
      assert.throws(
        () => createDefaultUploadBlobStore(),
        /UPLOAD_BLOB_BUCKET is required/
      );
    }
  );
});
