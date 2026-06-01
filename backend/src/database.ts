import { AppError } from "./http";

export type StorageBackend = "telegram_single" | "telegram_multipart";
export type MultipartSourceKind = "local" | "url";

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
}

export interface NewFileRecord {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  md5: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  filePath: string;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath?: string;
  storageBackend?: StorageBackend;
  chunkSize?: number;
  chunkCount?: number;
}

export interface FileListResult {
  files: FileRecord[];
  total: number;
}

export interface FileUsageStats {
  file_count: number;
  total_size: number;
}

export type FileTypeFilter = "image" | "text" | "pdf" | "archive" | "other";

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
  directory_path?: string;
}

export interface NewMultipartUploadRecord {
  id: string;
  sourceKind: MultipartSourceKind;
  sourceUrl?: string;
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
}

export interface FileChunkRecord {
  file_id: string;
  chunk_index: number;
  size: number;
  md5: string;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  created_at: string;
}

export interface NewFileChunkRecord {
  fileId: string;
  chunkIndex: number;
  size: number;
  md5: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  createdAt: string;
}

export function requireDb(env: { FILES_DB?: D1Database }): D1Database {
  if (!env.FILES_DB) {
    throw new AppError(500, "ServerMisconfigured", "Missing required D1 binding: FILES_DB");
  }

  return env.FILES_DB;
}

export async function insertFileRecord(db: D1Database, record: NewFileRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO files (
        id,
        file_name,
        mime_type,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
        file_path,
        remark,
        uploaded_by,
        created_at,
        directory_id,
        directory_path,
        deleted_at,
        storage_backend,
        chunk_size,
        chunk_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.fileName,
      record.mimeType,
      record.size,
      record.md5,
      record.telegramFileId,
      record.telegramFileUniqueId ?? null,
      record.filePath,
      record.remark ?? null,
      record.uploadedBy ?? null,
      record.createdAt,
      record.directoryId ?? null,
      record.directoryPath ?? "/",
      record.storageBackend ?? "telegram_single",
      record.chunkSize ?? null,
      record.chunkCount ?? null
    )
    .run();
}

export async function listFileRecords(params: {
  db: D1Database;
  query: string;
  type?: FileTypeFilter;
  createdFrom?: string;
  createdTo?: string;
  directoryPath?: string;
  page: number;
  limit: number;
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
  const offset = (params.page - 1) * params.limit;
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
        file_path,
        remark,
        uploaded_by,
        created_at,
        deleted_at,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        COALESCE(storage_backend, 'telegram_single') AS storage_backend,
        chunk_size,
        chunk_count
      FROM files
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
    )
    .bind(...bindings, params.limit, offset)
    .all<FileRecord>();

  return {
    files: result.results ?? [],
    total: totalRow?.total ?? 0
  };
}

export async function getFileRecord(db: D1Database, id: string): Promise<FileRecord | null> {
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
        file_path,
        remark,
        uploaded_by,
        created_at,
        deleted_at,
        directory_id,
        COALESCE(directory_path, '/') AS directory_path,
        COALESCE(storage_backend, 'telegram_single') AS storage_backend,
        chunk_size,
        chunk_count
      FROM files
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .first<FileRecord>();
}

export async function softDeleteFileRecord(db: D1Database, id: string, deletedAt: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT id FROM files WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ id: string }>();

  if (!existing) {
    return false;
  }

  await db.prepare("UPDATE files SET deleted_at = ? WHERE id = ?").bind(deletedAt, id).run();
  return true;
}

