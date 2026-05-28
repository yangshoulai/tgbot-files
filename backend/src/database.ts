import { AppError } from "./http";

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
}

export interface FileListResult {
  files: FileRecord[];
  total: number;
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
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
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
      record.createdAt
    )
    .run();
}

export async function listFileRecords(params: {
  db: D1Database;
  query: string;
  type?: FileTypeFilter;
  createdFrom?: string;
  createdTo?: string;
  page: number;
  limit: number;
}): Promise<FileListResult> {
  const whereParts = ["deleted_at IS NULL"];
  const bindings: Array<number | string> = [];
  const normalizedQuery = params.query.trim().toLowerCase();

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
        deleted_at
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
