import {
  listFileChunkRecords,
  requireDb
} from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import {
  normalizeDirectoryPath,
  normalizeRemark,
  readJsonObject
} from "../validators/request";
import {
  normalizeMagnetFileIndexes,
  normalizeMagnetUri,
  parseMagnetFileIndex
} from "../utils/magnet-util";
import { serializeChunk } from "../serializers/multipart-upload";
import {
  cancelMagnetImportUpload,
  completeMagnetFileUpload,
  createMagnetImport,
  importMagnetFileChunk,
  initMagnetImportSelection,
  normalizeFileNameConflictAction,
  normalizeMagnetFileUploadOptions,
  readCompleteUploadInput,
  refreshMagnetImportStatus,
  serializeMagnetImport,
  serializeUploadedFileResult,
  serveMagnetThumbnailSource
} from "./storage-router";

export async function handleAdminMagnetUploads(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/magnet/probe") {
    const body = await readJsonObject(request);
    const magnetUri = normalizeMagnetUri(body.magnet ?? body.url);
    const result = await createMagnetImport({
      env,
      db,
      magnetUri,
      uploadedBy: username
    });

    return jsonResponse({
      ok: true,
      magnet: serializeMagnetImport(result.importRecord, result.files, result.aria2Status)
    }, 201);
  }

  const statusMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const result = await refreshMagnetImportStatus(env, db, decodeURIComponent(statusMatch[1]));
    return jsonResponse({
      ok: true,
      magnet: serializeMagnetImport(result.importRecord, result.files, result.aria2Status)
    });
  }

  const initMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/init$/.exec(url.pathname);
  if (request.method === "POST" && initMatch?.[1]) {
    const body = await readJsonObject(request);
    const importId = decodeURIComponent(initMatch[1]);
    const fileIndexes = normalizeMagnetFileIndexes(body.file_indexes ?? body.files);
    const fileOptions = normalizeMagnetFileUploadOptions(body.file_options, fileIndexes);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const remark = normalizeRemark(body.remark) ?? null;
    const result = await initMagnetImportSelection({
      env,
      db,
      importId,
      fileIndexes,
      fileOptions,
      directoryPath,
      conflictAction,
      remark,
      uploadedBy: username
    });

    return jsonResponse({
      ok: true,
      magnet: serializeMagnetImport(result.importRecord, result.files, result.aria2Status),
      uploads: result.uploads
    });
  }

  const thumbnailSourceMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/files\/(\d+)\/thumbnail-source$/.exec(url.pathname);
  if (request.method === "GET" && thumbnailSourceMatch?.[1] && thumbnailSourceMatch?.[2]) {
    return serveMagnetThumbnailSource({
      request,
      env,
      db,
      importId: decodeURIComponent(thumbnailSourceMatch[1]),
      fileIndex: parseMagnetFileIndex(thumbnailSourceMatch[2])
    });
  }

  const chunkMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/files\/(\d+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2] && chunkMatch?.[3]) {
    const importId = decodeURIComponent(chunkMatch[1]);
    const fileIndex = parseMagnetFileIndex(chunkMatch[2]);
    const chunkIndex = Number(chunkMatch[3]);
    const result = await importMagnetFileChunk({
      env,
      db,
      importId,
      fileIndex,
      chunkIndex
    });

    return jsonResponse({
      ok: true,
      chunk: serializeChunk(result.record),
      uploaded_chunks: (await listFileChunkRecords(db, result.upload.id)).length
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/files\/(\d+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1] && completeMatch?.[2]) {
    const importId = decodeURIComponent(completeMatch[1]);
    const fileIndex = parseMagnetFileIndex(completeMatch[2]);
    const input = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeMagnetFileUpload({
      request,
      env,
      db,
      importId,
      fileIndex,
      conflictAction: input.conflictAction,
      ...(input.thumbnail ? { thumbnail: input.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  const deleteMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const importId = decodeURIComponent(deleteMatch[1]);
    const cleanup = await cancelMagnetImportUpload(env, db, importId);
    return jsonResponse({ ok: true, cleanup });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin magnet upload route not found"));
}
