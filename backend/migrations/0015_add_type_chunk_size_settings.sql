INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('telegram_video_chunk_size_bytes', '2097152', datetime('now'));

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('telegram_text_chunk_size_bytes', '10485760', datetime('now'));

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('telegram_image_chunk_size_bytes', '4194304', datetime('now'));
