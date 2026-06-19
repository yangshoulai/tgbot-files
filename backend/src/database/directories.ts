import { AppError } from "../utils/http";
import type { AppDatabase, AppPreparedStatement } from "../runtime";
import type { DirectoryRecord, FileUsageStats } from "./types";
import { escapeLikePattern, placeholders } from "./shared";

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
