-- status: uploaded -> running -> transcribed -> done | failed
CREATE TABLE jobs (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'uploaded',
  error              TEXT,
  r2_key             TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  size               INTEGER NOT NULL,
  qwen_task_id       TEXT,
  speaker_count_hint INTEGER,
  context            TEXT NOT NULL DEFAULT '',
  use_correction     INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_created ON jobs (created_at DESC);

CREATE TABLE speakers (
  job_id       TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  speaker_key  TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (job_id, speaker_key)
);

-- Shared glossary reused for every job (names, jargon).
CREATE TABLE glossary (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT ''
);
