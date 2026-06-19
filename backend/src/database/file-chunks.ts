import type { AppDatabase } from "../runtime";
import type { FileChunkRecord, NewFileChunkRecord } from "./types";

export async function upsertFileChunkRecord(db: AppDatabase, record: NewFileChunkRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO file_chunks (
        file_id,
        chunk_index,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
        telegram_channel_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.fileId,
      record.chunkIndex,
      record.size,
      record.md5,
      record.telegramFileId,
      record.telegramFileUniqueId ?? null,
      record.telegramChannelId ?? "default",
      record.createdAt
    )
    .run();
}

export async function listFileChunkRecords(db: AppDatabase, fileId: string): Promise<FileChunkRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        file_id,
        chunk_index,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
        COALESCE(telegram_channel_id, 'default') AS telegram_channel_id,
        created_at
      FROM file_chunks
      WHERE file_id = ?
      ORDER BY chunk_index ASC`
    )
    .bind(fileId)
    .all<FileChunkRecord>();

  return result.results ?? [];
}

export async function getFileChunkRecord(
  db: AppDatabase,
  fileId: string,
  chunkIndex: number
): Promise<FileChunkRecord | null> {
  return db
    .prepare(
      `SELECT
        file_id,
        chunk_index,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
        COALESCE(telegram_channel_id, 'default') AS telegram_channel_id,
        created_at
      FROM file_chunks
      WHERE file_id = ? AND chunk_index = ?
      LIMIT 1`
    )
    .bind(fileId, chunkIndex)
    .first<FileChunkRecord>();
}
