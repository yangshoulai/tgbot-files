import type { AppDatabase } from "../runtime";
import type { ApiKeyRecord, ApiKeyStatus, NewApiKeyRecord } from "./types";

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
