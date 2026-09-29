// Re-runnable schema migrations for the life-trial database.
// Each migration is keyed and only applied once; re-running is a no-op.

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  time_unit TEXT NOT NULL CHECK (time_unit IN ('hours','cycles','days','weeks')),
  current_version INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- One row per immutable dataset version (a frozen snapshot).
CREATE TABLE IF NOT EXISTS dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  version INTEGER NOT NULL,
  frozen_at TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  subject_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  censor_count INTEGER NOT NULL,
  UNIQUE (dataset_id, version),
  UNIQUE (dataset_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  anon_id TEXT NOT NULL,           -- anonymous specimen id, unique within version
  group_label TEXT NOT NULL,
  time REAL NOT NULL,              -- event or right-censor time, origin = 0
  status TEXT NOT NULL CHECK (status IN ('event','censored')),
  censor_reason TEXT,              -- required when status = censored
  UNIQUE (version_id, anon_id)
);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  created_at TEXT NOT NULL,
  params_json TEXT NOT NULL,       -- frozen analysis parameters
  kind TEXT NOT NULL CHECK (kind IN ('curve','logrank')),
  result_json TEXT NOT NULL,       -- frozen report payload
  request_hash TEXT NOT NULL,      -- idempotency key
  UNIQUE (version_id, kind, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_subjects_version ON subjects(version_id);
CREATE INDEX IF NOT EXISTS idx_subjects_group ON subjects(version_id, group_label);
`,
  },
];
