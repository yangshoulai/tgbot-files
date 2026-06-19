import {
  getFileChunkRecord,
  listFileChunkRecords,
  listHlsSegmentRecords,
  requireDb,
  type HlsAssetRecord,
  type HlsSegmentRecord
} from "../database";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  withSecurityHeaders
} from "../utils/http";
import {
  buildRewrittenMediaPlaylist,
  hlsInitSegmentFileName,
  hlsSegmentFileName
} from "../utils/hls";
import { fetchTelegramFile } from "../services/telegram";
import type { AppDatabase, AppEnv } from "../runtime";
import { copyHeader } from "../utils/common-util";
import {
  hlsAssetHasDoneInitSegment,
  hlsDownloadAvailability,
  hlsDownloadContentType,
  hlsDownloadFileName,
  hlsDownloadItems,
  hlsDownloadTotalSize,
  leadingDoneHlsSegments,
  requireHlsInitSegmentSize,
  requireHlsSegmentSize,
  type HlsDownloadKind
} from "../utils/hls-util";
import {
  expectedRecordChunkSize,
  parseByteRange,
  rangeNotSatisfiableResponse,
  recordChunkDownloadFileName,
  requirePositiveRecordInteger,
  type ParsedByteRange
} from "./storage-shared";
import {
  getRateLimitedTelegramFileUrl,
  resolveTelegramChannel
} from "./telegram-channel";
import { requireHlsAsset } from "./hls-upload";
import {
  streamMultipartFile,
  validateTokenChunks
} from "./multipart-access";

const HLS_PLAYLIST_MIME_TYPE = "application/vnd.apple.mpegurl";
const HLS_PREVIEW_SEGMENT_COUNT = 4;

export async function handleAdminHlsPreviewPlaylist(request: Request, env: AppEnv, assetId: string): Promise<Response> {
  const db = requireDb(env);
  const asset = await requireHlsAsset(db, assetId);
  const doneSegments = leadingDoneHlsSegments(await listHlsSegmentRecords(db, asset.id), HLS_PREVIEW_SEGMENT_COUNT);

  if (doneSegments.length === 0) {
    throw new AppError(409, "HlsPreviewNotReady", "至少需要完成 1 个 HLS segment 后才能生成预览 playlist");
  }

  if (asset.init_source_url && !hlsAssetHasDoneInitSegment(asset)) {
    throw new AppError(409, "HlsPreviewNotReady", "HLS init segment 尚未导入完成");
  }

  const baseUrl = new URL(request.url).origin;
  const playlist = buildRewrittenMediaPlaylist({
    targetDuration: asset.target_duration_seconds,
    initSegmentPath: asset.init_source_url
      ? `${baseUrl}/api/admin/uploads/hls/${encodeURIComponent(asset.id)}/preview-init/${encodeURIComponent(hlsInitSegmentFileName(new URL(asset.init_source_url)))}`
      : null,
    segments: doneSegments.map((segment) => ({
      index: segment.segment_index,
      duration: segment.duration_seconds,
      path: `${baseUrl}/api/admin/uploads/hls/${encodeURIComponent(asset.id)}/preview-segments/${segment.segment_index}`
    }))
  });
  const headers = withSecurityHeaders();
  headers.set("Content-Type", `${HLS_PLAYLIST_MIME_TYPE}; charset=utf-8`);
  headers.set("Cache-Control", "no-store");

  return new Response(playlist, { headers });
}

export async function serveHlsPackageDownload(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  segments: HlsSegmentRecord[];
  fileName: string;
}): Promise<Response> {
  const availability = hlsDownloadAvailability(params.asset, params.segments);
  if (!availability.downloadable || !availability.kind) {
    throw new AppError(400, "UnsupportedHlsDownload", "当前仅支持 TS 或 fMP4 HLS 顺序合并下载");
  }

  const totalSize = hlsDownloadTotalSize(params.asset, params.segments, availability.kind);
  const headers = withSecurityHeaders();
  headers.set("Content-Type", hlsDownloadContentType(availability.kind));
  headers.set("Content-Disposition", contentDispositionAttachment(hlsDownloadFileName(params.fileName, availability.kind)));
  headers.set("Content-Length", String(totalSize));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(streamHlsSegmentsForDownload({
    env: params.env,
    db: params.db,
    asset: params.asset,
    segments: params.segments,
    kind: availability.kind
  }), { headers });
}

