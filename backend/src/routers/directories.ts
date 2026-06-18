import {
  deleteDirectoryTree,
  insertDirectoryRecord,
  listAllDirectoryRecords,
  listDirectoryChildren,
  moveDirectoryTree,
  renameDirectoryTree,
  requireDb
} from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import { serializeDirectoryRecord } from "../serializers/directory";
import { requireReadableDirectory } from "../services/directory-access";
import { normalizeDirectoryName, normalizeDirectoryPath, readJsonObject } from "../validators/request";

export async function handleAdminDirectories(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/directories") {
    const flat = url.searchParams.get("flat") === "1" || url.searchParams.get("flat") === "true";
    const parentPath = normalizeDirectoryPath(url.searchParams.get("parent_path") || "/");
    if (!flat) {
      await requireReadableDirectory(db, parentPath);
    }
    const directories = flat
      ? await listAllDirectoryRecords(db)
      : await listDirectoryChildren(db, parentPath);

    return jsonResponse({
      ok: true,
      directories: directories.map((directory) => serializeDirectoryRecord(directory))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/directories") {
    const body = await readJsonObject(request);
    const parentPath = normalizeDirectoryPath(body.parent_path ?? "/");
    const name = normalizeDirectoryName(body.name);
    const record = await insertDirectoryRecord({
      db,
      parentPath,
      name,
      createdAt: new Date().toISOString()
    });

    return jsonResponse({ ok: true, directory: serializeDirectoryRecord(record) }, 201);
  }

  const match = /^\/api\/admin\/directories\/([^/]+)$/.exec(url.pathname);
  const moveMatch = /^\/api\/admin\/directories\/([^/]+)\/move$/.exec(url.pathname);
  if (request.method === "PATCH" && moveMatch?.[1]) {
    const body = await readJsonObject(request);
    const parentPath = normalizeDirectoryPath(body.parent_path ?? "/");
    const result = await moveDirectoryTree({
      db,
      id: decodeURIComponent(moveMatch[1]),
      parentPath
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      directory: serializeDirectoryRecord(result.directory),
      moved_directories: result.movedDirectories,
      moved_files: result.movedFiles
    });
  }

  if (request.method === "PATCH" && match?.[1]) {
    const body = await readJsonObject(request);
    const name = normalizeDirectoryName(body.name);
    const result = await renameDirectoryTree({
      db,
      id: decodeURIComponent(match[1]),
      name
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      directory: serializeDirectoryRecord(result.directory),
      renamed_directories: result.renamedDirectories,
      updated_files: result.updatedFiles
    });
  }

  if (request.method === "DELETE" && match?.[1]) {
    const result = await deleteDirectoryTree({
      db,
      id: decodeURIComponent(match[1])
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      deleted_directories: result.deletedDirectories,
      deleted_files: result.deletedFiles,
      directory: serializeDirectoryRecord(result.directory)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin directory route not found"));
}
