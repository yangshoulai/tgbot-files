import {
  listFileChunkRecords,
  listIncompleteHlsAssetRecords,
  listIncompleteMagnetImportRecords,
  listIncompleteMultipartUploadRecords,
  requireDb,
  upsertFileChunkRecord
} from "../database";
import { AppError, errorResponse, jsonResponse, parseMaxFileBytes, sanitizeFileName } from "../utils/http";
import type { AppEnv } from "../runtime";
import { ensureWritableDirectory } from "../services/directory-access";
import {
  normalizeRemoteRequestHeaders,
  normalizeSourceUrl,
  remoteRequestHeadersJson
} from "../services/remote-source";
import {
  normalizeDirectoryPath,
  normalizeMimeTypeField,
  normalizeOptionalFileName,
  normalizeRemark,
  positiveIntegerField,
  readJsonObject,
  stringField
} from "../validators/request";
import {
  completeMultipartUpload,
  createMultipartUpload,
  createThumbnailSourceInfo,
  downloadAndUploadRemoteChunk,
  expectedChunkSize,
  handleThumbnailSourceProxy,
  missingChunkIndexes,
  normalizeChunkIndex,
  normalizeFileNameConflictAction,
  normalizeUploadPreflightEntries,
  preflightUploadEntries,
  probeRemoteSourceForMultipart,
  readCompleteUploadInput,
  requireMultipartUpload,
  requireUploadApiKey,
  serializeUploadedFileResult,
  uploadChunkToTelegram,
  validateChunkFile
} from "./storage-router";
import { handleAdminHlsUploads } from "./hls-router";
import { handleAdminMagnetUploads } from "./magnet-router";
import {
  serializeChunk,
  serializeMultipartInit,
  serializeMultipartUploadStatus
} from "../serializers/multipart-upload";

