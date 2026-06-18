import {
  deleteHlsAssetTempData,
  listHlsSegmentRecords,
  requireDb
} from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import { ensureWritableDirectory } from "../services/directory-access";
import {
  normalizeRemoteRequestHeaders,
  normalizeSourceUrl
} from "../services/remote-source";
import {
  normalizeDirectoryPath,
  normalizeOptionalFileName,
  normalizeRemark,
  optionalTrimmedString,
  readJsonObject
} from "../validators/request";
import { normalizeHlsSegmentIndex } from "../utils/hls-util";
import { serializeHlsProbeResult } from "../serializers/hls";
import {
  completeHlsMultipartSegment,
  completeHlsUpload,
  createHlsUpload,
  handleAdminHlsPreviewPlaylist,
  importHlsSegment,
  importHlsSegmentChunk,
  normalizeFileNameConflictAction,
  probeHlsSource,
  readCompleteUploadInput,
  requireHlsAsset,
  requireHlsSegment,
  requireMutableHlsAsset,
  serializeHlsSegment,
  serializeHlsUploadResult,
  serializeUploadedFileResult,
  serveStoredHlsInitSegment,
  serveStoredHlsSegment
} from "./storage-router";

export async function handleAdminHlsUploads(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/hls/probe") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
    const variantId = optionalTrimmedString(body.variant_id, 80);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const result = await probeHlsSource(sourceUrl, variantId, sourceHeaders);
    return jsonResponse({ ok: true, hls: serializeHlsProbeResult(result) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/hls/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createHlsUpload({
      db,
      sourceUrl,
      ...(sourceHeaders ? { sourceHeaders } : {}),
      selectedVariantId: optionalTrimmedString(body.variant_id, 80),
      fileNameOverride: normalizeOptionalFileName(body.file_name),
      conflictAction: normalizeFileNameConflictAction(body.on_conflict),
      remark: normalizeRemark(body.remark),
      uploadedBy: username,
      directoryId: directory?.id ?? null,
      directoryPath
    });

    return jsonResponse({
      ok: true,
      hls: await serializeHlsUploadResult(db, request, env, result)
    }, 201);
  }

  const statusMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const asset = await requireHlsAsset(db, decodeURIComponent(statusMatch[1]));
    const segments = await listHlsSegmentRecords(db, asset.id);

    return jsonResponse({
      ok: true,
      hls: await serializeHlsUploadResult(db, request, env, { asset, segments })
    });
  }

  const previewPlaylistMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/preview\.m3u8$/.exec(url.pathname);
  if (request.method === "GET" && previewPlaylistMatch?.[1]) {
    return handleAdminHlsPreviewPlaylist(request, env, decodeURIComponent(previewPlaylistMatch[1]));
  }

  const previewInitMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/preview-init(?:\/[^/]+)?$/.exec(url.pathname);
  if (request.method === "GET" && previewInitMatch?.[1]) {
    const asset = await requireHlsAsset(db, decodeURIComponent(previewInitMatch[1]));
    return serveStoredHlsInitSegment({
      env,
      db,
      asset,
      rangeHeader: request.headers.get("Range"),
      forceDownload: false
    });
  }

  const previewSegmentMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/preview-segments\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && previewSegmentMatch?.[1] && previewSegmentMatch?.[2]) {
    const asset = await requireHlsAsset(db, decodeURIComponent(previewSegmentMatch[1]));
    const segment = await requireHlsSegment(db, asset.id, normalizeHlsSegmentIndex(previewSegmentMatch[2], asset.segment_count));
    return serveStoredHlsSegment({
      env,
      db,
      segment,
      rangeHeader: request.headers.get("Range"),
      forceDownload: false
    });
  }

  const segmentImportMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/segments\/(\d+)\/import$/.exec(url.pathname);
  if (request.method === "POST" && segmentImportMatch?.[1] && segmentImportMatch?.[2]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(segmentImportMatch[1]));
    const segmentIndex = normalizeHlsSegmentIndex(segmentImportMatch[2], asset.segment_count);
    const result = await importHlsSegment({
      env,
      db,
      asset,
      segmentIndex
    });

    return jsonResponse({
      ok: true,
      segment: await serializeHlsSegment(db, result.segment),
      uploaded_chunks: result.uploadedChunks,
      missing_chunks: result.missingChunks
    });
  }

  const segmentChunkMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/segments\/(\d+)\/chunks\/(\d+)\/import$/.exec(url.pathname);
  if (request.method === "POST" && segmentChunkMatch?.[1] && segmentChunkMatch?.[2] && segmentChunkMatch?.[3]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(segmentChunkMatch[1]));
    const segmentIndex = normalizeHlsSegmentIndex(segmentChunkMatch[2], asset.segment_count);
    const result = await importHlsSegmentChunk({
      env,
      db,
      asset,
      segmentIndex,
      chunkIndexValue: segmentChunkMatch[3]
    });

    return jsonResponse({
      ok: true,
      segment: await serializeHlsSegment(db, result.segment),
      uploaded_chunks: result.uploadedChunks,
      missing_chunks: result.missingChunks
    });
  }

  const segmentCompleteMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/segments\/(\d+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && segmentCompleteMatch?.[1] && segmentCompleteMatch?.[2]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(segmentCompleteMatch[1]));
    const segmentIndex = normalizeHlsSegmentIndex(segmentCompleteMatch[2], asset.segment_count);
    const result = await completeHlsMultipartSegment({
      db,
      asset,
      segmentIndex
    });

    return jsonResponse({
      ok: true,
      segment: await serializeHlsSegment(db, result.segment),
      uploaded_chunks: result.uploadedChunks,
      missing_chunks: result.missingChunks
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(completeMatch[1]));
    const completeInput = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeHlsUpload({
      request,
      env,
      db,
      asset,
      conflictAction: completeInput.conflictAction,
      ...(completeInput.thumbnail ? { thumbnail: completeInput.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  const deleteMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const cleanup = await deleteHlsAssetTempData(db, decodeURIComponent(deleteMatch[1]));
    return jsonResponse({ ok: true, cleanup });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin HLS upload route not found"));
}
