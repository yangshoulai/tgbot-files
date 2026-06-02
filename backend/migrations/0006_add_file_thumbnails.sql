ALTER TABLE files ADD COLUMN thumbnail_file_id TEXT;
ALTER TABLE files ADD COLUMN thumbnail_file_unique_id TEXT;
ALTER TABLE files ADD COLUMN thumbnail_file_path TEXT;
ALTER TABLE files ADD COLUMN thumbnail_mime_type TEXT;
ALTER TABLE files ADD COLUMN thumbnail_size INTEGER;
ALTER TABLE files ADD COLUMN thumbnail_width INTEGER;
ALTER TABLE files ADD COLUMN thumbnail_height INTEGER;
ALTER TABLE files ADD COLUMN thumbnail_status TEXT NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_files_thumbnail_status ON files(thumbnail_status);
