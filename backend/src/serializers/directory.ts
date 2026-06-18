import type { DirectoryRecord } from "../database";

export interface DirectoryUsageSummary {
  file_count: number;
  total_size: number;
}

export function serializeDirectoryRecord(
  record: DirectoryRecord,
  usage?: DirectoryUsageSummary
): Record<string, unknown> {
  return {
    id: record.id,
    parent_id: record.parent_id,
    name: record.name,
    path: record.path,
    created_at: record.created_at,
    deleted_at: record.deleted_at,
    file_count: usage?.file_count ?? 0,
    total_size: usage?.total_size ?? 0
  };
}

export function serializeCurrentDirectory(record: DirectoryRecord | null, path: string): Record<string, unknown> {
  if (path === "/") {
    return {
      id: null,
      parent_id: null,
      name: "/",
      path: "/",
      created_at: null,
      deleted_at: null
    };
  }

  if (!record) {
    return {
      id: null,
      parent_id: null,
      name: path.split("/").filter(Boolean).at(-1) ?? path,
      path,
      created_at: null,
      deleted_at: null
    };
  }

  return serializeDirectoryRecord(record);
}
