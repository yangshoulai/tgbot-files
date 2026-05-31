ALTER TABLE files ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'telegram_single';
ALTER TABLE files ADD COLUMN chunk_size INTEGER;
ALTER TABLE files ADD COLUMN chunk_count INTEGER;

CREATE TABLE IF NOT EXISTS multipart_uploads (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_url TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  remark TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  size INTEGER NOT NULL,
  md5 TEXT NOT NULL,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_files_storage_backend ON files(storage_backend);
CREATE INDEX IF NOT EXISTS idx_multipart_uploads_completed_at ON multipart_uploads(completed_at);
CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id ON file_chunks(file_id);
