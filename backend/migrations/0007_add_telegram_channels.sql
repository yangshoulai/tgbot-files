CREATE TABLE IF NOT EXISTS telegram_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bot_token_encrypted TEXT NOT NULL DEFAULT '',
  bot_token_hash TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(name),
  UNIQUE(bot_token_hash, chat_id)
);

INSERT OR IGNORE INTO telegram_channels (
  id,
  name,
  bot_token_encrypted,
  bot_token_hash,
  chat_id,
  status,
  is_default,
  created_at,
  updated_at
) VALUES (
  'default',
  'default',
  '',
  '',
  '',
  'active',
  1,
  datetime('now'),
  datetime('now')
);

ALTER TABLE files ADD COLUMN telegram_channel_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE file_chunks ADD COLUMN telegram_channel_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE multipart_uploads ADD COLUMN telegram_channel_group TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_files_telegram_channel_id ON files(telegram_channel_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_telegram_channel_id ON file_chunks(telegram_channel_id);
CREATE INDEX IF NOT EXISTS idx_telegram_channels_status ON telegram_channels(status);
