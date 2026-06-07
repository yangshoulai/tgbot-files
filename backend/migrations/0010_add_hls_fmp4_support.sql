ALTER TABLE multipart_uploads ADD COLUMN source_range_start INTEGER;

ALTER TABLE hls_assets ADD COLUMN init_source_url TEXT;
ALTER TABLE hls_assets ADD COLUMN init_byte_range_start INTEGER;
ALTER TABLE hls_assets ADD COLUMN init_byte_range_length INTEGER;
ALTER TABLE hls_assets ADD COLUMN init_mime_type TEXT;
ALTER TABLE hls_assets ADD COLUMN init_size INTEGER;
ALTER TABLE hls_assets ADD COLUMN init_storage_backend TEXT;
ALTER TABLE hls_assets ADD COLUMN init_telegram_file_id TEXT;
ALTER TABLE hls_assets ADD COLUMN init_telegram_file_unique_id TEXT;
ALTER TABLE hls_assets ADD COLUMN init_telegram_channel_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE hls_assets ADD COLUMN init_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE hls_assets ADD COLUMN init_error_message TEXT;
ALTER TABLE hls_assets ADD COLUMN init_completed_at TEXT;

ALTER TABLE hls_segments ADD COLUMN byte_range_start INTEGER;
ALTER TABLE hls_segments ADD COLUMN byte_range_length INTEGER;
