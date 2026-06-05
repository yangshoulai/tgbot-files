CREATE TABLE IF NOT EXISTS hls_assets (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  media_playlist_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.apple.mpegurl',
  directory_id TEXT,
  directory_path TEXT NOT NULL DEFAULT '/',
  status TEXT NOT NULL,
  selected_variant_id TEXT,
  target_duration_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  estimated_size INTEGER,
  playlist_text TEXT NOT NULL,
  playlist_file_id TEXT,
  final_file_id TEXT,
  thumbnail_status TEXT NOT NULL DEFAULT 'none',
  remark TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS hls_segments (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  duration_seconds REAL NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL DEFAULT 'video/mp2t',
  size INTEGER,
  storage_backend TEXT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  telegram_channel_id TEXT NOT NULL DEFAULT 'default',
  multipart_upload_id TEXT,
  chunk_size INTEGER,
  chunk_count INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (asset_id) REFERENCES hls_assets(id)
);

CREATE INDEX IF NOT EXISTS idx_hls_assets_status_created
  ON hls_assets(status, created_at);
CREATE INDEX IF NOT EXISTS idx_hls_assets_final_file
  ON hls_assets(final_file_id);
CREATE INDEX IF NOT EXISTS idx_hls_segments_asset_index
  ON hls_segments(asset_id, segment_index);
CREATE INDEX IF NOT EXISTS idx_hls_segments_status
  ON hls_segments(status);
CREATE INDEX IF NOT EXISTS idx_hls_segments_multipart_upload
  ON hls_segments(multipart_upload_id);
