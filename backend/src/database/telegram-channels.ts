import type { AppDatabase } from "../runtime";
import type {
  NewTelegramChannelRecord,
  TelegramChannelRecord,
  TelegramChannelUsage,
  UpdateTelegramChannelRecord
} from "./types";

export async function listTelegramChannelRecords(db: AppDatabase): Promise<TelegramChannelRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        name,
        bot_token_encrypted,
        bot_token_hash,
        chat_id,
        status,
        is_default,
        created_at,
        updated_at
      FROM telegram_channels
      ORDER BY is_default DESC, created_at ASC`
    )
    .all<TelegramChannelRecord>();

  return result.results ?? [];
}

export async function listActiveTelegramChannelRecords(db: AppDatabase): Promise<TelegramChannelRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        name,
        bot_token_encrypted,
        bot_token_hash,
        chat_id,
        status,
        is_default,
        created_at,
        updated_at
      FROM telegram_channels
      WHERE status = 'active'
      ORDER BY is_default DESC, created_at ASC`
    )
    .all<TelegramChannelRecord>();

  return result.results ?? [];
}

export async function getTelegramChannelRecord(db: AppDatabase, id: string): Promise<TelegramChannelRecord | null> {
  return db
    .prepare(
      `SELECT
        id,
        name,
        bot_token_encrypted,
        bot_token_hash,
        chat_id,
        status,
        is_default,
        created_at,
        updated_at
      FROM telegram_channels
      WHERE id = ?
      LIMIT 1`
    )
    .bind(id)
    .first<TelegramChannelRecord>();
}

export async function insertTelegramChannelRecord(db: AppDatabase, record: NewTelegramChannelRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO telegram_channels (
        id,
        name,
        bot_token_encrypted,
        bot_token_hash,
        chat_id,
        status,
        is_default,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.name,
      record.botTokenEncrypted,
      record.botTokenHash,
      record.chatId,
      record.status ?? "active",
      record.isDefault ? 1 : 0,
      record.createdAt,
      record.updatedAt
    )
    .run();
}

export async function updateTelegramChannelRecord(db: AppDatabase, record: UpdateTelegramChannelRecord): Promise<TelegramChannelRecord | null> {
  const result = await db
    .prepare(
      `UPDATE telegram_channels
      SET name = ?, bot_token_encrypted = ?, bot_token_hash = ?, chat_id = ?, status = ?, updated_at = ?
      WHERE id = ?`
    )
    .bind(
      record.name,
      record.botTokenEncrypted,
      record.botTokenHash,
      record.chatId,
      record.status,
      record.updatedAt,
      record.id
    )
    .run();

  if ((result.meta as { changes?: number }).changes === 0) {
    return null;
  }

  return getTelegramChannelRecord(db, record.id);
}

export async function deleteTelegramChannelRecord(db: AppDatabase, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM telegram_channels WHERE id = ? AND is_default = 0").bind(id).run();
  return ((result.meta as { changes?: number }).changes ?? 0) > 0;
}

export async function getTelegramChannelUsage(db: AppDatabase, id: string): Promise<TelegramChannelUsage> {
  const files = await db
    .prepare("SELECT COUNT(*) AS total FROM files WHERE COALESCE(telegram_channel_id, 'default') = ?")
    .bind(id)
    .first<{ total: number }>();
  const chunks = await db
    .prepare("SELECT COUNT(*) AS total FROM file_chunks WHERE COALESCE(telegram_channel_id, 'default') = ?")
    .bind(id)
    .first<{ total: number }>();

  return {
    files: files?.total ?? 0,
    chunks: chunks?.total ?? 0
  };
}
