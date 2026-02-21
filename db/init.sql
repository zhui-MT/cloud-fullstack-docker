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

INSERT INTO messages(content)
VALUES ('Hello from PostgreSQL + Docker!')
ON CONFLICT DO NOTHING;
