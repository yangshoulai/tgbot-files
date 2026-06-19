import { AppError } from "../utils/http";
import type { AppDatabase } from "../runtime";
import type {
  FileNameConflictAction,
  HlsAssetRecord,
  HlsAssetStatus,
  HlsCleanupResult,
  HlsSegmentRecord,
  NewFileRecord,
  NewHlsAssetRecord,
  NewHlsSegmentRecord
} from "./types";
import { prepareDeleteActiveFileRecordsByName, prepareInsertFileRecord } from "./shared";

export async function insertHlsAssetRecord(db: AppDatabase, record: NewHlsAssetRecord): Promise<HlsAssetRecord> {
  await db
    .prepare(
      `INSERT INTO hls_assets (
        id,
        source_url,
        source_headers_json,
        media_playlist_url,
        file_name,
        mime_type,
        directory_id,
        directory_path,
        status,
        selected_variant_id,
        target_duration_seconds,
        duration_seconds,
        segment_count,
        estimated_size,
        playlist_text,
        init_source_url,
        init_byte_range_start,
        init_byte_range_length,
        init_mime_type,
        init_status,
        remark,
        uploaded_by,
        created_at,
        updated_at,
        completed_at,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      record.id,
      record.sourceUrl,
      record.sourceHeadersJson ?? null,
      record.mediaPlaylistUrl,
      record.fileName,
      record.mimeType,
      record.directoryId ?? null,
      record.directoryPath,
      record.status,
      record.selectedVariantId ?? null,
      record.targetDurationSeconds,
      record.durationSeconds,
      record.segmentCount,
      record.estimatedSize ?? null,
      record.playlistText,
      record.initSourceUrl ?? null,
      record.initByteRangeStart ?? null,
      record.initByteRangeLength ?? null,
      record.initMimeType ?? null,
      record.initSourceUrl ? "pending" : "none",
      record.remark ?? null,
      record.uploadedBy ?? null,
      record.createdAt,
      record.updatedAt
    )
    .run();

  const created = await getHlsAssetRecord(db, record.id);
  if (!created) {
    throw new AppError(500, "HlsAssetCreateFailed", "HLS asset was not created");
  }
  return created;
}

export async function insertHlsSegmentRecords(db: AppDatabase, records: NewHlsSegmentRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await db.batch(records.map((record) =>
    db
      .prepare(
        `INSERT INTO hls_segments (
          id,
          asset_id,
          variant_id,
          segment_index,
          source_url,
          byte_range_start,
          byte_range_length,
          duration_seconds,
          mime_type,
          size,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.assetId,
        record.variantId,
        record.segmentIndex,
        record.sourceUrl,
        record.byteRangeStart ?? null,
        record.byteRangeLength ?? null,
        record.durationSeconds,
        record.mimeType,
        record.size ?? null,
        record.status,
        record.createdAt,
        record.updatedAt
      )
  ));
}

