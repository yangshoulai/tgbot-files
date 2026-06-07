import { AppError } from "./http";
import type { AppDatabase, AppPreparedStatement } from "./runtime";

export type StorageBackend = "telegram_single" | "telegram_multipart" | "hls_package";
export type MultipartSourceKind = "local" | "url";
export type HlsAssetStatus = "pending" | "importing" | "done" | "failed" | "cancelled";
export type HlsSegmentStatus = "pending" | "importing" | "done" | "failed";
export type HlsSegmentStorageBackend = "telegram_single" | "telegram_multipart";

export interface DirectoryRecord {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: string;
  deleted_at: string | null;
}

export interface FileRecord {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  md5: string;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  telegram_channel_id?: string;
  file_path: string;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  directory_id?: string | null;
  directory_path?: string;
  storage_backend?: StorageBackend;
  chunk_size?: number | null;
  chunk_count?: number | null;
  thumbnail_file_id?: string | null;
  thumbnail_file_unique_id?: string | null;
  thumbnail_file_path?: string | null;
  thumbnail_mime_type?: string | null;
  thumbnail_size?: number | null;
  thumbnail_width?: number | null;
  thumbnail_height?: number | null;
  thumbnail_status?: ThumbnailStatus;
}

export type ThumbnailStatus = "none" | "ready" | "failed";

export interface NewFileRecord {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  md5: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  telegramChannelId?: string;
  filePath: string;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath?: string;
  storageBackend?: StorageBackend;
  chunkSize?: number;
  chunkCount?: number;
  thumbnailFileId?: string;
  thumbnailFileUniqueId?: string;
  thumbnailFilePath?: string;
  thumbnailMimeType?: string;
  thumbnailSize?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  thumbnailStatus?: ThumbnailStatus;
}

export interface FileListResult {
  files: FileRecord[];
  total: number;
}

export interface FileUsageStats {
  file_count: number;
  total_size: number;
}

export interface FileNameConflictRecord {
  id: string;
  source: "file";
}

export type FileNameConflictAction = "error" | "overwrite";

export type FileTypeFilter = "image" | "video" | "text" | "pdf" | "archive" | "other";

export type ApiKeyStatus = "active" | "disabled";

export interface ApiKeyRecord {
  id: string;
  name: string;
  key: string;
  status: ApiKeyStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  deleted_at: string | null;
}

export interface NewApiKeyRecord {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}

export interface MultipartUploadRecord {
  id: string;
  source_kind: MultipartSourceKind;
  source_url: string | null;
  source_headers_json?: string | null;
  source_range_start?: number | null;
  file_name: string;
  mime_type: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  completed_at: string | null;
  directory_id?: string | null;
  telegram_channel_group?: string;
  directory_path?: string;
}

export interface NewMultipartUploadRecord {
  id: string;
  sourceKind: MultipartSourceKind;
  sourceUrl?: string;
  sourceHeadersJson?: string;
  sourceRangeStart?: number | null;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath?: string;
  telegramChannelGroup?: string;
}

export interface FileChunkRecord {
  file_id: string;
  chunk_index: number;
  size: number;
  md5: string;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  telegram_channel_id?: string;
  created_at: string;
}

export interface NewFileChunkRecord {
  fileId: string;
  chunkIndex: number;
  size: number;
  md5: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  telegramChannelId?: string;
  createdAt: string;
}

export type TelegramChannelStatus = "active" | "disabled";

