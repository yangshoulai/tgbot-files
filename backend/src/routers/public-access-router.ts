import {
  getHlsAssetRecord,
  listHlsSegmentRecords,
  requireDb
} from "../database";
import { verifySignedToken } from "../utils/crypto";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  requireEnv,
  withEmbeddableFileSecurityHeaders,
  withSecurityHeaders
} from "../utils/http";
import { fetchTelegramFile } from "../services/telegram";
import { DIRECT_MULTIPART_ACCESS_MAX_BYTES } from "../config/upload-limits";
import type { AppEnv } from "../runtime";
import { buildRewrittenMediaPlaylist } from "../utils/hls";
import {
  copyHeader,
  extractOptionalFileToken
} from "../utils/common-util";
import {
  hlsAssetHasDoneInitSegment,
  hlsDownloadAvailability,
  validateCompleteHlsSegments
} from "../utils/hls-util";
import {
  getPublicBaseUrl,
  getRateLimitedTelegramFileUrl,
  handleMultipartChunkAccess,
  handleMultipartFileAccess,
  hlsPublicInitSegmentPath,
  hlsPublicSegmentPath,
  requireHlsSegment,
  resolveTelegramChannel,
  serveHlsPackageDownload,
  serveHlsSegmentChunk,
  serveStoredHlsInitSegment,
  serveStoredHlsSegment
} from "./storage-router";

const HLS_PLAYLIST_MIME_TYPE = "application/vnd.apple.mpegurl";

export async function handleFileAccess(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const chunkAccess = extractMultipartChunkAccess(url.pathname);
  const token = chunkAccess?.token ?? extractFileToken(url.pathname);
  const payload = await verifySignedToken(token, requireEnv(env, "LINK_SIGNING_SECRET"));
  const rangeHeader = request.headers.get("Range");
  const forceDownload = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

  if (chunkAccess) {
    return handleMultipartChunkAccess({
      env,
      payload,
      chunkIndex: chunkAccess.chunkIndex,
      rangeHeader
    });
  }

  if (payload.v === 2) {
    return handleMultipartFileAccess({
      env,
      payload,
      rangeHeader,
      forceDownload
    });
  }

  if (payload.v === 4) {
    throw new AppError(400, "NotHlsRoute", "HLS files must be accessed through /hls");
  }

  const db = env.DATABASE;
  const channel = await resolveTelegramChannel(env, db, payload.v === 3 ? payload.channel_id : "default");
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: payload.file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader
  });
  const headers = withEmbeddableFileSecurityHeaders();

  headers.set("Content-Type", payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    forceDownload
      ? contentDispositionAttachment(payload.name)
      : contentDispositionInline(payload.name)
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  copyHeader(telegramResponse.headers, headers, "Content-Length");
  copyHeader(telegramResponse.headers, headers, "Content-Range");
  copyHeader(telegramResponse.headers, headers, "Accept-Ranges");

  return new Response(telegramResponse.body, {
    status: telegramResponse.status,
    statusText: telegramResponse.statusText,
    headers
  });
}

