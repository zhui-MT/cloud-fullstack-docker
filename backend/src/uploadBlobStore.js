const fs = require('fs/promises');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

class InMemoryUploadBlobStore {
  constructor() {
    this.store = new Map();
  }

  async saveMappedRows({ uploadId, sessionId, mappedRows }) {
    const key = `uploads/${sessionId}/${uploadId}.json`;
    this.store.set(key, JSON.stringify(mappedRows || []));
    return key;
  }

  async readMappedRows(key) {
    if (!this.store.has(key)) {
      throw new Error(`blob key not found: ${key}`);
    }
    return JSON.parse(this.store.get(key));
  }

  async deleteMappedRows(key) {
    this.store.delete(key);
  }
}

class FsUploadBlobStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  async saveMappedRows({ uploadId, sessionId, mappedRows }) {
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const key = `uploads/${safeSessionId}/${uploadId}.json`;
    const absPath = path.join(this.baseDir, key);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, JSON.stringify(mappedRows || []), 'utf8');
    return key;
  }

  async readMappedRows(key) {
    const absPath = path.join(this.baseDir, key);
    const content = await fs.readFile(absPath, 'utf8');
    return JSON.parse(content);
  }

  async deleteMappedRows(key) {
    const absPath = path.join(this.baseDir, key);
    try {
      await fs.unlink(absPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

class S3UploadBlobStore {
  constructor({ client, bucket, prefix = 'uploads' }) {
    this.client = client;
    this.bucket = bucket;
    this.prefix = String(prefix || 'uploads').replace(/^\/+|\/+$/g, '');
  }

  makeKey(sessionId, uploadId) {
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${this.prefix}/${safeSessionId}/${uploadId}.json`;
  }

  async saveMappedRows({ uploadId, sessionId, mappedRows }) {
    const key = this.makeKey(sessionId, uploadId);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(mappedRows || []),
        ContentType: 'application/json; charset=utf-8',
      })
    );
    return key;
  }

  async readMappedRows(key) {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );

    const chunks = [];
    for await (const chunk of result.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async deleteMappedRows(key) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }
}

function createDefaultUploadBlobStore() {
  const backend = String(process.env.UPLOAD_BLOB_BACKEND || 'fs').toLowerCase();
  if (backend === 's3' || backend === 'minio') {
    const bucket = process.env.UPLOAD_BLOB_BUCKET;
    if (!bucket) {
      throw new Error('UPLOAD_BLOB_BUCKET is required when UPLOAD_BLOB_BACKEND is s3/minio');
    }

    const endpoint = process.env.UPLOAD_BLOB_ENDPOINT;
    const region = process.env.UPLOAD_BLOB_REGION || 'us-east-1';
    const accessKeyId = process.env.UPLOAD_BLOB_ACCESS_KEY_ID;
    const secretAccessKey = process.env.UPLOAD_BLOB_SECRET_ACCESS_KEY;
    const prefix = process.env.UPLOAD_BLOB_PREFIX || 'uploads';
    const forcePathStyleRaw = String(process.env.UPLOAD_BLOB_FORCE_PATH_STYLE || 'true').toLowerCase();
    const forcePathStyle = forcePathStyleRaw === 'true' || forcePathStyleRaw === '1';

    const config = {
      region,
      forcePathStyle,
    };
    if (endpoint) {
      config.endpoint = endpoint;
    }
    if (accessKeyId && secretAccessKey) {
      config.credentials = { accessKeyId, secretAccessKey };
    }

    const client = new S3Client(config);
    return new S3UploadBlobStore({ client, bucket, prefix });
  }

  const baseDir = process.env.UPLOAD_BLOB_DIR
    ? path.resolve(process.env.UPLOAD_BLOB_DIR)
    : path.resolve(__dirname, '..', 'reports');
  return new FsUploadBlobStore(baseDir);
}

module.exports = {
  InMemoryUploadBlobStore,
  FsUploadBlobStore,
  S3UploadBlobStore,
  createDefaultUploadBlobStore,
};