export async function getHlsAssetRecord(db: AppDatabase, id: string): Promise<HlsAssetRecord | null> {
  return db
    .prepare(
      `SELECT
        id,
        source_url,
        source_headers_json,
        media_playlist_url,
        file_name,
        mime_type,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        status,
        selected_variant_id,
        target_duration_seconds,
        duration_seconds,
        segment_count,
        estimated_size,
        playlist_text,
        playlist_file_id,
        final_file_id,
        init_source_url,
        init_byte_range_start,
        init_byte_range_length,
        init_mime_type,
        init_size,
        init_storage_backend,
        init_telegram_file_id,
        init_telegram_file_unique_id,
        COALESCE(init_telegram_channel_id, 'default') AS init_telegram_channel_id,
        COALESCE(init_status, 'none') AS init_status,
        init_error_message,
        init_completed_at,
        COALESCE(thumbnail_status, 'none') AS thumbnail_status,
        remark,
        uploaded_by,
        created_at,
        updated_at,
        completed_at,
        deleted_at
      FROM hls_assets
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .first<HlsAssetRecord>();
}

export async function listIncompleteHlsAssetRecords(db: AppDatabase, limit = 100): Promise<HlsAssetRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        source_url,
        source_headers_json,
        media_playlist_url,
        file_name,
        mime_type,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        status,
        selected_variant_id,
        target_duration_seconds,
        duration_seconds,
        segment_count,
        estimated_size,
        playlist_text,
        playlist_file_id,
        final_file_id,
        init_source_url,
        init_byte_range_start,
        init_byte_range_length,
        init_mime_type,
        init_size,
        init_storage_backend,
        init_telegram_file_id,
        init_telegram_file_unique_id,
        COALESCE(init_telegram_channel_id, 'default') AS init_telegram_channel_id,
        COALESCE(init_status, 'none') AS init_status,
        init_error_message,
        init_completed_at,
        COALESCE(thumbnail_status, 'none') AS thumbnail_status,
        remark,
        uploaded_by,
        created_at,
        updated_at,
        completed_at,
        deleted_at
      FROM hls_assets
      WHERE deleted_at IS NULL
        AND final_file_id IS NULL
        AND status IN ('pending', 'importing', 'failed')
      ORDER BY updated_at DESC
      LIMIT ?`
    )
    .bind(limit)
    .all<HlsAssetRecord>();

  return result.results ?? [];
}

export async function getHlsAssetRecordByFinalFileId(db: AppDatabase, finalFileId: string): Promise<HlsAssetRecord | null> {
  return db
    .prepare(
      `SELECT
        id,
        source_url,
        source_headers_json,
        media_playlist_url,
        file_name,
        mime_type,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        status,
        selected_variant_id,
        target_duration_seconds,
        duration_seconds,
        segment_count,
        estimated_size,
        playlist_text,
        playlist_file_id,
        final_file_id,
        init_source_url,
        init_byte_range_start,
        init_byte_range_length,
        init_mime_type,
        init_size,
        init_storage_backend,
        init_telegram_file_id,
        init_telegram_file_unique_id,
        COALESCE(init_telegram_channel_id, 'default') AS init_telegram_channel_id,
        COALESCE(init_status, 'none') AS init_status,
        init_error_message,
        init_completed_at,
        COALESCE(thumbnail_status, 'none') AS thumbnail_status,
        remark,
        uploaded_by,
        created_at,
        updated_at,
        completed_at,
        deleted_at
      FROM hls_assets
      WHERE final_file_id = ? AND deleted_at IS NULL
      LIMIT 1`
    )
    .bind(finalFileId)
    .first<HlsAssetRecord>();
}