export async function updateFileRecordMetadata(params: {
  db: D1Database;
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

export async function getDirectoryRecord(db: D1Database, id: string): Promise<DirectoryRecord | null> {
  return await db
    .prepare(
      `SELECT id, parent_id, name, path, created_at, deleted_at
      FROM directories
      WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(id)
    .first<DirectoryRecord>();
}

export async function getDirectoryRecordByPath(db: D1Database, path: string): Promise<DirectoryRecord | null> {
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

export async function listDirectoryChildren(db: D1Database, parentPath: string): Promise<DirectoryRecord[]> {
  let statement: D1PreparedStatement;

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

export async function listAllDirectoryRecords(db: D1Database): Promise<DirectoryRecord[]> {
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

export async function getGlobalFileUsageStats(db: D1Database): Promise<FileUsageStats> {
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
  db: D1Database,
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
  db: D1Database;
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

export async function softDeleteDirectoryTree(params: {
  db: D1Database;
  id: string;
  deletedAt: string;
}): Promise<{ directory: DirectoryRecord; deletedDirectories: number; deletedFiles: number } | null> {
  const directory = await getDirectoryRecord(params.db, params.id);

  if (!directory) {
    return null;
  }

  const subtree = collectDirectorySubtree(directory, await listAllDirectoryRecords(params.db));
  const directoryIds = subtree.map((item) => item.id);
  const directoryPaths = subtree.map((item) => item.path);
  const directoryIdClause = placeholders(directoryIds.length);
  const directoryPathClause = placeholders(directoryPaths.length);
  const fileCount = await params.db
    .prepare(
      `SELECT COUNT(*) AS total
      FROM files
      WHERE deleted_at IS NULL
        AND (
          directory_id IN (${directoryIdClause})
          OR COALESCE(directory_path, '/') IN (${directoryPathClause})
        )`
    )
    .bind(...directoryIds, ...directoryPaths)
    .first<{ total: number }>();

  await params.db
    .prepare(
      `UPDATE files
      SET deleted_at = ?
      WHERE deleted_at IS NULL
        AND (
          directory_id IN (${directoryIdClause})
          OR COALESCE(directory_path, '/') IN (${directoryPathClause})
        )`
    )
    .bind(params.deletedAt, ...directoryIds, ...directoryPaths)
    .run();
  await params.db
    .prepare(
      `UPDATE directories
      SET deleted_at = ?
      WHERE deleted_at IS NULL
        AND id IN (${directoryIdClause})`
    )
    .bind(params.deletedAt, ...directoryIds)
    .run();

  return {
    directory,
    deletedDirectories: directoryIds.length,
    deletedFiles: fileCount?.total ?? 0
  };
}

export async function moveDirectoryTree(params: {
  db: D1Database;
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
  db: D1Database;
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
  db: D1Database;
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
  db: D1Database,
  record: NewMultipartUploadRecord
): Promise<MultipartUploadRecord> {
  await db
    .prepare(
      `INSERT INTO multipart_uploads (
        id,
        source_kind,
        source_url,
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
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(
      record.id,
      record.sourceKind,
      record.sourceUrl ?? null,
      record.fileName,
      record.mimeType,
      record.size,
      record.chunkSize,
      record.chunkCount,
      record.remark ?? null,
      record.uploadedBy ?? null,
      record.createdAt,
      record.directoryId ?? null,
      record.directoryPath ?? "/"
    )
    .run();

  return {
    id: record.id,
    source_kind: record.sourceKind,
    source_url: record.sourceUrl ?? null,
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
    completed_at: null
  };
}

export async function getMultipartUploadRecord(db: D1Database, id: string): Promise<MultipartUploadRecord | null> {
  return await db
    .prepare(
      `SELECT
        id,
        source_kind,
        source_url,
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
        completed_at
      FROM multipart_uploads
      WHERE id = ? AND completed_at IS NULL`
    )
    .bind(id)
    .first<MultipartUploadRecord>();
}

export async function completeMultipartUploadRecord(
  db: D1Database,
  id: string,
  completedAt: string
): Promise<void> {
  await db
    .prepare("UPDATE multipart_uploads SET completed_at = ? WHERE id = ? AND completed_at IS NULL")
    .bind(completedAt, id)
    .run();
}

export async function upsertFileChunkRecord(db: D1Database, record: NewFileChunkRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO file_chunks (
        file_id,
        chunk_index,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.fileId,
      record.chunkIndex,
      record.size,
      record.md5,
      record.telegramFileId,
      record.telegramFileUniqueId ?? null,
      record.createdAt
    )
    .run();
}

export async function listFileChunkRecords(db: D1Database, fileId: string): Promise<FileChunkRecord[]> {
  const result = await db
    .prepare(
      `SELECT
        file_id,
        chunk_index,
        size,
        md5,
        telegram_file_id,
        telegram_file_unique_id,
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
  db: D1Database,
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
        created_at
      FROM file_chunks
      WHERE file_id = ? AND chunk_index = ?
      LIMIT 1`
    )
    .bind(fileId, chunkIndex)
    .first<FileChunkRecord>();
}

export async function insertApiKeyRecord(db: D1Database, record: NewApiKeyRecord): Promise<ApiKeyRecord> {
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

export async function listApiKeyRecords(db: D1Database): Promise<ApiKeyRecord[]> {
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

export async function getApiKeyRecord(db: D1Database, id: string): Promise<ApiKeyRecord | null> {
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

export async function findActiveApiKeyRecord(db: D1Database, key: string): Promise<ApiKeyRecord | null> {
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

export async function touchApiKeyRecord(db: D1Database, id: string, lastUsedAt: string): Promise<void> {
  await db
    .prepare("UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(lastUsedAt, lastUsedAt, id)
    .run();
}

export async function updateApiKeyRecord(params: {
  db: D1Database;
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

export async function softDeleteApiKeyRecord(db: D1Database, id: string, deletedAt: string): Promise<boolean> {
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
    case "text":
      return `(${text})`;
    case "pdf":
      return `(${pdf})`;
    case "archive":
      return `(${archive})`;
    case "other":
      return `NOT (${image} OR ${text} OR ${pdf} OR ${archive})`;
  }
}
