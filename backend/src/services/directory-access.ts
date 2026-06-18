import {
  getDirectoryRecord,
  getDirectoryRecordByPath,
  getFileRecord,
  insertDirectoryRecord,
  type DirectoryRecord,
  type FileRecord
} from "../database";
import { AppError } from "../utils/http";
import type { AppDatabase } from "../runtime";
import { normalizeDirectoryName, normalizeDirectoryPath } from "../validators/request";

export async function requireReadableDirectory(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const directory = await getDirectoryRecordByPath(db, path);
  if (!directory) {
    throw new AppError(404, "DirectoryNotFound", "Directory not found");
  }

  return directory;
}

export async function requireWritableDirectory(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
  return requireReadableDirectory(db, path);
}

export async function ensureWritableDirectory(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const segments = path.split("/").filter(Boolean);
  let parentPath = "/";
  let current: DirectoryRecord | null = null;

  for (const segment of segments) {
    const currentPath = parentPath === "/" ? `/${segment}` : `${parentPath}/${segment}`;
    current = await getDirectoryRecordByPath(db, currentPath);

    if (!current) {
      try {
        current = await insertDirectoryRecord({
          db,
          parentPath,
          name: segment,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.error !== "DirectoryExists") {
          throw error;
        }

        current = await getDirectoryRecordByPath(db, currentPath);
        if (!current) {
          throw error;
        }
      }
    }

    parentPath = currentPath;
  }

  return current;
}

export async function requireFileRecords(db: AppDatabase, ids: string[]): Promise<FileRecord[]> {
  const records: FileRecord[] = [];

  for (const id of ids) {
    const file = await getFileRecord(db, id);
    if (!file) {
      throw new AppError(404, "NotFound", "File record not found");
    }
    records.push(file);
  }

  return records;
}

export async function requireDirectoryRecords(db: AppDatabase, ids: string[]): Promise<DirectoryRecord[]> {
  const records: DirectoryRecord[] = [];

  for (const id of ids) {
    const directory = await getDirectoryRecord(db, id);
    if (!directory) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }
    records.push(directory);
  }

  return records;
}

export function moveTargetParentPath(body: Record<string, unknown>): string {
  if (body.new_directory_name !== undefined) {
    return normalizeDirectoryPath(body.new_directory_parent_path ?? body.parent_path ?? body.directory_path ?? "/");
  }

  return normalizeDirectoryPath(body.directory_path ?? "/");
}

export function validateEntryMoveParent(directories: DirectoryRecord[], parentPath: string): void {
  for (const directory of directories) {
    if (parentPath === directory.path || parentPath.startsWith(`${directory.path}/`)) {
      throw new AppError(400, "InvalidDirectoryMove", "Cannot move a directory into itself or its subdirectory");
    }
  }
}

export async function validateEntryMoveTarget(
  db: AppDatabase,
  directories: DirectoryRecord[],
  parentPath: string
): Promise<void> {
  for (const directory of directories) {
    validateEntryMoveParent([directory], parentPath);

    const nextPath = parentPath === "/" ? `/${directory.name}` : `${parentPath}/${directory.name}`;
    if (nextPath === directory.path) {
      continue;
    }

    const conflict = await getDirectoryRecordByPath(db, nextPath);
    if (conflict && conflict.id !== directory.id) {
      throw new AppError(409, "DirectoryExists", "Target directory already contains a directory with the same name");
    }
  }
}

export async function resolveMoveTargetDirectory(db: AppDatabase, body: Record<string, unknown>): Promise<string> {
  if (body.new_directory_name !== undefined) {
    const parentPath = normalizeDirectoryPath(
      body.new_directory_parent_path ?? body.parent_path ?? body.directory_path ?? "/"
    );
    const name = normalizeDirectoryName(body.new_directory_name);
    const directory = await insertDirectoryRecord({
      db,
      parentPath,
      name,
      createdAt: new Date().toISOString()
    });

    return directory.path;
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
  await requireWritableDirectory(db, directoryPath);
  return directoryPath;
}