export interface TelegramChannelRecord {
  id: string;
  name: string;
  bot_token_encrypted: string;
  bot_token_hash: string;
  chat_id: string;
  status: TelegramChannelStatus;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface NewTelegramChannelRecord {
  id: string;
  name: string;
  botTokenEncrypted: string;
  botTokenHash: string;
  chatId: string;
  status?: TelegramChannelStatus;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTelegramChannelRecord {
  id: string;
  name: string;
  botTokenEncrypted: string;
  botTokenHash: string;
  chatId: string;
  status: TelegramChannelStatus;
  updatedAt: string;
}

export interface TelegramChannelUsage {
  files: number;
  chunks: number;
}

export interface MultipartCleanupResult {
  deletedUploads: number;
  deletedChunks: number;
}

export interface HlsAssetRecord {
  id: string;
  source_url: string;
  source_headers_json?: string | null;
  media_playlist_url: string;
  file_name: string;
  mime_type: string;
  directory_id: string | null;
  directory_path: string;
  status: HlsAssetStatus;
  selected_variant_id: string | null;
  target_duration_seconds: number;
  duration_seconds: number;
  segment_count: number;
  estimated_size: number | null;
  playlist_text: string;
  playlist_file_id: string | null;
  final_file_id: string | null;
  init_source_url: string | null;
  init_byte_range_start: number | null;
  init_byte_range_length: number | null;
  init_mime_type: string | null;
  init_size: number | null;
  init_storage_backend: HlsSegmentStorageBackend | null;
  init_telegram_file_id: string | null;
  init_telegram_file_unique_id: string | null;
  init_telegram_channel_id: string;
  init_status: "none" | HlsSegmentStatus;
  init_error_message: string | null;
  init_completed_at: string | null;
  thumbnail_status: ThumbnailStatus;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

export interface NewHlsAssetRecord {
  id: string;
  sourceUrl: string;
  sourceHeadersJson?: string;
  mediaPlaylistUrl: string;
  fileName: string;
  mimeType: string;
  directoryId?: string | null;
  directoryPath: string;
  status: HlsAssetStatus;
  selectedVariantId?: string | null;
  targetDurationSeconds: number;
  durationSeconds: number;
  segmentCount: number;
  estimatedSize?: number | null;
  playlistText: string;
  initSourceUrl?: string | null;
  initByteRangeStart?: number | null;
  initByteRangeLength?: number | null;
  initMimeType?: string | null;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HlsSegmentRecord {
  id: string;
  asset_id: string;
  variant_id: string;
  segment_index: number;
  source_url: string;
  byte_range_start: number | null;
  byte_range_length: number | null;
  duration_seconds: number;
  mime_type: string;
  size: number | null;
  storage_backend: HlsSegmentStorageBackend | null;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  telegram_channel_id: string;
  multipart_upload_id: string | null;
  chunk_size: number | null;
  chunk_count: number | null;
  status: HlsSegmentStatus;
  attempts: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewHlsSegmentRecord {
  id: string;
  assetId: string;
  variantId: string;
  segmentIndex: number;
  sourceUrl: string;
  byteRangeStart?: number | null;
  byteRangeLength?: number | null;
  durationSeconds: number;
  mimeType: string;
  size?: number | null;
  status: HlsSegmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HlsCleanupResult {
  deletedAssets: number;
  deletedSegments: number;
  deletedUploads: number;
  deletedChunks: number;
}

export const UPLOAD_CONCURRENCY_SETTING_KEY = "upload_concurrency";
export const DEFAULT_UPLOAD_CONCURRENCY = 5;
export const MIN_UPLOAD_CONCURRENCY = 1;
export const MAX_UPLOAD_CONCURRENCY = 32;

export function requireDb(env: { DATABASE?: AppDatabase }): AppDatabase {
  if (!env.DATABASE) {
    throw new AppError(500, "ServerMisconfigured", "Missing configured database");
  }

  return env.DATABASE;
}

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

function prepareInsertFileRecord(db: AppDatabase, record: NewFileRecord): AppPreparedStatement {
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
      SET file_name = ?, remark = ?, file_path = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(params.fileName, params.remark, params.filePath, params.id)
    .run();

  return {
    ...existing,
    file_name: params.fileName,
    remark: params.remark,
    file_path: params.filePath
  };
}

export async function getDirectoryRecord(db: AppDatabase, id: string): Promise<DirectoryRecord | null> {
  return await db
    .prepare(
      `SELECT id, parent_id, name, path, created_at, deleted_at
      FROM directories
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .first<DirectoryRecord>();
}

export async function getDirectoryRecordByPath(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  return await db
    .prepare(
      `SELECT id, parent_id, name, path, created_at, deleted_at
      FROM directories
      WHERE path = ? AND deleted_at IS NULL`
    )
    .bind(path)
    .first<DirectoryRecord>();
}

export async function listDirectoryChildren(db: AppDatabase, parentPath: string): Promise<DirectoryRecord[]> {
  let statement: AppPreparedStatement;

  if (parentPath === "/") {
    statement = db.prepare(
      `SELECT id, parent_id, name, path, created_at, deleted_at
      FROM directories
      WHERE parent_id IS NULL AND deleted_at IS NULL
      ORDER BY LOWER(name) ASC, created_at ASC`
    );
  } else {
    const parent = await getDirectoryRecordByPath(db, parentPath);
    if (!parent) {
      return [];
    }
    statement = db
      .prepare(
        `SELECT id, parent_id, name, path, created_at, deleted_at
        FROM directories
        WHERE parent_id = ? AND deleted_at IS NULL
        ORDER BY LOWER(name) ASC, created_at ASC`
      )
      .bind(parent.id);
  }

  const result = await statement.all<DirectoryRecord>();
  return result.results ?? [];
}

export async function listAllDirectoryRecords(db: AppDatabase): Promise<DirectoryRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, parent_id, name, path, created_at, deleted_at
      FROM directories
      WHERE deleted_at IS NULL
      ORDER BY path ASC`
    )
    .all<DirectoryRecord>();

  return result.results ?? [];
}

async function listAllDirectoryRecordsIncludingDeleted(db: AppDatabase): Promise<DirectoryRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, parent_id, name, path, created_at, deleted_at
      FROM directories
      ORDER BY path ASC`
    )
    .all<DirectoryRecord>();

  return result.results ?? [];
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

export async function getDirectoryUsageStats(
  db: AppDatabase,
  directories: DirectoryRecord[]
): Promise<Map<string, FileUsageStats>> {
  const result = new Map<string, FileUsageStats>();
  if (directories.length === 0) {
    return result;
  }

  for (const directory of directories) {
    result.set(directory.path, { file_count: 0, total_size: 0 });
  }

  const rows = await db
    .prepare(
      `SELECT COALESCE(directory_path, '/') AS directory_path,
        COUNT(*) AS file_count,
        COALESCE(SUM(size), 0) AS total_size
      FROM files
      WHERE deleted_at IS NULL
      GROUP BY COALESCE(directory_path, '/')`
    )
    .all<FileUsageStats & { directory_path: string }>();

  for (const row of rows.results ?? []) {
    for (const directory of directories) {
      if (row.directory_path !== directory.path && !row.directory_path.startsWith(`${directory.path}/`)) {
        continue;
      }

      const current = result.get(directory.path) ?? { file_count: 0, total_size: 0 };
      current.file_count += row.file_count;
      current.total_size += row.total_size;
      result.set(directory.path, current);
    }
  }

  return result;
}

export async function insertDirectoryRecord(params: {
  db: AppDatabase;
  parentPath: string;
  name: string;
  createdAt: string;
}): Promise<DirectoryRecord> {
  const parent = params.parentPath === "/" ? null : await getDirectoryRecordByPath(params.db, params.parentPath);

  if (params.parentPath !== "/" && !parent) {
    throw new AppError(404, "DirectoryNotFound", "Parent directory not found");
  }

  const path = params.parentPath === "/" ? `/${params.name}` : `${params.parentPath}/${params.name}`;
  const existing = await getDirectoryRecordByPath(params.db, path);

  if (existing) {
    throw new AppError(409, "DirectoryExists", "Directory already exists");
  }

  const record: DirectoryRecord = {
    id: crypto.randomUUID(),
    parent_id: parent?.id ?? null,
    name: params.name,
    path,
    created_at: params.createdAt,
    deleted_at: null
  };

  await params.db
    .prepare(
      `INSERT INTO directories (
        id,
        parent_id,
        name,
        path,
        created_at,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, NULL)`
    )
    .bind(record.id, record.parent_id, record.name, record.path, record.created_at)
    .run();

  return record;
}

export async function deleteDirectoryTree(params: {
  db: AppDatabase;
  id: string;
}): Promise<{ directory: DirectoryRecord; deletedDirectories: number; deletedFiles: number } | null> {
  const directory = await getDirectoryRecord(params.db, params.id);

  if (!directory) {
    return null;
  }

  const subtree = collectDirectorySubtree(directory, await listAllDirectoryRecordsIncludingDeleted(params.db));
  const directoryIds = subtree.map((item) => item.id);
  const directoryPaths = subtree.map((item) => item.path);
  const directoryIdClause = placeholders(directoryIds.length);
  const directoryPathClause = placeholders(directoryPaths.length);
  const fileSelectionClause = `(
    directory_id IN (${directoryIdClause})
    OR COALESCE(directory_path, '/') IN (${directoryPathClause})
  )`;
  const fileCount = await params.db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM files
      WHERE deleted_at IS NULL
        AND ${fileSelectionClause}`
    )
    .bind(...directoryIds, ...directoryPaths)
    .first<{ total: number }>();

  await params.db
    .prepare(
      `DELETE FROM file_chunks
      WHERE file_id IN (
        SELECT id
        FROM files
        WHERE ${fileSelectionClause}
      )`
    )
    .bind(...directoryIds, ...directoryPaths)
    .run();
  await params.db
    .prepare(
      `DELETE FROM files
      WHERE ${fileSelectionClause}`
    )
    .bind(...directoryIds, ...directoryPaths)
    .run();
  await params.db
    .prepare(
      `DELETE FROM multipart_uploads
      WHERE directory_id IN (${directoryIdClause})
        OR COALESCE(directory_path, '/') IN (${directoryPathClause})`
    )
    .bind(...directoryIds, ...directoryPaths)
    .run();

  const directoriesByDepthDesc = subtree
    .slice()
    .sort((left, right) => right.path.length - left.path.length);
  for (const item of directoriesByDepthDesc) {
    await params.db
      .prepare("DELETE FROM directories WHERE id = ?")
      .bind(item.id)
      .run();
  }

  return {
    directory,
    deletedDirectories: subtree.filter((item) => item.deleted_at === null).length,
    deletedFiles: fileCount?.total ?? 0
  };
}

export async function moveDirectoryTree(params: {
  db: AppDatabase;
  id: string;
  parentPath: string;
}): Promise<{ directory: DirectoryRecord; movedDirectories: number; movedFiles: number } | null> {
  const directory = await getDirectoryRecord(params.db, params.id);

  if (!directory) {
    return null;
  }

  const oldPath = directory.path;

  if (params.parentPath === oldPath || params.parentPath.startsWith(`${oldPath}/`)) {
    throw new AppError(400, "InvalidDirectoryMove", "Cannot move a directory into itself or its subdirectory");
  }

  const parent = params.parentPath === "/" ? null : await getDirectoryRecordByPath(params.db, params.parentPath);

  if (params.parentPath !== "/" && !parent) {
    throw new AppError(404, "DirectoryNotFound", "Target parent directory not found");
  }

  const nextPath = params.parentPath === "/" ? `/${directory.name}` : `${params.parentPath}/${directory.name}`;

  if (nextPath !== oldPath) {
    const conflict = await getDirectoryRecordByPath(params.db, nextPath);
    if (conflict && conflict.id !== directory.id) {
      throw new AppError(409, "DirectoryExists", "Target directory already contains a directory with the same name");
    }
  }

  if (nextPath === oldPath && (parent?.id ?? null) === directory.parent_id) {
    return {
      directory,
      movedDirectories: 0,
      movedFiles: 0
    };
  }

  const prefixPattern = `${escapeLikePattern(oldPath)}/%`;
  const directoryCount = await params.db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM directories
      WHERE deleted_at IS NULL
        AND (path = ? OR path LIKE ? ESCAPE '\\')`
    )
    .bind(oldPath, prefixPattern)
    .first<{ total: number }>();
  const fileCount = await params.db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM files
      WHERE deleted_at IS NULL
        AND (COALESCE(directory_path, '/') = ? OR COALESCE(directory_path, '/') LIKE ? ESCAPE '\\')`
    )
    .bind(oldPath, prefixPattern)
    .first<{ total: number }>();

  await params.db
    .prepare(
      `UPDATE directories
      SET parent_id = ?, path = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(parent?.id ?? null, nextPath, directory.id)
    .run();
  await params.db
    .prepare(
      `UPDATE directories
      SET path = ? || SUBSTR(path, ?)
      WHERE deleted_at IS NULL
        AND path LIKE ? ESCAPE '\\'`
    )
    .bind(nextPath, oldPath.length + 1, prefixPattern)
    .run();
  await params.db
    .prepare(
      `UPDATE files
      SET directory_path = ? || SUBSTR(COALESCE(directory_path, '/'), ?)
      WHERE deleted_at IS NULL
        AND (COALESCE(directory_path, '/') = ? OR COALESCE(directory_path, '/') LIKE ? ESCAPE '\\')`
    )
    .bind(nextPath, oldPath.length + 1, oldPath, prefixPattern)
    .run();

  return {
    directory: {
      ...directory,
      parent_id: parent?.id ?? null,
      path: nextPath
    },
    movedDirectories: directoryCount?.total ?? 0,
    movedFiles: fileCount?.total ?? 0
  };
}

export async function renameDirectoryTree(params: {
  db: AppDatabase;
  id: string;
  name: string;
}): Promise<{ directory: DirectoryRecord; renamedDirectories: number; updatedFiles: number } | null> {
  const directory = await getDirectoryRecord(params.db, params.id);

  if (!directory) {
    return null;
  }

  const oldPath = directory.path;
  const parentPath = parentPathForDirectory(oldPath);
  const nextPath = parentPath === "/" ? `/${params.name}` : `${parentPath}/${params.name}`;

  if (nextPath === oldPath && params.name === directory.name) {
    return {
      directory,
      renamedDirectories: 0,
      updatedFiles: 0
    };
  }

  const conflict = await getDirectoryRecordByPath(params.db, nextPath);
  if (conflict && conflict.id !== directory.id) {
    throw new AppError(409, "DirectoryExists", "Target directory already contains a directory with the same name");
  }

  const prefixPattern = `${escapeLikePattern(oldPath)}/%`;
  const directoryCount = await params.db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM directories
      WHERE deleted_at IS NULL
        AND (path = ? OR path LIKE ? ESCAPE '\\')`
    )
    .bind(oldPath, prefixPattern)
    .first<{ total: number }>();
  const fileCount = await params.db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM files
      WHERE deleted_at IS NULL
        AND (COALESCE(directory_path, '/') = ? OR COALESCE(directory_path, '/') LIKE ? ESCAPE '\\')`
    )
    .bind(oldPath, prefixPattern)
    .first<{ total: number }>();

  await params.db
    .prepare(
      `UPDATE directories
      SET name = ?, path = ?
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(params.name, nextPath, directory.id)
    .run();
  await params.db
    .prepare(
      `UPDATE directories
      SET path = ? || SUBSTR(path, ?)
      WHERE deleted_at IS NULL
        AND path LIKE ? ESCAPE '\\'`
    )
    .bind(nextPath, oldPath.length + 1, prefixPattern)
    .run();
  await params.db
    .prepare(
      `UPDATE files
      SET directory_path = ? || SUBSTR(COALESCE(directory_path, '/'), ?)
      WHERE deleted_at IS NULL
        AND (COALESCE(directory_path, '/') = ? OR COALESCE(directory_path, '/') LIKE ? ESCAPE '\\')`
    )
    .bind(nextPath, oldPath.length + 1, oldPath, prefixPattern)
    .run();

  return {
    directory: {
      ...directory,
      name: params.name,
      path: nextPath
    },
    renamedDirectories: directoryCount?.total ?? 0,
    updatedFiles: fileCount?.total ?? 0
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

export async function completeMultipartUploadRecord(
  db: AppDatabase,
  id: string,
  completedAt: string
): Promise<void> {
  await prepareCompleteMultipartUploadRecord(db, id, completedAt).run();
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

function prepareDeleteActiveFileRecordsByName(
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

export async function insertApiKeyRecord(db: AppDatabase, record: NewApiKeyRecord): Promise<ApiKeyRecord> {
  await db
    .prepare(
      `INSERT INTO api_keys (
        id,
        name,
        key,
        status,
        created_at,
        updated_at,
        last_used_at,
        deleted_at
      ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL)`
    )
    .bind(record.id, record.name, record.key, record.createdAt, record.createdAt)
    .run();

  return {
    id: record.id,
    name: record.name,
    key: record.key,
    status: "active",
    created_at: record.createdAt,
    updated_at: record.createdAt,
    last_used_at: null,
    deleted_at: null
  };
}

export async function listApiKeyRecords(db: AppDatabase): Promise<ApiKeyRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        name,
        key,
        status,
        created_at,
        updated_at,
        last_used_at,
        deleted_at
      FROM api_keys
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC`
    )
    .all<ApiKeyRecord>();

  return result.results ?? [];
}

export async function getApiKeyRecord(db: AppDatabase, id: string): Promise<ApiKeyRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        name,
        key,
        status,
        created_at,
        updated_at,
        last_used_at,
        deleted_at
      FROM api_keys
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .first<ApiKeyRecord>();
}

export async function findActiveApiKeyRecord(db: AppDatabase, key: string): Promise<ApiKeyRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        name,
        key,
        status,
        created_at,
        updated_at,
        last_used_at,
        deleted_at
      FROM api_keys
      WHERE key = ? AND status = 'active' AND deleted_at IS NULL`
    )
    .bind(key)
    .first<ApiKeyRecord>();
}

export async function touchApiKeyRecord(db: AppDatabase, id: string, lastUsedAt: string): Promise<void> {
  await db
    .prepare("UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(lastUsedAt, lastUsedAt, id)
    .run();
}

export async function updateApiKeyRecord(params: {
  db: AppDatabase;
  id: string;
  updatedAt: string;
  name?: string;
  status?: ApiKeyStatus;
}): Promise<ApiKeyRecord | null> {
  const existing = await getApiKeyRecord(params.db, params.id);

  if (!existing) {
    return null;
  }

  const nextName = params.name ?? existing.name;
  const nextStatus = params.status ?? existing.status;

  await params.db
    .prepare("UPDATE api_keys SET name = ?, status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(nextName, nextStatus, params.updatedAt, params.id)
    .run();

  return {
    ...existing,
    name: nextName,
    status: nextStatus,
    updated_at: params.updatedAt
  };
}

export async function softDeleteApiKeyRecord(db: AppDatabase, id: string, deletedAt: string): Promise<boolean> {
  const existing = await getApiKeyRecord(db, id);

  if (!existing) {
    return false;
  }

  await db
    .prepare("UPDATE api_keys SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(deletedAt, deletedAt, id)
    .run();
  return true;
}

export async function getUploadConcurrencySetting(db: AppDatabase): Promise<number> {
  let row: { value: string } | null = null;
  try {
    row = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(UPLOAD_CONCURRENCY_SETTING_KEY)
      .first<{ value: string }>();
  } catch {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  const parsed = row ? Number(row.value) : DEFAULT_UPLOAD_CONCURRENCY;

  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }

  return clampUploadConcurrency(parsed);
}

export async function setUploadConcurrencySetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  const normalized = clampUploadConcurrency(value);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(UPLOAD_CONCURRENCY_SETTING_KEY, String(normalized), updatedAt)
    .run();

  return normalized;
}

function clampUploadConcurrency(value: number): number {
  return Math.min(MAX_UPLOAD_CONCURRENCY, Math.max(MIN_UPLOAD_CONCURRENCY, value));
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function collectDirectorySubtree(root: DirectoryRecord, directories: DirectoryRecord[]): DirectoryRecord[] {
  const childrenByParent = new Map<string, DirectoryRecord[]>();

  for (const directory of directories) {
    if (!directory.parent_id) {
      continue;
    }

    const children = childrenByParent.get(directory.parent_id) ?? [];
    children.push(directory);
    childrenByParent.set(directory.parent_id, children);
  }

  const subtree: DirectoryRecord[] = [];
  const visited = new Set<string>();
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current.id)) {
      continue;
    }

    visited.add(current.id);
    subtree.push(current);
    stack.push(...(childrenByParent.get(current.id) ?? []));
  }

  return subtree;
}

function parentPathForDirectory(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
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
