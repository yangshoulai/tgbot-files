CREATE TABLE IF NOT EXISTS magnet_imports (
  id TEXT PRIMARY KEY,
  magnet_uri TEXT NOT NULL,
  info_hash TEXT,
  name TEXT,
  status TEXT NOT NULL,
  aria2_metadata_gid TEXT,
  aria2_download_gid TEXT,
  download_dir TEXT NOT NULL,
  selected_indexes_json TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER,
  error_message TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_completed_at TEXT,
  download_started_at TEXT,
  download_completed_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS magnet_import_files (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  file_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  relative_directory_path TEXT,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  upload_id TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(import_id, file_index),
  FOREIGN KEY (import_id) REFERENCES magnet_imports(id)
);

CREATE INDEX IF NOT EXISTS idx_magnet_imports_status_created
  ON magnet_imports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_magnet_imports_metadata_gid
  ON magnet_imports(aria2_metadata_gid);
CREATE INDEX IF NOT EXISTS idx_magnet_imports_download_gid
  ON magnet_imports(aria2_download_gid);
CREATE INDEX IF NOT EXISTS idx_magnet_import_files_import
  ON magnet_import_files(import_id, file_index);
CREATE INDEX IF NOT EXISTS idx_magnet_import_files_upload
  ON magnet_import_files(upload_id);