export async function serveStoredHlsInitSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!params.asset.init_source_url) {
    throw new AppError(404, "HlsInitSegmentNotFound", "HLS init segment 不存在");
  }

  if (!hlsAssetHasDoneInitSegment(params.asset)) {
    throw new AppError(404, "HlsInitSegmentNotReady", "HLS init segment 尚未导入完成");
  }

  const size = requireHlsInitSegmentSize(params.asset);
  const range = parseByteRange(params.rangeHeader, size);
  if (!range) {
    return rangeNotSatisfiableResponse(size);
  }

  const channel = await resolveTelegramChannel(params.env, params.db, params.asset.init_telegram_channel_id);
  const initTelegramFileId = params.asset.init_telegram_file_id;
  if (!initTelegramFileId) {
    throw new AppError(404, "HlsInitSegmentNotFound", "HLS init segment 文件不存在");
  }
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: initTelegramFileId
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: range.partial ? `bytes=${range.start}-${range.end}` : null
  });

  if (range.partial && telegramResponse.status !== 206 && (range.start !== 0 || range.end !== size - 1)) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
  }

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const headers = hlsInitSegmentHeaders(params.asset, range, params.forceDownload, telegramResponse.headers.get("Content-Type"));
  copyHeader(telegramResponse.headers, headers, "Content-Range");

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    statusText: telegramResponse.statusText,
    headers
  });
}

export async function serveStoredHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (params.segment.status !== "done") {
    throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
  }

  if (params.segment.storage_backend === "telegram_single") {
    return serveSingleHlsSegment(params);
  }

  if (params.segment.storage_backend === "telegram_multipart") {
    return serveMultipartHlsSegment(params);
  }

  throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
}

async function serveSingleHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!params.segment.telegram_file_id || !Number.isSafeInteger(params.segment.size)) {
    throw new AppError(404, "HlsSegmentNotFound", "HLS segment 文件不存在");
  }

  const size = Number(params.segment.size);
  const range = parseByteRange(params.rangeHeader, size);
  if (!range) {
    return rangeNotSatisfiableResponse(size);
  }

  const channel = await resolveTelegramChannel(params.env, params.db, params.segment.telegram_channel_id);
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: params.segment.telegram_file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: range.partial ? `bytes=${range.start}-${range.end}` : null
  });

  if (range.partial && telegramResponse.status !== 206 && (range.start !== 0 || range.end !== size - 1)) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
  }

  const headers = hlsSegmentHeaders(params.segment, range, params.forceDownload);
  copyHeader(telegramResponse.headers, headers, "Content-Range");

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    statusText: telegramResponse.statusText,
    headers
  });
}

async function serveMultipartHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!params.segment.multipart_upload_id || !Number.isSafeInteger(params.segment.size)) {
    throw new AppError(404, "HlsSegmentNotFound", "HLS segment 分片文件不存在");
  }

  const uploadId = params.segment.multipart_upload_id;
  const chunkSize = requirePositiveRecordInteger(params.segment.chunk_size, "chunk_size");
  const chunkCount = requirePositiveRecordInteger(params.segment.chunk_count, "chunk_count");
  const size = Number(params.segment.size);
  const chunks = await listFileChunkRecords(params.db, uploadId);
  const payload = {
    v: 2 as const,
    file_record_id: uploadId,
    name: hlsSegmentFileName(new URL(params.segment.source_url), params.segment.segment_index),
    mime_type: params.segment.mime_type,
    size,
    chunk_size: chunkSize,
    chunk_count: chunkCount,
    iat: Math.floor(Date.now() / 1000)
  };

  validateTokenChunks(payload, chunks);
  const range = parseByteRange(params.rangeHeader, size);
  if (!range) {
    return rangeNotSatisfiableResponse(size);
  }

  return new Response(streamMultipartFile({
    env: params.env,
    payload,
    chunks,
    range
  }), {
    status: range.partial ? 206 : 200,
    headers: hlsSegmentHeaders(params.segment, range, params.forceDownload)
  });
}

