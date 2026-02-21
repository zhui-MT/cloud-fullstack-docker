CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS uploads (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  source_tool TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  entity_count INTEGER NOT NULL,
  available_columns JSONB NOT NULL,
  warnings JSONB NOT NULL,
  source_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  sample_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapped_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapped_rows_storage TEXT NOT NULL DEFAULT 'db',
  mapped_rows_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_configs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  config_rev INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, config_rev),
  UNIQUE(session_id, config_hash)
);

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
);

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS retry_of TEXT;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS canceled_by TEXT;
CREATE INDEX IF NOT EXISTS idx_job_runs_status_created_at ON job_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_retry_of ON job_runs(retry_of);

INSERT INTO messages(content)
VALUES ('Hello from PostgreSQL + Docker!')
ON CONFLICT DO NOTHING;