export async function listHlsSegmentRecords(db: AppDatabase, assetId: string): Promise<HlsSegmentRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        asset_id,
        variant_id,
        segment_index,
        source_url,
        byte_range_start,
        byte_range_length,
        duration_seconds,
        mime_type,
        size,
        storage_backend,
        telegram_file_id,
        telegram_file_unique_id,
        COALESCE(telegram_channel_id, 'default') AS telegram_channel_id,
        multipart_upload_id,
        chunk_size,
        chunk_count,
        status,
        attempts,
        error_message,
        created_at,
        updated_at,
        completed_at
      FROM hls_segments
      WHERE asset_id = ?
      ORDER BY segment_index ASC`
    )
    .bind(assetId)
    .all<HlsSegmentRecord>();

  return result.results ?? [];
}

export async function getHlsSegmentRecordByIndex(
  db: AppDatabase,
  assetId: string,
  segmentIndex: number
): Promise<HlsSegmentRecord | null> {
  return db
    .prepare(
      `SELECT
        id,
        asset_id,
        variant_id,
        segment_index,
        source_url,
        byte_range_start,
        byte_range_length,
        duration_seconds,
        mime_type,
        size,
        storage_backend,
        telegram_file_id,
        telegram_file_unique_id,
        COALESCE(telegram_channel_id, 'default') AS telegram_channel_id,
        multipart_upload_id,
        chunk_size,
        chunk_count,
        status,
        attempts,
        error_message,
        created_at,
        updated_at,
        completed_at
      FROM hls_segments
      WHERE asset_id = ? AND segment_index = ?
      LIMIT 1`
    )
    .bind(assetId, segmentIndex)
    .first<HlsSegmentRecord>();
}

export async function markHlsAssetStatus(
  db: AppDatabase,
  id: string,
  status: HlsAssetStatus,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE hls_assets
      SET status = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(status, updatedAt, id)
    .run();
}

export async function markHlsSegmentImporting(
  db: AppDatabase,
  id: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE hls_segments
      SET status = 'importing',
        attempts = attempts + 1,
        error_message = NULL,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(updatedAt, id)
    .run();
}

export async function markHlsInitSegmentImporting(
  db: AppDatabase,
  assetId: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE hls_assets
      SET init_status = 'importing',
        init_error_message = NULL,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(updatedAt, assetId)
    .run();
}

export async function completeHlsInitSegmentSingle(params: {
  db: AppDatabase;
  assetId: string;
  mimeType: string;
  size: number;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  telegramChannelId?: string;
  completedAt: string;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE hls_assets
      SET init_status = 'done',
        init_mime_type = ?,
        init_size = ?,
        init_storage_backend = 'telegram_single',
        init_telegram_file_id = ?,
        init_telegram_file_unique_id = ?,
        init_telegram_channel_id = ?,
        init_error_message = NULL,
        updated_at = ?,
        init_completed_at = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(
      params.mimeType,
      params.size,
      params.telegramFileId,
      params.telegramFileUniqueId ?? null,
      params.telegramChannelId ?? "default",
      params.completedAt,
      params.completedAt,
      params.assetId
    )
    .run();
}

export async function completeHlsSegmentSingle(params: {
  db: AppDatabase;
  id: string;
  mimeType: string;
  size: number;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  telegramChannelId?: string;
  completedAt: string;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE hls_segments
      SET status = 'done',
        mime_type = ?,
        size = ?,
        storage_backend = 'telegram_single',
        telegram_file_id = ?,
        telegram_file_unique_id = ?,
        telegram_channel_id = ?,
        multipart_upload_id = NULL,
        chunk_size = NULL,
        chunk_count = NULL,
        error_message = NULL,
        updated_at = ?,
        completed_at = ?
      WHERE id = ?`
    )
    .bind(
      params.mimeType,
      params.size,
      params.telegramFileId,
      params.telegramFileUniqueId ?? null,
      params.telegramChannelId ?? "default",
      params.completedAt,
      params.completedAt,
      params.id
    )
    .run();
}

export async function attachHlsSegmentMultipartUpload(params: {
  db: AppDatabase;
  id: string;
  multipartUploadId: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  updatedAt: string;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE hls_segments
      SET storage_backend = 'telegram_multipart',
        mime_type = ?,
        multipart_upload_id = ?,
        size = ?,
        chunk_size = ?,
        chunk_count = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      params.mimeType,
      params.multipartUploadId,
      params.size,
      params.chunkSize,
      params.chunkCount,
      params.updatedAt,
      params.id
    )
    .run();
}

export async function completeHlsSegmentMultipart(params: {
  db: AppDatabase;
  id: string;
  multipartUploadId: string;
  chunkSize: number;
  chunkCount: number;
  completedAt: string;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE hls_segments
      SET status = 'done',
        storage_backend = 'telegram_multipart',
        multipart_upload_id = ?,
        chunk_size = ?,
        chunk_count = ?,
        error_message = NULL,
        updated_at = ?,
        completed_at = ?
      WHERE id = ?`
    )
    .bind(
      params.multipartUploadId,
      params.chunkSize,
      params.chunkCount,
      params.completedAt,
      params.completedAt,
      params.id
    )
    .run();
}

export async function failHlsSegment(
  db: AppDatabase,
  id: string,
  message: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE hls_segments
      SET status = 'failed',
        error_message = ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(message.slice(0, 1000), updatedAt, id)
    .run();
}

export async function failHlsInitSegment(
  db: AppDatabase,
  assetId: string,
  message: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE hls_assets
      SET init_status = 'failed',
        init_error_message = ?,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(message.slice(0, 1000), updatedAt, assetId)
    .run();
}

export async function completeHlsAssetWithFileRecord(params: {
  db: AppDatabase;
  assetId: string;
  file: NewFileRecord;
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
    params.db
      .prepare(
        `UPDATE hls_assets
        SET status = 'done',
          final_file_id = ?,
          source_headers_json = NULL,
          updated_at = ?,
          completed_at = ?
        WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(params.file.id, params.completedAt, params.completedAt, params.assetId)
  ]);
}

