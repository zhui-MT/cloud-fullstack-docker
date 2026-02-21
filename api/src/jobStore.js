class InMemoryJobStore {
  constructor() {
    this.jobs = new Map();
  }

  async init() {
    return undefined;
  }

  async upsertJob(job) {
    this.jobs.set(job.id, cloneJob(job));
  }

  async getJob(id) {
    const row = this.jobs.get(id);
    return row ? cloneJob(row) : null;
  }

  async listJobs({ limit = 50, status, module, cursor }) {
    let rows = Array.from(this.jobs.values());

    if (status) rows = rows.filter((r) => r.status === status);
    if (module) rows = rows.filter((r) => r.module === module);

    rows.sort(compareJobDesc);

    if (cursor?.createdAt && cursor?.id) {
      rows = rows.filter((item) => isAfterCursor(item, cursor));
    }

    const page = rows.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const items = page.slice(0, limit).map(cloneJob);
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
}

class PgJobStore {
  constructor(pool) {
    this.pool = pool;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        canceled_at TIMESTAMPTZ,
        canceled_by TEXT,
        retry_of TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_json JSONB,
        error_json JSONB,
        logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS retry_of TEXT`);
    await this.pool.query(`ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
    await this.pool.query(`ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ`);
    await this.pool.query(`ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS canceled_by TEXT`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_job_runs_status_created_at ON job_runs(status, created_at DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_job_runs_retry_of ON job_runs(retry_of)`);
    this.initialized = true;
  }

  async upsertJob(job) {
    await this.init();

    await this.pool.query(
      `
      INSERT INTO job_runs (
        id, module, status, created_at, started_at, finished_at,
        canceled_at, canceled_by,
        retry_of, retry_count,
        request_json, result_json, error_json, logs_json, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        module = EXCLUDED.module,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        canceled_at = EXCLUDED.canceled_at,
        canceled_by = EXCLUDED.canceled_by,
        retry_of = EXCLUDED.retry_of,
        retry_count = EXCLUDED.retry_count,
        request_json = EXCLUDED.request_json,
        result_json = EXCLUDED.result_json,
        error_json = EXCLUDED.error_json,
        logs_json = EXCLUDED.logs_json,
        updated_at = NOW()
      `,
      [
        job.id,
        job.module,
        job.status,
        toIsoOrNull(job.createdAt) || new Date().toISOString(),
        toIsoOrNull(job.startedAt),
        toIsoOrNull(job.finishedAt),
        toIsoOrNull(job.canceledAt),
        job.canceledBy || null,
        job.retryOf || null,
        Number.isInteger(job.retryCount) && job.retryCount >= 0 ? job.retryCount : 0,
        JSON.stringify(job.request || {}),
        JSON.stringify(job.result),
        JSON.stringify(job.error),
        JSON.stringify(job.logs || []),
      ]
    );
  }

  async getJob(id) {
    await this.init();

    const result = await this.pool.query(
      `
      SELECT
        id,
        module,
        status,
        created_at,
        started_at,
        finished_at,
        canceled_at,
        canceled_by,
        retry_of,
        retry_count,
        request_json,
        result_json,
        error_json,
        logs_json
      FROM job_runs
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (result.rowCount === 0) return null;
    return fromDbRow(result.rows[0]);
  }

  async listJobs({ limit = 50, status, module, cursor }) {
    await this.init();

    const clauses = [];
    const values = [];

    if (status) {
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    if (module) {
      values.push(module);
      clauses.push(`module = $${values.length}`);
    }

    if (cursor?.createdAt && cursor?.id) {
      values.push(toIsoOrNull(cursor.createdAt));
      const createdAtPos = values.length;
      values.push(cursor.id);
      const idPos = values.length;
      clauses.push(`(created_at < $${createdAtPos} OR (created_at = $${createdAtPos} AND id < $${idPos}))`);
    }

    values.push(limit + 1);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const result = await this.pool.query(
      `
      SELECT
        id,
        module,
        status,
        created_at,
        started_at,
        finished_at,
        canceled_at,
        canceled_by,
        retry_of,
        retry_count,
        request_json,
        result_json,
        error_json,
        logs_json
      FROM job_runs
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
      `,
      values
    );

    const mapped = result.rows.map(fromDbRow);
    const hasMore = mapped.length > limit;
    const items = mapped.slice(0, limit);
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
}

function createJobStore({ mode = 'memory', pool }) {
  if (mode === 'postgres') {
    return new PgJobStore(pool);
  }
  return new InMemoryJobStore();
}

function compareJobDesc(a, b) {
  const t = Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
  if (t !== 0) return t;
  if (a.id === b.id) return 0;
  return b.id > a.id ? 1 : -1;
}

function isAfterCursor(item, cursor) {
  const itemTs = Date.parse(item.createdAt || 0);
  const cursorTs = Date.parse(cursor.createdAt || 0);
  if (itemTs < cursorTs) return true;
  if (itemTs > cursorTs) return false;
  return item.id < cursor.id;
}

function fromDbRow(row) {
  return {
    id: row.id,
    module: row.module,
    status: row.status,
    createdAt: toIsoOrNull(row.created_at),
    startedAt: toIsoOrNull(row.started_at),
    finishedAt: toIsoOrNull(row.finished_at),
    canceledAt: toIsoOrNull(row.canceled_at),
    canceledBy: row.canceled_by || null,
    retryOf: row.retry_of || null,
    retryCount: Number.isInteger(row.retry_count) ? row.retry_count : 0,
    request: row.request_json || {},
    result: row.result_json || null,
    error: row.error_json || null,
    logs: Array.isArray(row.logs_json) ? row.logs_json : [],
  };
}

function cloneJob(job) {
  return {
    id: job.id,
    module: job.module,
    status: job.status,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    canceledAt: job.canceledAt || null,
    canceledBy: job.canceledBy || null,
    retryOf: job.retryOf || null,
    retryCount: Number.isInteger(job.retryCount) ? job.retryCount : 0,
    request: job.request ? JSON.parse(JSON.stringify(job.request)) : {},
    result: job.result === undefined ? null : JSON.parse(JSON.stringify(job.result)),
    error: job.error === undefined ? null : JSON.parse(JSON.stringify(job.error)),
    logs: Array.isArray(job.logs) ? JSON.parse(JSON.stringify(job.logs)) : [],
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

module.exports = {
  createJobStore,
};
