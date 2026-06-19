import { AppError } from "../utils/http";
import type { AppDatabase } from "../runtime";
import type {
  MagnetImportFileRecord,
  MagnetImportFileStatus,
  MagnetImportRecord,
  NewMagnetImportFileRecord,
  NewMagnetImportRecord
} from "./types";

export async function insertMagnetImportRecord(
  db: AppDatabase,
  record: NewMagnetImportRecord
): Promise<MagnetImportRecord> {
  await db
    .prepare(
      `INSERT INTO magnet_imports (
        id,
        magnet_uri,
        info_hash,
        status,
        aria2_metadata_gid,
        download_dir,
        uploaded_by,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'probing', ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.magnetUri,
      record.infoHash ?? null,
      record.aria2MetadataGid,
      record.downloadDir,
      record.uploadedBy ?? null,
      record.createdAt,
      record.updatedAt
    )
    .run();

  const created = await getMagnetImportRecord(db, record.id);
  if (!created) {
    throw new AppError(500, "MagnetImportCreateFailed", "Magnet import task was not created");
  }
  return created;
}

export async function getMagnetImportRecord(db: AppDatabase, id: string): Promise<MagnetImportRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        magnet_uri,
        info_hash,
        name,
        status,
        aria2_metadata_gid,
        aria2_download_gid,
        download_dir,
        selected_indexes_json,
        file_count,
        total_size,
        error_message,
        uploaded_by,
        created_at,
        updated_at,
        metadata_completed_at,
        download_started_at,
        download_completed_at,
        completed_at,
        cancelled_at
      FROM magnet_imports
      WHERE id = ?`
    )
    .bind(id)
    .first<MagnetImportRecord>();
}

export async function listIncompleteMagnetImportRecords(db: AppDatabase, limit = 100): Promise<MagnetImportRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        magnet_uri,
        info_hash,
        name,
        status,
        aria2_metadata_gid,
        aria2_download_gid,
        download_dir,
        selected_indexes_json,
        file_count,
        total_size,
        error_message,
        uploaded_by,
        created_at,
        updated_at,
        metadata_completed_at,
        download_started_at,
        download_completed_at,
        completed_at,
        cancelled_at
      FROM magnet_imports
      WHERE completed_at IS NULL
        AND status IN ('probing', 'ready', 'downloading', 'downloaded', 'importing', 'failed')
      ORDER BY updated_at DESC
      LIMIT ?`
    )
    .bind(limit)
    .all<MagnetImportRecord>();

  return result.results ?? [];
}

export async function findReusableMagnetImportRecord(
  db: AppDatabase,
  magnetUri: string,
  infoHash: string | null
): Promise<MagnetImportRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        magnet_uri,
        info_hash,
        name,
        status,
        aria2_metadata_gid,
        aria2_download_gid,
        download_dir,
        selected_indexes_json,
        file_count,
        total_size,
        error_message,
        uploaded_by,
        created_at,
        updated_at,
        metadata_completed_at,
        download_started_at,
        download_completed_at,
        completed_at,
        cancelled_at
      FROM magnet_imports
      WHERE status IN ('probing', 'ready', 'downloading', 'downloaded', 'importing')
        AND (magnet_uri = ? OR (? IS NOT NULL AND info_hash = ?))
      ORDER BY updated_at DESC
      LIMIT 1`
    )
    .bind(magnetUri, infoHash, infoHash)
    .first<MagnetImportRecord>();
}

