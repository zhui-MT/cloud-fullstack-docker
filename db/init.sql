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

CREATE TABLE IF NOT EXISTS analysis_runs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  upload_id BIGINT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  config_rev INTEGER,
  config_tag TEXT,
  config_hash TEXT,
  status TEXT NOT NULL,
  engine TEXT NOT NULL,
  de_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enrichment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_groups_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_hash TEXT NOT NULL,
  config_trace_json JSONB,
  runtime_json JSONB,
  result_json JSONB,
  views_json JSONB,
  artifact_index JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_json JSONB,
  job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
CREATE INDEX IF NOT EXISTS idx_analysis_runs_status_created_at ON analysis_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_session_id_created_at ON analysis_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_upload_id_created_at ON analysis_runs(upload_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_artifact_index_gin ON analysis_runs USING GIN (artifact_index);

INSERT INTO messages(content)
VALUES ('Hello from PostgreSQL + Docker!')
ON CONFLICT DO NOTHING;