export async function deleteHlsAssetTempData(
  db: AppDatabase,
  assetId: string
): Promise<HlsCleanupResult> {
  const [chunkResult, uploadResult, segmentResult, assetResult] = await db.batch([
    db
      .prepare(
        `DELETE FROM file_chunks
        WHERE file_id IN (
          SELECT multipart_upload_id
          FROM hls_segments
          WHERE asset_id = ? AND multipart_upload_id IS NOT NULL
        )`
      )
      .bind(assetId),
    db
      .prepare(
        `DELETE FROM multipart_uploads
        WHERE id IN (
          SELECT multipart_upload_id
          FROM hls_segments
          WHERE asset_id = ? AND multipart_upload_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM files WHERE files.id = multipart_uploads.id
        )`
      )
      .bind(assetId),
    db.prepare("DELETE FROM hls_segments WHERE asset_id = ?").bind(assetId),
    db
      .prepare(
        `DELETE FROM hls_assets
        WHERE id = ? AND final_file_id IS NULL`
      )
      .bind(assetId)
  ]);

  return {
    deletedChunks: Number(chunkResult?.meta.changes ?? 0),
    deletedUploads: Number(uploadResult?.meta.changes ?? 0),
    deletedSegments: Number(segmentResult?.meta.changes ?? 0),
    deletedAssets: Number(assetResult?.meta.changes ?? 0)
  };
}

export async function deleteStaleHlsUploadData(
  db: AppDatabase,
  expiredBefore: string
): Promise<HlsCleanupResult> {
  const [chunkResult, uploadResult, segmentResult, assetResult] = await db.batch([
    db
      .prepare(
        `DELETE FROM file_chunks
        WHERE file_id IN (
          SELECT hls_segments.multipart_upload_id
          FROM hls_segments
          JOIN hls_assets ON hls_assets.id = hls_segments.asset_id
          WHERE hls_assets.final_file_id IS NULL
            AND hls_assets.created_at < ?
            AND hls_segments.multipart_upload_id IS NOT NULL
        )`
      )
      .bind(expiredBefore),
    db
      .prepare(
        `DELETE FROM multipart_uploads
        WHERE id IN (
          SELECT hls_segments.multipart_upload_id
          FROM hls_segments
          JOIN hls_assets ON hls_assets.id = hls_segments.asset_id
          WHERE hls_assets.final_file_id IS NULL
            AND hls_assets.created_at < ?
            AND hls_segments.multipart_upload_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM files WHERE files.id = multipart_uploads.id
        )`
      )
      .bind(expiredBefore),
    db
      .prepare(
        `DELETE FROM hls_segments
        WHERE asset_id IN (
          SELECT id
          FROM hls_assets
          WHERE final_file_id IS NULL
            AND created_at < ?
        )`
      )
      .bind(expiredBefore),
    db
      .prepare(
        `DELETE FROM hls_assets
        WHERE final_file_id IS NULL
          AND created_at < ?`
      )
      .bind(expiredBefore)
  ]);

  return {
    deletedChunks: Number(chunkResult?.meta.changes ?? 0),
    deletedUploads: Number(uploadResult?.meta.changes ?? 0),
    deletedSegments: Number(segmentResult?.meta.changes ?? 0),
    deletedAssets: Number(assetResult?.meta.changes ?? 0)
  };
}