export async function listRestartableMagnetImportRecordsBySource(
  db: AppDatabase,
  magnetUri: string,
  infoHash: string | null
): Promise<MagnetImportRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        magnet_uri,
        info_hash,
        name,
        status,
        aria2_metadata_gid,
        aria2_download_gid,
        download_dir,
        selected_indexes_json,
        file_count,
        total_size,
        error_message,
        uploaded_by,
        created_at,
        updated_at,
        metadata_completed_at,
        download_started_at,
        download_completed_at,
        completed_at,
        cancelled_at
      FROM magnet_imports
      WHERE status IN ('failed', 'cancelled')
        AND (magnet_uri = ? OR (? IS NOT NULL AND info_hash = ?))
      ORDER BY updated_at DESC`
    )
    .bind(magnetUri, infoHash, infoHash)
    .all<MagnetImportRecord>();

  return result.results ?? [];
}

export async function listMagnetImportRecordsForAria2Cleanup(
  db: AppDatabase,
  expiredBefore: string
): Promise<MagnetImportRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        magnet_uri,
        info_hash,
        name,
        status,
        aria2_metadata_gid,
        aria2_download_gid,
        download_dir,
        selected_indexes_json,
        file_count,
        total_size,
        error_message,
        uploaded_by,
        created_at,
        updated_at,
        metadata_completed_at,
        download_started_at,
        download_completed_at,
        completed_at,
        cancelled_at
      FROM magnet_imports
      WHERE status IN ('done', 'failed', 'cancelled', 'downloaded')
        AND updated_at <= ?
      ORDER BY updated_at ASC`
    )
    .bind(expiredBefore)
    .all<MagnetImportRecord>();

  return result.results ?? [];
}

export async function listProtectedMagnetImportRecordsForAria2Cleanup(
  db: AppDatabase,
  expiredBefore: string
): Promise<MagnetImportRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        magnet_uri,
        info_hash,
        name,
        status,
        aria2_metadata_gid,
        aria2_download_gid,
        download_dir,
        selected_indexes_json,
        file_count,
        total_size,
        error_message,
        uploaded_by,
        created_at,
        updated_at,
        metadata_completed_at,
        download_started_at,
        download_completed_at,
        completed_at,
        cancelled_at
      FROM magnet_imports
      WHERE status IN ('probing', 'ready', 'downloading', 'importing')
        OR (status = 'downloaded' AND updated_at > ?)`
    )
    .bind(expiredBefore)
    .all<MagnetImportRecord>();

  return result.results ?? [];
}

export async function listMagnetImportFileRecords(db: AppDatabase, importId: string): Promise<MagnetImportFileRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        import_id,
        file_index,
        path,
        file_name,
        relative_directory_path,
        size,
        mime_type,
        chunk_size,
        chunk_count,
        upload_id,
        selected,
        status,
        error_message,
        created_at,
        updated_at
      FROM magnet_import_files
      WHERE import_id = ?
      ORDER BY file_index ASC`
    )
    .bind(importId)
    .all<MagnetImportFileRecord>();

  return result.results ?? [];
}

export async function getMagnetImportFileRecord(
  db: AppDatabase,
  importId: string,
  fileIndex: number
): Promise<MagnetImportFileRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        import_id,
        file_index,
        path,
        file_name,
        relative_directory_path,
        size,
        mime_type,
        chunk_size,
        chunk_count,
        upload_id,
        selected,
        status,
        error_message,
        created_at,
        updated_at
      FROM magnet_import_files
      WHERE import_id = ? AND file_index = ?`
    )
    .bind(importId, fileIndex)
    .first<MagnetImportFileRecord>();
}

export async function replaceMagnetImportFiles(
  db: AppDatabase,
  importId: string,
  files: NewMagnetImportFileRecord[],
  metadata: {
    infoHash?: string | null;
    name?: string | null;
    totalSize: number;
    updatedAt: string;
  }
): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM magnet_import_files WHERE import_id = ?")
      .bind(importId),
    ...files.map((file) =>
      db
        .prepare(
          `INSERT INTO magnet_import_files (
            id,
            import_id,
            file_index,
            path,
            file_name,
            relative_directory_path,
            size,
            mime_type,
            chunk_size,
            chunk_count,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .bind(
          file.id,
          file.importId,
          file.fileIndex,
          file.path,
          file.fileName,
          file.relativeDirectoryPath ?? null,
          file.size,
          file.mimeType,
          file.chunkSize,
          file.chunkCount,
          file.createdAt,
          file.updatedAt
        )
    ),
    db
      .prepare(
        `UPDATE magnet_imports
        SET status = 'ready',
          info_hash = ?,
          name = ?,
          file_count = ?,
          total_size = ?,
          error_message = NULL,
          updated_at = ?,
          metadata_completed_at = COALESCE(metadata_completed_at, ?)
        WHERE id = ?`
      )
      .bind(
        metadata.infoHash ?? null,
        metadata.name ?? null,
        files.length,
        metadata.totalSize,
        metadata.updatedAt,
        metadata.updatedAt,
        importId
      )
  ]);
}

