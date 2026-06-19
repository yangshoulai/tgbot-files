import type { AppDatabase, AppPreparedStatement } from "../runtime";
import type {
  FileNameConflictAction,
  MultipartCleanupResult,
  MultipartUploadRecord,
  NewFileRecord,
  NewMultipartUploadRecord
} from "./types";
import { prepareDeleteActiveFileRecordsByName, prepareInsertFileRecord } from "./shared";

export async function insertMultipartUploadRecord(
  db: AppDatabase,
  record: NewMultipartUploadRecord
): Promise<MultipartUploadRecord> {
  await db
    .prepare(
      `INSERT INTO multipart_uploads (
        id,
        source_kind,
        source_url,
        source_headers_json,
        source_range_start,
        file_name,
        mime_type,
        size,
        chunk_size,
        chunk_count,
        remark,
        uploaded_by,
        created_at,
        directory_id,
        directory_path,
        telegram_channel_group,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(
      record.id,
      record.sourceKind,
      record.sourceUrl ?? null,
      record.sourceHeadersJson ?? null,
      record.sourceRangeStart ?? null,
      record.fileName,
      record.mimeType,
      record.size,
      record.chunkSize,
      record.chunkCount,
      record.remark ?? null,
      record.uploadedBy ?? null,
      record.createdAt,
      record.directoryId ?? null,
      record.directoryPath ?? "/",
      record.telegramChannelGroup ?? "default"
    )
    .run();

  return {
    id: record.id,
    source_kind: record.sourceKind,
    source_url: record.sourceUrl ?? null,
    source_headers_json: record.sourceHeadersJson ?? null,
    source_range_start: record.sourceRangeStart ?? null,
    file_name: record.fileName,
    mime_type: record.mimeType,
    size: record.size,
    chunk_size: record.chunkSize,
    chunk_count: record.chunkCount,
    remark: record.remark ?? null,
    uploaded_by: record.uploadedBy ?? null,
    created_at: record.createdAt,
    directory_id: record.directoryId ?? null,
    directory_path: record.directoryPath ?? "/",
    telegram_channel_group: record.telegramChannelGroup ?? "default",
    completed_at: null
  };
}

export async function getMultipartUploadRecord(db: AppDatabase, id: string): Promise<MultipartUploadRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        source_kind,
        source_url,
        source_headers_json,
        source_range_start,
        file_name,
        mime_type,
        size,
        chunk_size,
        chunk_count,
        remark,
        uploaded_by,
        created_at,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        COALESCE(telegram_channel_group, 'default') AS telegram_channel_group,
        completed_at
      FROM multipart_uploads
      WHERE id = ? AND completed_at IS NULL`
    )
    .bind(id)
    .first<MultipartUploadRecord>();
}

export async function listIncompleteMultipartUploadRecords(db: AppDatabase, limit = 100): Promise<MultipartUploadRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        source_kind,
        source_url,
        source_headers_json,
        source_range_start,
        file_name,
        mime_type,
        size,
        chunk_size,
        chunk_count,
        remark,
        uploaded_by,
        created_at,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        COALESCE(telegram_channel_group, 'default') AS telegram_channel_group,
        completed_at
      FROM multipart_uploads
      WHERE completed_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?`
    )
    .bind(limit)
    .all<MultipartUploadRecord>();

  return result.results ?? [];
}

export async function completeMultipartUploadRecord(
  db: AppDatabase,
  id: string,
  completedAt: string
): Promise<void> {
  await prepareCompleteMultipartUploadRecord(db, id, completedAt).run();
}

export async function updateMultipartUploadDirectory(params: {
  db: AppDatabase;
  id: string;
  directoryId: string | null;
  directoryPath: string;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE multipart_uploads
      SET directory_id = ?, directory_path = ?
      WHERE id = ? AND completed_at IS NULL`
    )
    .bind(params.directoryId, params.directoryPath, params.id)
    .run();
}

function prepareCompleteMultipartUploadRecord(
  db: AppDatabase,
  id: string,
  completedAt: string
): AppPreparedStatement {
  return db
    .prepare("UPDATE multipart_uploads SET completed_at = ?, source_headers_json = NULL WHERE id = ? AND completed_at IS NULL")
    .bind(completedAt, id);
}

export async function completeMultipartUploadWithFileRecord(params: {
  db: AppDatabase;
  file: NewFileRecord;
  uploadId: string;
  completedAt: string;
  conflictAction?: FileNameConflictAction;
}): Promise<void> {
  await params.db.batch([
    ...(params.conflictAction === "overwrite"
      ? prepareDeleteActiveFileRecordsByName(
          params.db,
          params.file.directoryPath ?? "/",
          params.file.fileName,
          params.file.id
        )
      : []),
    prepareInsertFileRecord(params.db, params.file),
    prepareCompleteMultipartUploadRecord(params.db, params.uploadId, params.completedAt)
  ]);
}

export async function deleteStaleMultipartUploadData(
  db: AppDatabase,
  expiredBefore: string
): Promise<MultipartCleanupResult> {
  const [chunkResult, uploadResult] = await db.batch([
    db
      .prepare(
        `DELETE FROM file_chunks
        WHERE file_id IN (
          SELECT multipart_uploads.id FROM multipart_uploads
          WHERE multipart_uploads.completed_at IS NULL
            AND multipart_uploads.created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM files
              WHERE files.id = multipart_uploads.id
            )
        )`
      )
      .bind(expiredBefore),
    db
      .prepare(
        `DELETE FROM multipart_uploads
        WHERE completed_at IS NULL
          AND created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM files
            WHERE files.id = multipart_uploads.id
          )`
      )
      .bind(expiredBefore)
  ]);

  return {
    deletedChunks: Number(chunkResult?.meta.changes ?? 0),
    deletedUploads: Number(uploadResult?.meta.changes ?? 0)
  };
}
