import {
  deleteFileRecord,
  getDirectoryUsageStats,
  getFileRecord,
  getGlobalFileUsageStats,
  getTelegramChunkSizeBytesSetting,
  listDirectoryChildren,
  listFileRecords,
  moveFileRecords,
  requireDb,
  updateFileRecordMetadata,
  updateFileRecordThumbnail,
  type FileRecord
} from "../database";
import { AppError, errorResponse, jsonResponse, parseMaxFileBytes, sanitizeFileName } from "../utils/http";
import type { AppEnv } from "../runtime";
import {
  ensureWritableDirectory,
  requireFileRecords,
  requireReadableDirectory,
  resolveMoveTargetDirectory
} from "../services/directory-access";
import {
  DIRECT_MULTIPART_ACCESS_MAX_BYTES,
  MAX_TELEGRAM_MULTIPART_BYTES,
  maxTelegramMultipartChunks
} from "../config/upload-limits";
import { serializeCurrentDirectory, serializeDirectoryRecord } from "../serializers/directory";
import {
  normalizeDateTimeParam,
  normalizeDirectoryPath,
  normalizeFileIdList,
  normalizeFileNameUpdate,
  normalizeFileTypeFilter,
  normalizeMimeTypeField,
  normalizeQueryIdList,
  normalizeRemarkUpdate,
  parsePositiveInteger,
  readJsonObject
} from "../validators/request";
import { readThumbnailRequestInput } from "../services/upload-input";
import {
  createFilePathForRecord,
  emptyThumbnailRecordUpdateFields,
  getPublicBaseUrl,
  handleMultipartChunkRecordAccess,
  readUploadInput,
  requireFileMoveNamesAvailable,
  requireFileNameAvailable,
  requireFileNameWritable,
  requireFileRecord,
  requireUploadApiKey,
  serializeFileRecord,
  serializeHlsDownloadPlanForFile,
  serializeUploadedFileResult,
  thumbnailRecordUpdateFields,
  uploadAndRecordFile,
  uploadThumbnailToTelegram
} from "./storage-router";

export { requireFileMoveNamesAvailable };

export async function handleApiFiles(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);
  await requireUploadApiKey(request, db);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/v1/files") {
    const { file, directoryPath, conflictAction, thumbnail } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    await requireFileNameWritable({
      db,
      directoryPath,
      fileName: sanitizeFileName(file.name),
      conflictAction
    });
    const result = await uploadAndRecordFile({
      request,
      env,
      file,
      db,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(thumbnail ? { thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      id: result.id,
      url: result.publicUrl,
      name: result.name,
      size: result.size,
      mime_type: result.mimeType
    });
  }

  const chunkMatch = /^\/api\/v1\/files\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const file = await requireFileRecord(db, decodeURIComponent(chunkMatch[1]));
    const chunkIndex = Number(chunkMatch[2]);

    return handleMultipartChunkRecordAccess({
      env,
      file,
      chunkIndex
    });
  }

  const fileMatch = /^\/api\/v1\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && fileMatch?.[1]) {
    const file = await requireFileRecord(db, decodeURIComponent(fileMatch[1]));

    return jsonResponse({
      ok: true,
      file: await serializeFileRecord(file, getPublicBaseUrl(request, env), db)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "API file route not found"));
}

