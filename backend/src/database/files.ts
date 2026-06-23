import { AppError } from "../utils/http";
import type { AppDatabase } from "../runtime";
import type {
  FileListResult,
  FileNameConflictAction,
  FileNameConflictRecord,
  FileRecord,
  FileTypeFilter,
  FileUsageStats,
  NewFileRecord,
  StorageBackend,
  UpdateFileThumbnailRecord
} from "./types";
import {
  escapeLikePattern,
  placeholders,
  prepareDeleteActiveFileRecordsByName,
  prepareInsertFileRecord
} from "./shared";
import { getDirectoryRecordByPath } from "./directories";

export async function insertFileRecord(db: AppDatabase, record: NewFileRecord): Promise<void> {
  await prepareInsertFileRecord(db, record).run();
}

export async function insertFileRecordWithConflictAction(params: {
  db: AppDatabase;
  record: NewFileRecord;
  conflictAction: FileNameConflictAction;
}): Promise<void> {
  if (params.conflictAction === "overwrite") {
    await params.db.batch([
      ...prepareDeleteActiveFileRecordsByName(
        params.db,
        params.record.directoryPath ?? "/",
        params.record.fileName,
        params.record.id
      ),
      prepareInsertFileRecord(params.db, params.record)
    ]);
    return;
  }

  await insertFileRecord(params.db, params.record);
}

export async function listFileRecords(params: {
  db: AppDatabase;
  query: string;
  type?: FileTypeFilter;
  createdFrom?: string;
  createdTo?: string;
  directoryPath?: string;
  page?: number;
  limit?: number;
}): Promise<FileListResult> {
  const whereParts = ["deleted_at IS NULL"];
  const bindings: Array<number | string> = [];
  const normalizedQuery = params.query.trim().toLowerCase();
  const directoryPath = params.directoryPath ?? "/";

  whereParts.push("COALESCE(directory_path, '/') = ?");
  bindings.push(directoryPath);

  if (normalizedQuery) {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    whereParts.push(
      `(LOWER(file_name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(remark, '')) LIKE ? ESCAPE '\\')`
    );
    bindings.push(pattern, pattern);
  }

  if (params.type) {
    whereParts.push(fileTypeWhereClause(params.type));
  }

  if (params.createdFrom) {
    whereParts.push("created_at >= ?");
    bindings.push(params.createdFrom);
  }

  if (params.createdTo) {
    whereParts.push("created_at <= ?");
    bindings.push(params.createdTo);
  }

  const whereClause = whereParts.join(" AND ");
  const totalRow = await params.db
    .prepare(`SELECT COUNT(*) AS total FROM files WHERE ${whereClause}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const paginationClause = params.limit ? "LIMIT ? OFFSET ?" : "";
  const paginationBindings = params.limit
    ? [params.limit, ((params.page ?? 1) - 1) * params.limit]
    : [];
  const result = await params.db
    .prepare(
      `SELECT
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
        deleted_at,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        COALESCE(storage_backend, 'telegram_single') AS storage_backend,
        chunk_size,
        chunk_count,
        thumbnail_file_id,
        thumbnail_file_unique_id,
        thumbnail_file_path,
        thumbnail_mime_type,
        thumbnail_size,
        thumbnail_width,
        thumbnail_height,
        COALESCE(thumbnail_status, 'none') AS thumbnail_status
      FROM files
      WHERE ${whereClause}
      ORDER BY created_at DESC
      ${paginationClause}`
    )
    .bind(...bindings, ...paginationBindings)
    .all<FileRecord>();

  return {
    files: result.results ?? [],
    total: totalRow?.total ?? 0
  };
}

export async function getFileRecord(db: AppDatabase, id: string): Promise<FileRecord | null> {
  return await db
    .prepare(
      `SELECT
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
        deleted_at,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        COALESCE(storage_backend, 'telegram_single') AS storage_backend,
        chunk_size,
        chunk_count,
        thumbnail_file_id,
        thumbnail_file_unique_id,
        thumbnail_file_path,
        thumbnail_mime_type,
        thumbnail_size,
        thumbnail_width,
        thumbnail_height,
        COALESCE(thumbnail_status, 'none') AS thumbnail_status
      FROM files
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .first<FileRecord>();
}

export async function findActiveFileNameConflict(params: {
  db: AppDatabase;
  directoryPath: string;
  fileName: string;
  excludeId?: string;
}): Promise<FileNameConflictRecord | null> {
  const bindings = [params.directoryPath, params.fileName];
  const excludeClause = params.excludeId ? " AND id <> ?" : "";
  const excludeBindings = params.excludeId ? [params.excludeId] : [];
  const file = await params.db
    .prepare(
      `SELECT id
      FROM files
      WHERE deleted_at IS NULL
        AND COALESCE(directory_path, '/') = ?
        AND file_name = ?
        ${excludeClause}
      LIMIT 1`
    )
    .bind(...bindings, ...excludeBindings)
    .first<{ id: string }>();

  if (file) {
    return { id: file.id, source: "file" };
  }

  return null;
}

export async function deleteFileRecord(db: AppDatabase, id: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT id, COALESCE(storage_backend, 'telegram_single') AS storage_backend FROM files WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ id: string; storage_backend: StorageBackend }>();

  if (!existing) {
    return false;
  }

  if (existing.storage_backend === "hls_package") {
    await db
      .prepare(
        `DELETE FROM file_chunks
        WHERE file_id IN (
          SELECT hls_segments.multipart_upload_id
          FROM hls_segments
          JOIN hls_assets ON hls_assets.id = hls_segments.asset_id
          WHERE hls_assets.final_file_id = ?
            AND hls_segments.multipart_upload_id IS NOT NULL
        )`
      )
      .bind(id)
      .run();
    await db
      .prepare(
        `DELETE FROM multipart_uploads
        WHERE id IN (
          SELECT hls_segments.multipart_upload_id
          FROM hls_segments
          JOIN hls_assets ON hls_assets.id = hls_segments.asset_id
          WHERE hls_assets.final_file_id = ?
            AND hls_segments.multipart_upload_id IS NOT NULL
        )`
      )
      .bind(id)
      .run();
    await db
      .prepare(
        `DELETE FROM hls_segments
        WHERE asset_id IN (
          SELECT id FROM hls_assets WHERE final_file_id = ?
        )`
      )
      .bind(id)
      .run();
    await db.prepare("DELETE FROM hls_assets WHERE final_file_id = ?").bind(id).run();
  }

  await db.prepare("DELETE FROM file_chunks WHERE file_id = ?").bind(id).run();
  await db.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  await db.prepare("DELETE FROM multipart_uploads WHERE id = ?").bind(id).run();
  return true;
}