export async function handleAdminMultipartUploads(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (url.pathname === "/api/admin/uploads/hls" || url.pathname.startsWith("/api/admin/uploads/hls/")) {
    return handleAdminHlsUploads(request, env, username);
  }

  if (url.pathname === "/api/admin/uploads/magnet" || url.pathname.startsWith("/api/admin/uploads/magnet/")) {
    return handleAdminMagnetUploads(request, env, username);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/uploads/tasks") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100));
    const [multipart, hls, magnet] = await Promise.all([
      listIncompleteMultipartUploadRecords(db, limit),
      listIncompleteHlsAssetRecords(db, limit),
      listIncompleteMagnetImportRecords(db, limit)
    ]);

    return jsonResponse({
      ok: true,
      tasks: [
        ...multipart.map((upload) => ({
          kind: "multipart",
          id: upload.id,
          source_kind: upload.source_kind,
          file_name: upload.file_name,
          size: upload.size,
          chunk_count: upload.chunk_count,
          directory_path: upload.directory_path,
          created_at: upload.created_at,
          completed_at: upload.completed_at
        })),
        ...hls.map((asset) => ({
          kind: "hls",
          id: asset.id,
          file_name: asset.file_name,
          status: asset.status,
          segment_count: asset.segment_count,
          directory_path: asset.directory_path,
          created_at: asset.created_at,
          updated_at: asset.updated_at,
          completed_at: asset.completed_at
        })),
        ...magnet.map((task) => ({
          kind: "magnet",
          id: task.id,
          name: task.name,
          status: task.status,
          file_count: task.file_count,
          total_size: task.total_size,
          created_at: task.created_at,
          updated_at: task.updated_at,
          completed_at: task.completed_at
        }))
      ]
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/preflight") {
    const body = await readJsonObject(request);
    const entries = normalizeUploadPreflightEntries(body.entries);
    const checked = await preflightUploadEntries(db, entries);
    const conflictCount = checked.filter((entry) => entry.status === "conflict").length;

    return jsonResponse({
      ok: true,
      entries: checked,
      summary: {
        total: checked.length,
        ready: checked.length - conflictCount,
        conflicts: conflictCount
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/init") {
    const body = await readJsonObject(request);
    const fileName = sanitizeFileName(stringField(body.file_name, "file_name"));
    const mimeType = normalizeMimeTypeField(body.mime_type);
    const size = positiveIntegerField(body.size, "size");
    const remark = normalizeRemark(body.remark) ?? null;
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createMultipartUpload({
      db,
      sourceKind: "local",
      fileName,
      mimeType,
      size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      upload: serializeMultipartInit(result)
    }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/url/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
    const remark = normalizeRemark(body.remark) ?? null;
    const fileNameOverride = normalizeOptionalFileName(body.file_name);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES), {
      forceMultipart: true,
      ...(sourceHeaders ? { sourceHeaders } : {})
    });

    if (probe.mode === "single") {
      throw new AppError(500, "InternalError", "Forced URL multipart probe returned single mode");
    }

    const sourceHeadersJson = remoteRequestHeadersJson(sourceHeaders);
    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      ...(sourceHeadersJson ? { sourceHeadersJson } : {}),
      fileName: fileNameOverride ?? probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(remark ? { remark } : {})
    });
    const thumbnailSource = await createThumbnailSourceInfo({
      request,
      env,
      uploadId: result.id,
      sourceUrl,
      mimeType: probe.mimeType,
      size: probe.size
    });
    if (thumbnailSource) {
      result.thumbnailSource = thumbnailSource;
    }

    return jsonResponse({
      ok: true,
      mode: "multipart",
      upload: serializeMultipartInit(result)
    }, 201);
  }

  const statusMatch = /^\/api\/admin\/uploads\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(statusMatch[1]));
    const chunks = await listFileChunkRecords(db, upload.id);

    return jsonResponse({
      ok: true,
      upload: serializeMultipartUploadStatus(upload),
      uploaded_chunks: chunks.map((chunk) => chunk.chunk_index),
      missing_chunks: missingChunkIndexes(upload, chunks)
    });
  }

  const chunkMatch = /^\/api\/admin\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(chunkMatch[1]), "local");
    const chunkIndex = normalizeChunkIndex(chunkMatch[2], upload);
    const formData = await request.formData();
    const chunk = formData.get("chunk");

    if (!(chunk instanceof File)) {
      throw new AppError(400, "MissingChunk", "Multipart field 'chunk' is required");
    }

    const expectedSize = expectedChunkSize(upload, chunkIndex);
    validateChunkFile(chunk, expectedSize);
    const record = await uploadChunkToTelegram({
      env,
      db,
      upload,
      chunk,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const urlChunkMatch = /^\/api\/admin\/uploads\/([^/]+)\/url-chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && urlChunkMatch?.[1] && urlChunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(urlChunkMatch[1]), "url");
    const chunkIndex = normalizeChunkIndex(urlChunkMatch[2], upload);
    const record = await downloadAndUploadRemoteChunk({
      env,
      db,
      upload,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(completeMatch[1]));
    const completeInput = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload,
      conflictAction: completeInput.conflictAction,
      ...(completeInput.thumbnail ? { thumbnail: completeInput.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/uploads/url-thumbnail-source") {
    return handleThumbnailSourceProxy(request, env);
  }

  return errorResponse(new AppError(404, "NotFound", "Admin multipart upload route not found"));
}

export async function handleApiMultipartUploads(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/v1/uploads/url-thumbnail-source") {
    return handleThumbnailSourceProxy(request, env);
  }

  const db = requireDb(env);
  await requireUploadApiKey(request, db);

  if (request.method === "POST" && url.pathname === "/api/v1/uploads/init") {
    const body = await readJsonObject(request);
    const fileName = sanitizeFileName(stringField(body.file_name, "file_name"));
    const mimeType = normalizeMimeTypeField(body.mime_type);
    const size = positiveIntegerField(body.size, "size");
    const remark = normalizeRemark(body.remark);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createMultipartUpload({
      db,
      sourceKind: "local",
      fileName,
      mimeType,
      size,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      upload: serializeMultipartInit(result)
    }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/uploads/url/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
    const remark = normalizeRemark(body.remark);
    const fileNameOverride = normalizeOptionalFileName(body.file_name);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES), {
      forceMultipart: true,
      ...(sourceHeaders ? { sourceHeaders } : {})
    });

    if (probe.mode === "single") {
      throw new AppError(500, "InternalError", "Forced URL multipart probe returned single mode");
    }

    const sourceHeadersJson = remoteRequestHeadersJson(sourceHeaders);
    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      ...(sourceHeadersJson ? { sourceHeadersJson } : {}),
      fileName: fileNameOverride ?? probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(remark ? { remark } : {})
    });
    const thumbnailSource = await createThumbnailSourceInfo({
      request,
      env,
      uploadId: result.id,
      sourceUrl,
      mimeType: probe.mimeType,
      size: probe.size
    });
    if (thumbnailSource) {
      result.thumbnailSource = thumbnailSource;
    }

    return jsonResponse({
      ok: true,
      mode: "multipart",
      upload: serializeMultipartInit(result)
    }, 201);
  }

  const chunkMatch = /^\/api\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(chunkMatch[1]), "local");
    const chunkIndex = normalizeChunkIndex(chunkMatch[2], upload);
    const formData = await request.formData();
    const chunk = formData.get("chunk");

    if (!(chunk instanceof File)) {
      throw new AppError(400, "MissingChunk", "Multipart field 'chunk' is required");
    }

    validateChunkFile(chunk, expectedChunkSize(upload, chunkIndex));
    const record = await uploadChunkToTelegram({
      env,
      db,
      upload,
      chunk,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const urlChunkMatch = /^\/api\/v1\/uploads\/([^/]+)\/url-chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && urlChunkMatch?.[1] && urlChunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(urlChunkMatch[1]), "url");
    const chunkIndex = normalizeChunkIndex(urlChunkMatch[2], upload);
    const record = await downloadAndUploadRemoteChunk({
      env,
      db,
      upload,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const completeMatch = /^\/api\/v1\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(completeMatch[1]));
    const completeInput = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload,
      conflictAction: completeInput.conflictAction,
      ...(completeInput.thumbnail ? { thumbnail: completeInput.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, null)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "API multipart upload route not found"));
}