export async function handleAdminFiles(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/files") {
    const listAll = url.searchParams.get("all") === "1" || url.searchParams.get("limit") === "all";
    const page = parsePositiveInteger(url.searchParams.get("page"), 1, 1, 100000);
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 24, 1, 100000);
    const type = normalizeFileTypeFilter(url.searchParams.get("type"));
    const createdFrom = normalizeDateTimeParam(url.searchParams.get("created_from"), "created_from");
    const createdTo = normalizeDateTimeParam(url.searchParams.get("created_to"), "created_to");
    const directoryPath = normalizeDirectoryPath(url.searchParams.get("dir") || "/");
    const currentDirectory = await requireReadableDirectory(db, directoryPath);
    const normalizedQuery = url.searchParams.get("q") || "";
    const queryParams = {
      db,
      query: normalizedQuery,
      directoryPath,
      ...(type ? { type } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {})
    };
    const result = listAll
      ? await listFileRecords(queryParams)
      : await listFileRecords({ ...queryParams, page, limit });
    const [directories, globalStats] = await Promise.all([
      listDirectoryChildren(db, directoryPath),
      getGlobalFileUsageStats(db)
    ]);
    const directoryStats = await getDirectoryUsageStats(db, directories);
    const baseUrl = getPublicBaseUrl(request, env);
    const telegramChunkSizeBytes = await getTelegramChunkSizeBytesSetting(db);
    const files = await Promise.all(result.files.map((file) => serializeFileRecord(file, baseUrl, db)));

    return jsonResponse({
      ok: true,
      current_directory: serializeCurrentDirectory(currentDirectory, directoryPath),
      directories: directories.map((directory) => serializeDirectoryRecord(directory, directoryStats.get(directory.path))),
      search_scope: "current",
      files,
      pagination: {
        page: listAll ? 1 : page,
        limit: listAll ? result.total : limit,
        total: result.total,
        total_pages: listAll ? 1 : Math.max(1, Math.ceil(result.total / limit))
      },
      global_stats: globalStats,
      max_file_bytes: parseMaxFileBytes(env.MAX_FILE_BYTES),
      multipart_chunk_bytes: telegramChunkSizeBytes,
      max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
      direct_access_max_chunks: maxTelegramMultipartChunks(telegramChunkSizeBytes),
      direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
    });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/files/lookup") {
    const ids = normalizeQueryIdList(url.searchParams.get("ids"), "ids");
    const files = await Promise.all(ids.map((id) => getFileRecord(db, id)));
    const baseUrl = getPublicBaseUrl(request, env);
    const serialized = await Promise.all(
      files
        .filter((file): file is NonNullable<typeof file> => Boolean(file))
        .map((file) => serializeFileRecord(file, baseUrl, db))
    );

    return jsonResponse({
      ok: true,
      files: serialized
    });
  }

  const hlsDownloadMatch = /^\/api\/admin\/files\/([^/]+)\/hls-download$/.exec(url.pathname);
  if (request.method === "GET" && hlsDownloadMatch?.[1]) {
    const file = await requireFileRecord(db, decodeURIComponent(hlsDownloadMatch[1]));

    return jsonResponse({
      ok: true,
      hls_download: await serializeHlsDownloadPlanForFile({
        request,
        env,
        db,
        file
      })
    });
  }

  const thumbnailMatch = /^\/api\/admin\/files\/([^/]+)\/thumbnail$/.exec(url.pathname);
  if ((request.method === "PUT" || request.method === "PATCH" || request.method === "POST") && thumbnailMatch?.[1]) {
    const id = decodeURIComponent(thumbnailMatch[1]);
    const file = await requireFileRecord(db, id);
    const thumbnail = await readThumbnailRequestInput(request);

    if (!thumbnail) {
      throw new AppError(400, "MissingThumbnail", "Thumbnail file or thumbnail_url is required");
    }

    const uploaded = await uploadThumbnailToTelegram({
      request,
      env,
      db,
      originalFileName: file.file_name,
      thumbnail
    });
    const updated = await updateFileRecordThumbnail({
      db,
      id,
      thumbnail: thumbnailRecordUpdateFields(uploaded)
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({
      ok: true,
      file: await serializeFileRecord(updated, getPublicBaseUrl(request, env), db)
    });
  }

  if (request.method === "DELETE" && thumbnailMatch?.[1]) {
    const id = decodeURIComponent(thumbnailMatch[1]);
    await requireFileRecord(db, id);
    const updated = await updateFileRecordThumbnail({
      db,
      id,
      thumbnail: emptyThumbnailRecordUpdateFields()
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({
      ok: true,
      file: await serializeFileRecord(updated, getPublicBaseUrl(request, env), db)
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/files") {
    const { file: formFile, remark, directoryPath, conflictAction, thumbnail } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    await requireFileNameWritable({
      db,
      directoryPath,
      fileName: sanitizeFileName(formFile.name),
      conflictAction
    });
    const result = await uploadAndRecordFile({
      request,
      env,
      file: formFile,
      db,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(thumbnail ? { thumbnail } : {}),
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  if (request.method === "PATCH" && url.pathname === "/api/admin/files/move") {
    const body = await readJsonObject(request);
    const fileIds = normalizeFileIdList(body.file_ids);
    const directoryPath = await resolveMoveTargetDirectory(db, body);
    const files = await requireFileRecords(db, fileIds);
    await requireFileMoveNamesAvailable({
      db,
      files,
      directoryPath
    });
    const moved = await moveFileRecords({
      db,
      ids: fileIds,
      directoryPath
    });

    return jsonResponse({ ok: true, moved, directory_path: directoryPath });
  }

  const updateMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PATCH" && updateMatch?.[1]) {
    const id = decodeURIComponent(updateMatch[1]);
    const existing = await getFileRecord(db, id);

    if (!existing) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    const body = await readJsonObject(request);
    const hasFileName = Object.prototype.hasOwnProperty.call(body, "file_name");
    const hasMimeType = Object.prototype.hasOwnProperty.call(body, "mime_type");
    const hasRemark = Object.prototype.hasOwnProperty.call(body, "remark");

    if (!hasFileName && !hasMimeType && !hasRemark) {
      throw new AppError(400, "InvalidBody", "file_name, mime_type or remark is required");
    }

    const nextFileName = hasFileName ? normalizeFileNameUpdate(body.file_name) : existing.file_name;
    const nextMimeType = hasMimeType ? normalizeMimeTypeField(body.mime_type) : existing.mime_type;
    const nextRemark = hasRemark ? normalizeRemarkUpdate(body.remark) : existing.remark;
    if (nextFileName !== existing.file_name) {
      await requireFileNameAvailable({
        db,
        directoryPath: existing.directory_path ?? "/",
        fileName: nextFileName,
        excludeId: existing.id
      });
    }
    const nextFilePath = nextFileName === existing.file_name && nextMimeType === existing.mime_type
      ? existing.file_path
      : await createFilePathForRecord({ ...existing, mime_type: nextMimeType }, nextFileName, env);
    const updated = await updateFileRecordMetadata({
      db,
      id,
      fileName: nextFileName,
      mimeType: nextMimeType,
      remark: nextRemark,
      filePath: nextFilePath
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({
      ok: true,
      file: await serializeFileRecord(updated, getPublicBaseUrl(request, env), db)
    });
  }

  const deleteMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const deleted = await deleteFileRecord(db, decodeURIComponent(deleteMatch[1]));

    if (!deleted) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin file route not found"));
}