export async function updateFileRecordMetadata(params: {
  db: AppDatabase;
  id: string;
  fileName: string;
  mimeType: string;
  remark: string | null;
  filePath: string;
}): Promise<FileRecord | null> {
  const existing = await getFileRecord(params.db, params.id);

  if (!existing) {
    return null;
  }

  await params.db
    .prepare(
      `UPDATE files
      SET file_name = ?, mime_type = ?, remark = ?, file_path = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(params.fileName, params.mimeType, params.remark, params.filePath, params.id)
    .run();

  return {
    ...existing,
    file_name: params.fileName,
    mime_type: params.mimeType,
    remark: params.remark,
    file_path: params.filePath
  };
}

export async function updateFileRecordThumbnail(params: {
  db: AppDatabase;
  id: string;
  thumbnail: UpdateFileThumbnailRecord;
}): Promise<FileRecord | null> {
  const existing = await getFileRecord(params.db, params.id);

  if (!existing) {
    return null;
  }

  await params.db
    .prepare(
      `UPDATE files
      SET
        thumbnail_file_id = ?,
        thumbnail_file_unique_id = ?,
        thumbnail_file_path = ?,
        thumbnail_mime_type = ?,
        thumbnail_size = ?,
        thumbnail_width = ?,
        thumbnail_height = ?,
        thumbnail_status = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(
      params.thumbnail.thumbnailFileId,
      params.thumbnail.thumbnailFileUniqueId,
      params.thumbnail.thumbnailFilePath,
      params.thumbnail.thumbnailMimeType,
      params.thumbnail.thumbnailSize,
      params.thumbnail.thumbnailWidth,
      params.thumbnail.thumbnailHeight,
      params.thumbnail.thumbnailStatus,
      params.id
    )
    .run();

  return {
    ...existing,
    thumbnail_file_id: params.thumbnail.thumbnailFileId,
    thumbnail_file_unique_id: params.thumbnail.thumbnailFileUniqueId,
    thumbnail_file_path: params.thumbnail.thumbnailFilePath,
    thumbnail_mime_type: params.thumbnail.thumbnailMimeType,
    thumbnail_size: params.thumbnail.thumbnailSize,
    thumbnail_width: params.thumbnail.thumbnailWidth,
    thumbnail_height: params.thumbnail.thumbnailHeight,
    thumbnail_status: params.thumbnail.thumbnailStatus
  };
}

export async function getGlobalFileUsageStats(db: AppDatabase): Promise<FileUsageStats> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
      FROM files
      WHERE deleted_at IS NULL`
    )
    .first<FileUsageStats>();

  return {
    file_count: row?.file_count ?? 0,
    total_size: row?.total_size ?? 0
  };
}

export async function moveFileRecords(params: {
  db: AppDatabase;
  ids: string[];
  directoryPath: string;
}): Promise<number> {
  const ids = Array.from(new Set(params.ids)).filter(Boolean);

  if (ids.length === 0) {
    return 0;
  }

  const directory = params.directoryPath === "/" ? null : await getDirectoryRecordByPath(params.db, params.directoryPath);

  if (params.directoryPath !== "/" && !directory) {
    throw new AppError(404, "DirectoryNotFound", "Target directory not found");
  }

  const inClause = placeholders(ids.length);
  const existing = await params.db
    .prepare(`SELECT COUNT(*) AS total FROM files WHERE deleted_at IS NULL AND id IN (${inClause})`)
    .bind(...ids)
    .first<{ total: number }>();

  await params.db
    .prepare(
      `UPDATE files
      SET directory_id = ?, directory_path = ?
      WHERE deleted_at IS NULL AND id IN (${inClause})`
    )
    .bind(directory?.id ?? null, params.directoryPath, ...ids)
    .run();

  return existing?.total ?? 0;
}

function fileTypeWhereClause(type: FileTypeFilter): string {
  const image = "LOWER(mime_type) LIKE 'image/%'";
  const video = [
    "LOWER(mime_type) LIKE 'video/%'",
    "LOWER(mime_type) IN ('application/vnd.apple.mpegurl', 'application/x-mpegurl')",
    "LOWER(file_name) LIKE '%.mp4'",
    "LOWER(file_name) LIKE '%.m4v'",
    "LOWER(file_name) LIKE '%.mov'",
    "LOWER(file_name) LIKE '%.webm'",
    "LOWER(file_name) LIKE '%.ogv'",
    "LOWER(file_name) LIKE '%.m3u8'"
  ].join(" OR ");
  const text = [
    "LOWER(mime_type) LIKE 'text/%'",
    "LOWER(mime_type) IN ('application/json', 'application/xml', 'application/yaml', 'application/x-yaml')",
    "LOWER(file_name) LIKE '%.json'",
    "LOWER(file_name) LIKE '%.xml'",
    "LOWER(file_name) LIKE '%.yaml'",
    "LOWER(file_name) LIKE '%.yml'",
    "LOWER(file_name) LIKE '%.md'",
    "LOWER(file_name) LIKE '%.markdown'",
    "LOWER(file_name) LIKE '%.log'"
  ].join(" OR ");
  const pdf = "LOWER(mime_type) = 'application/pdf' OR LOWER(file_name) LIKE '%.pdf'";
  const archive = [
    "LOWER(mime_type) IN ('application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/gzip', 'application/x-tar')",
    "LOWER(file_name) LIKE '%.zip'",
    "LOWER(file_name) LIKE '%.rar'",
    "LOWER(file_name) LIKE '%.7z'",
    "LOWER(file_name) LIKE '%.tar'",
    "LOWER(file_name) LIKE '%.gz'"
  ].join(" OR ");

  switch (type) {
    case "image":
      return `(${image})`;
    case "video":
      return `(${video})`;
    case "text":
      return `(${text})`;
    case "pdf":
      return `(${pdf})`;
    case "archive":
      return `(${archive})`;
    case "other":
      return `NOT (${image} OR ${video} OR ${text} OR ${pdf} OR ${archive})`;
  }
}