export async function handleHlsAccess(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const access = extractHlsAccess(url.pathname);
  const payload = await verifySignedToken(access.token, requireEnv(env, "LINK_SIGNING_SECRET"));

  if (payload.v !== 4) {
    throw new AppError(400, "NotHlsFile", "HLS access token is required");
  }

  const db = requireDb(env);
  const asset = await getHlsAssetRecord(db, payload.hls_asset_id);
  if (!asset || asset.final_file_id !== payload.file_record_id || asset.status !== "done") {
    throw new AppError(404, "HlsAssetNotFound", "HLS 文件不存在");
  }

  if (access.segmentIndex !== undefined) {
    const segment = await requireHlsSegment(db, asset.id, access.segmentIndex);
    if (access.chunkIndex !== undefined) {
      return serveHlsSegmentChunk({
        env,
        db,
        segment,
        chunkIndex: access.chunkIndex,
        rangeHeader: request.headers.get("Range"),
        forceDownload: isForcedDownload(url)
      });
    }

    return serveStoredHlsSegment({
      env,
      db,
      segment,
      rangeHeader: request.headers.get("Range"),
      forceDownload: isForcedDownload(url)
    });
  }

  if (access.initSegment) {
    return serveStoredHlsInitSegment({
      env,
      db,
      asset,
      rangeHeader: request.headers.get("Range"),
      forceDownload: isForcedDownload(url)
    });
  }

  const segments = await listHlsSegmentRecords(db, asset.id);
  validateCompleteHlsSegments(asset, segments);

  if (isForcedDownload(url)) {
    const downloadInfo = hlsDownloadAvailability(asset, segments);
    if (!downloadInfo.downloadable) {
      throw new AppError(400, "UnsupportedHlsDownload", "当前仅支持 TS 或 fMP4 HLS 顺序合并下载");
    }
    if (!downloadInfo.directAccess) {
      throw new AppError(
        403,
        "DirectAccessDisabled",
        "该 HLS 文件超过系统直链大小上限，不提供整包直链下载，请在控制台使用加速下载",
        {
          hls_download_part_count: downloadInfo.partCount,
          direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
        }
      );
    }

    return serveHlsPackageDownload({
      env,
      db,
      asset,
      segments,
      fileName: payload.name
    });
  }

  const baseUrl = getPublicBaseUrl(request, env);
  const playlist = buildRewrittenMediaPlaylist({
    playlistText: asset.playlist_text,
    targetDuration: asset.target_duration_seconds,
    initSegmentPath: hlsAssetHasDoneInitSegment(asset)
      ? `${baseUrl}${hlsPublicInitSegmentPath(access.token, asset)}`
      : null,
    segments: segments.map((segment) => ({
      index: segment.segment_index,
      duration: segment.duration_seconds,
      path: `${baseUrl}${hlsPublicSegmentPath(access.token, segment)}`
    }))
  });
  const headers = withSecurityHeaders();
  headers.set("Content-Type", `${HLS_PLAYLIST_MIME_TYPE}; charset=utf-8`);
  headers.set("Content-Disposition", contentDispositionInline(payload.name));
  headers.set("Cache-Control", "public, max-age=60");

  return new Response(playlist, { headers });
}

function isForcedDownload(url: URL): boolean {
  return url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";
}

function extractFileToken(pathname: string): string {
  const token = extractOptionalFileToken(pathname);

  if (!token) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  return token;
}

function extractMultipartChunkAccess(pathname: string): { token: string; chunkIndex: number } | null {
  const match = /^\/f\/([^/]+)\/chunks\/([^/]+)$/.exec(pathname);

  if (!match) {
    return null;
  }

  const token = match[1];
  const chunkIndex = Number(match[2]);
  if (!token) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index must be a non-negative integer");
  }

  return {
    token,
    chunkIndex
  };
}

function extractHlsAccess(pathname: string): { token: string; initSegment?: boolean; segmentIndex?: number; chunkIndex?: number } {
  const parts = pathname.split("/").filter(Boolean);
  const tokenPartIndex = parts[0] === "hls"
    ? 1
    : parts[0] === "api" && parts[1] === "hls"
      ? 2
      : -1;
  const token = tokenPartIndex >= 0 && parts[tokenPartIndex] ? decodeURIComponent(parts[tokenPartIndex]) : "";

  if (!token) {
    throw new AppError(404, "NotFound", "HLS route not found");
  }

  const segmentsPartIndex = tokenPartIndex + 1;
  if (parts[segmentsPartIndex] === "init") {
    return { token, initSegment: true };
  }

  if (parts[segmentsPartIndex] !== "segments") {
    return { token };
  }

  const segmentIndex = Number(parts[segmentsPartIndex + 1]);
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
    throw new AppError(400, "InvalidSegmentIndex", "HLS segment index must be a non-negative integer");
  }

  const chunkPartIndex = segmentsPartIndex + 2;
  if (parts[chunkPartIndex] === undefined) {
    return { token, segmentIndex };
  }

  if (parts[chunkPartIndex] !== "chunks") {
    return { token, segmentIndex };
  }

  const chunkIndex = Number(parts[chunkPartIndex + 1]);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AppError(400, "InvalidChunkIndex", "HLS segment chunk index must be a non-negative integer");
  }

  return { token, segmentIndex, chunkIndex };
}
