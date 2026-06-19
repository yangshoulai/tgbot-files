import { AppError } from "../utils/http";
import type { AppDatabase, AppPreparedStatement } from "../runtime";
import type { NewFileRecord } from "./types";

export function requireDb(env: { DATABASE?: AppDatabase }): AppDatabase {
  if (!env.DATABASE) {
    throw new AppError(500, "ServerMisconfigured", "Missing configured database");
  }

  return env.DATABASE;
}

export function prepareInsertFileRecord(db: AppDatabase, record: NewFileRecord): AppPreparedStatement {
  return db
    .prepare(
      `INSERT INTO files (
        id,
        file_name,
        mime_type,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
        telegram_channel_id,
        file_path,
        remark,
        uploaded_by,
        created_at,
        directory_id,
        directory_path,
        deleted_at,
        storage_backend,
        chunk_size,
        chunk_count,
        thumbnail_file_id,
        thumbnail_file_unique_id,
        thumbnail_file_path,
        thumbnail_mime_type,
        thumbnail_size,
        thumbnail_width,
        thumbnail_height,
        thumbnail_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.fileName,
      record.mimeType,
      record.size,
      record.md5,
      record.telegramFileId,
      record.telegramFileUniqueId ?? null,
      record.telegramChannelId ?? "default",
      record.filePath,
      record.remark ?? null,
      record.uploadedBy ?? null,
      record.createdAt,
      record.directoryId ?? null,
      record.directoryPath ?? "/",
      record.storageBackend ?? "telegram_single",
      record.chunkSize ?? null,
      record.chunkCount ?? null,
      record.thumbnailFileId ?? null,
      record.thumbnailFileUniqueId ?? null,
      record.thumbnailFilePath ?? null,
      record.thumbnailMimeType ?? null,
      record.thumbnailSize ?? null,
      record.thumbnailWidth ?? null,
      record.thumbnailHeight ?? null,
      record.thumbnailStatus ?? (record.thumbnailFileId ? "ready" : "none")
    );
}

export function prepareDeleteActiveFileRecordsByName(
  db: AppDatabase,
  directoryPath: string,
  fileName: string,
  excludeId?: string
): AppPreparedStatement[] {
  const whereClause = [
    "deleted_at IS NULL",
    "COALESCE(directory_path, '/') = ?",
    "file_name = ?",
    ...(excludeId ? ["id <> ?"] : [])
  ].join(" AND ");
  const bindings = excludeId ? [directoryPath, fileName, excludeId] : [directoryPath, fileName];

  return [
    db
      .prepare(
        `DELETE FROM file_chunks
        WHERE file_id IN (
          SELECT hls_segments.multipart_upload_id
          FROM hls_segments
          JOIN hls_assets ON hls_assets.id = hls_segments.asset_id
          WHERE hls_assets.final_file_id IN (SELECT id FROM files WHERE ${whereClause})
            AND hls_segments.multipart_upload_id IS NOT NULL
        )`
      )
      .bind(...bindings),
    db
      .prepare(
        `DELETE FROM multipart_uploads
        WHERE id IN (
          SELECT hls_segments.multipart_upload_id
          FROM hls_segments
          JOIN hls_assets ON hls_assets.id = hls_segments.asset_id
          WHERE hls_assets.final_file_id IN (SELECT id FROM files WHERE ${whereClause})
            AND hls_segments.multipart_upload_id IS NOT NULL
        )`
      )
      .bind(...bindings),
    db
      .prepare(
        `DELETE FROM hls_segments
        WHERE asset_id IN (
          SELECT hls_assets.id
          FROM hls_assets
          WHERE hls_assets.final_file_id IN (SELECT id FROM files WHERE ${whereClause})
        )`
      )
      .bind(...bindings),
    db
      .prepare(
        `DELETE FROM hls_assets
        WHERE final_file_id IN (SELECT id FROM files WHERE ${whereClause})`
      )
      .bind(...bindings),
    db
      .prepare(`DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM files WHERE ${whereClause})`)
      .bind(...bindings),
    db
      .prepare(`DELETE FROM multipart_uploads WHERE id IN (SELECT id FROM files WHERE ${whereClause})`)
      .bind(...bindings),
    db
      .prepare(`DELETE FROM files WHERE ${whereClause}`)
      .bind(...bindings)
  ];
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