export async function markMagnetImportFailed(
  db: AppDatabase,
  id: string,
  errorMessage: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare("UPDATE magnet_imports SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?")
    .bind(errorMessage, updatedAt, id)
    .run();
}

export async function markMagnetImportDownloading(params: {
  db: AppDatabase;
  id: string;
  aria2DownloadGid: string;
  selectedIndexesJson: string;
  updatedAt: string;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE magnet_imports
      SET status = 'downloading',
        aria2_download_gid = ?,
        selected_indexes_json = ?,
        updated_at = ?,
        download_started_at = COALESCE(download_started_at, ?)
      WHERE id = ?`
    )
    .bind(
      params.aria2DownloadGid,
      params.selectedIndexesJson,
      params.updatedAt,
      params.updatedAt,
      params.id
    )
    .run();
}

export async function markMagnetImportDownloaded(
  db: AppDatabase,
  id: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE magnet_imports
      SET status = 'downloaded',
        updated_at = ?,
        download_completed_at = COALESCE(download_completed_at, ?)
      WHERE id = ?`
    )
    .bind(updatedAt, updatedAt, id)
    .run();
}

export async function markMagnetImportImporting(
  db: AppDatabase,
  id: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare("UPDATE magnet_imports SET status = 'importing', updated_at = ? WHERE id = ? AND status <> 'done'")
    .bind(updatedAt, id)
    .run();
}

export async function markMagnetImportDoneIfComplete(
  db: AppDatabase,
  id: string,
  updatedAt: string
): Promise<void> {
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM magnet_import_files
      WHERE import_id = ? AND selected = 1 AND status <> 'done'`
    )
    .bind(id)
    .first<{ total: number }>();

  if ((pending?.total ?? 0) > 0) {
    return;
  }

  await db
    .prepare(
      `UPDATE magnet_imports
      SET status = 'done',
        updated_at = ?,
        completed_at = COALESCE(completed_at, ?)
      WHERE id = ?`
    )
    .bind(updatedAt, updatedAt, id)
    .run();
}

export async function cancelMagnetImportRecord(
  db: AppDatabase,
  id: string,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE magnet_imports
      SET status = 'cancelled',
        updated_at = ?,
        cancelled_at = COALESCE(cancelled_at, ?)
      WHERE id = ? AND status NOT IN ('done', 'cancelled')`
    )
    .bind(updatedAt, updatedAt, id)
    .run();
}

export async function selectMagnetImportFiles(params: {
  db: AppDatabase;
  importId: string;
  fileIndexes: number[];
  uploadByFileIndex: Map<number, string>;
  updatedAt: string;
}): Promise<void> {
  const selected = new Set(params.fileIndexes);
  const existing = await listMagnetImportFileRecords(params.db, params.importId);
  const statements = existing.map((file) => {
    const isSelected = selected.has(file.file_index);
    return params.db
      .prepare(
        `UPDATE magnet_import_files
        SET selected = ?,
          upload_id = ?,
          status = ?,
          error_message = NULL,
          updated_at = ?
        WHERE import_id = ? AND file_index = ?`
      )
      .bind(
        isSelected ? 1 : 0,
        isSelected ? params.uploadByFileIndex.get(file.file_index) ?? null : null,
        isSelected ? "selected" : "pending",
        params.updatedAt,
        params.importId,
        file.file_index
      );
  });

  if (statements.length > 0) {
    await params.db.batch(statements);
  }
}

export async function updateMagnetImportFileStatus(params: {
  db: AppDatabase;
  importId: string;
  fileIndex: number;
  status: MagnetImportFileStatus;
  updatedAt: string;
  errorMessage?: string | null;
}): Promise<void> {
  await params.db
    .prepare(
      `UPDATE magnet_import_files
      SET status = ?,
        error_message = ?,
        updated_at = ?
      WHERE import_id = ? AND file_index = ?`
    )
    .bind(
      params.status,
      params.errorMessage ?? null,
      params.updatedAt,
      params.importId,
      params.fileIndex
    )
    .run();
}
