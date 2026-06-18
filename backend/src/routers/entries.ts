import {
  deleteDirectoryTree,
  deleteFileRecord,
  moveDirectoryTree,
  moveFileRecords,
  requireDb,
  type FileRecord
} from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppDatabase, AppEnv } from "../runtime";
import {
  moveTargetParentPath,
  requireDirectoryRecords,
  requireFileRecords,
  resolveMoveTargetDirectory,
  validateEntryMoveParent,
  validateEntryMoveTarget
} from "../services/directory-access";
import { normalizeOptionalIdList, readJsonObject, requireEntrySelection } from "../validators/request";

export interface AdminEntriesDependencies {
  requireFileMoveNamesAvailable: (params: {
    db: AppDatabase;
    files: FileRecord[];
    directoryPath: string;
  }) => Promise<void>;
}

export async function handleAdminEntries(
  request: Request,
  env: AppEnv,
  dependencies: AdminEntriesDependencies
): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "PATCH" && url.pathname === "/api/admin/entries/move") {
    const body = await readJsonObject(request);
    const fileIds = normalizeOptionalIdList(body.file_ids, "file_ids");
    const directoryIds = normalizeOptionalIdList(body.directory_ids, "directory_ids");
    requireEntrySelection(fileIds, directoryIds);

    const directoriesToMove = await requireDirectoryRecords(db, directoryIds);
    const filesToMove = await requireFileRecords(db, fileIds);
    validateEntryMoveParent(directoriesToMove, moveTargetParentPath(body));
    const directoryPath = await resolveMoveTargetDirectory(db, body);
    await validateEntryMoveTarget(db, directoriesToMove, directoryPath);
    await dependencies.requireFileMoveNamesAvailable({
      db,
      files: filesToMove,
      directoryPath
    });

    let movedDirectories = 0;
    let movedFiles = 0;

    for (const directory of directoriesToMove) {
      const result = await moveDirectoryTree({
        db,
        id: directory.id,
        parentPath: directoryPath
      });

      if (!result) {
        throw new AppError(404, "DirectoryNotFound", "Directory not found");
      }

      movedDirectories += result.movedDirectories;
      movedFiles += result.movedFiles;
    }

    movedFiles += await moveFileRecords({
      db,
      ids: fileIds,
      directoryPath
    });

    return jsonResponse({
      ok: true,
      moved: movedDirectories + movedFiles,
      moved_directories: movedDirectories,
      moved_files: movedFiles,
      directory_path: directoryPath
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/entries/delete") {
    const body = await readJsonObject(request);
    const fileIds = normalizeOptionalIdList(body.file_ids, "file_ids");
    const directoryIds = normalizeOptionalIdList(body.directory_ids, "directory_ids");
    requireEntrySelection(fileIds, directoryIds);
    await requireFileRecords(db, fileIds);
    await requireDirectoryRecords(db, directoryIds);

    let deletedDirectories = 0;
    let deletedFiles = 0;

    for (const fileId of fileIds) {
      const deleted = await deleteFileRecord(db, fileId);
      if (!deleted) {
        throw new AppError(404, "NotFound", "File record not found");
      }
      deletedFiles += 1;
    }

    for (const directoryId of directoryIds) {
      const result = await deleteDirectoryTree({
        db,
        id: directoryId
      });

      if (!result) {
        throw new AppError(404, "DirectoryNotFound", "Directory not found");
      }

      deletedDirectories += result.deletedDirectories;
      deletedFiles += result.deletedFiles;
    }

    return jsonResponse({
      ok: true,
      deleted_directories: deletedDirectories,
      deleted_files: deletedFiles
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin entry route not found"));
}
