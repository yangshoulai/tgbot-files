CREATE TABLE IF NOT EXISTS directories (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES directories(id)
);

ALTER TABLE files ADD COLUMN directory_id TEXT;
ALTER TABLE files ADD COLUMN directory_path TEXT NOT NULL DEFAULT '/';

ALTER TABLE multipart_uploads ADD COLUMN directory_id TEXT;
ALTER TABLE multipart_uploads ADD COLUMN directory_path TEXT NOT NULL DEFAULT '/';

CREATE UNIQUE INDEX IF NOT EXISTS idx_directories_active_path
  ON directories(path)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_directories_active_parent_name
  ON directories(COALESCE(parent_id, ''), name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_directories_parent_deleted
  ON directories(parent_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_directories_path_deleted
  ON directories(path, deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_directory_deleted_created
  ON files(directory_path, deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_multipart_uploads_directory
  ON multipart_uploads(directory_path);
