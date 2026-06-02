CREATE INDEX IF NOT EXISTS idx_multipart_uploads_incomplete_created
  ON multipart_uploads(completed_at, created_at);
