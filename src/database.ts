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
  uploadedBy?: string;
  createdAt: string;
}

export interface FileListResult {
  files: FileRecord[];
  total: number;
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
        uploaded_by,
        created_at,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
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
      record.uploadedBy ?? null,
      record.createdAt
    )
    .run();
}

export async function listFileRecords(params: {
  db: D1Database;
  query: string;
  page: number;
  limit: number;
}): Promise<FileListResult> {
  const whereParts = ["deleted_at IS NULL"];
  const bindings: Array<number | string> = [];
  const normalizedQuery = params.query.trim().toLowerCase();

  if (normalizedQuery) {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    whereParts.push(
      `(LOWER(file_name) LIKE ? ESCAPE '\\' OR LOWER(mime_type) LIKE ? ESCAPE '\\' OR LOWER(md5) LIKE ? ESCAPE '\\' OR LOWER(telegram_file_id) LIKE ? ESCAPE '\\')`
    );
    bindings.push(pattern, pattern, pattern, pattern);
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