export async function serveHlsSegmentChunk(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  chunkIndex: number;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (params.segment.status !== "done") {
    throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
  }

  if (params.segment.storage_backend !== "telegram_multipart" || !params.segment.multipart_upload_id) {
    if (params.segment.storage_backend === "telegram_single" && params.chunkIndex === 0) {
      return serveSingleHlsSegment(params);
    }

    throw new AppError(400, "NotMultipartHlsSegment", "HLS segment chunk download is only available for multipart segments");
  }

  const chunkSize = requirePositiveRecordInteger(params.segment.chunk_size, "chunk_size");
  const chunkCount = requirePositiveRecordInteger(params.segment.chunk_count, "chunk_count");
  const segmentSize = requireHlsSegmentSize(params.segment);

  if (!Number.isSafeInteger(params.chunkIndex) || params.chunkIndex < 0 || params.chunkIndex >= chunkCount) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  const chunk = await getFileChunkRecord(params.db, params.segment.multipart_upload_id, params.chunkIndex);
  const expectedSize = expectedRecordChunkSize(segmentSize, chunkSize, chunkCount, params.chunkIndex);
  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "HLS segment chunk was not found");
  }

  const range = parseByteRange(params.rangeHeader, chunk.size);
  if (!range) {
    return rangeNotSatisfiableResponse(chunk.size);
  }

  const channel = await resolveTelegramChannel(params.env, params.db, chunk.telegram_channel_id);
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: chunk.telegram_file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: range.partial ? `bytes=${range.start}-${range.end}` : null
  });

  if (range.partial && telegramResponse.status !== 206 && (range.start !== 0 || range.end !== chunk.size - 1)) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
  }

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const fileName = recordChunkDownloadFileName(
    hlsSegmentFileName(new URL(params.segment.source_url), params.segment.segment_index),
    chunkCount,
    params.chunkIndex
  );
  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.segment.mime_type || telegramResponse.headers.get("Content-Type") || "video/mp2t");
  headers.set(
    "Content-Disposition",
    params.forceDownload ? contentDispositionAttachment(fileName) : contentDispositionInline(fileName)
  );
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${chunk.size}`);
  }
  headers.set("X-HLS-Segment-Index", String(params.segment.segment_index));
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(chunkCount));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * chunkSize));

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    headers
  });
}

function hlsSegmentHeaders(
  segment: HlsSegmentRecord,
  range: ParsedByteRange,
  forceDownload: boolean
): Headers {
  const fileName = hlsSegmentFileName(new URL(segment.source_url), segment.segment_index);
  const headers = withSecurityHeaders();
  headers.set("Content-Type", segment.mime_type || "video/mp2t");
  headers.set(
    "Content-Disposition",
    forceDownload ? contentDispositionAttachment(fileName) : contentDispositionInline(fileName)
  );
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial && Number.isSafeInteger(segment.size)) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${Number(segment.size)}`);
  }
  return headers;
}

function hlsInitSegmentHeaders(
  asset: HlsAssetRecord,
  range: ParsedByteRange,
  forceDownload: boolean,
  telegramContentType: string | null
): Headers {
  const fileName = asset.init_source_url ? hlsInitSegmentFileName(new URL(asset.init_source_url)) : "init.mp4";
  const headers = withSecurityHeaders();
  headers.set("Content-Type", asset.init_mime_type || telegramContentType || "video/mp4");
  headers.set(
    "Content-Disposition",
    forceDownload ? contentDispositionAttachment(fileName) : contentDispositionInline(fileName)
  );
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial && Number.isSafeInteger(asset.init_size)) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${Number(asset.init_size)}`);
  }
  return headers;
}

function streamHlsSegmentsForDownload(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  segments: HlsSegmentRecord[];
  kind: HlsDownloadKind;
}): ReadableStream<Uint8Array> {
  const items = hlsDownloadItems(params.asset, params.segments, params.kind);
  let itemIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (reader) {
            const { done, value } = await reader.read();
            if (done) {
              reader.releaseLock();
              reader = undefined;
              itemIndex += 1;
              continue;
            }

            if (value) {
              controller.enqueue(value);
              return;
            }
            continue;
          }

          const item = items[itemIndex];
          if (!item) {
            controller.close();
            return;
          }

          const response = item.kind === "init"
            ? await serveStoredHlsInitSegment({
                env: params.env,
                db: params.db,
                asset: params.asset,
                rangeHeader: null,
                forceDownload: false
              })
            : await serveStoredHlsSegment({
                env: params.env,
                db: params.db,
                segment: item.segment,
                rangeHeader: null,
                forceDownload: false
              });

          if (!response.body) {
            throw new AppError(502, "HlsDownloadFailed", "HLS segment response did not include a body");
          }

          reader = response.body.getReader();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      reader = undefined;
    }
  });
}
