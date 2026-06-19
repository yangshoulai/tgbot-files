import { verifySignedToken } from "../utils/crypto";
import {
  getFileChunkRecord,
  listFileChunkRecords,
  requireDb,
  type FileChunkRecord,
  type FileRecord
} from "../database";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  withEmbeddableFileSecurityHeaders,
  withSecurityHeaders
} from "../utils/http";
import { fetchTelegramFile } from "../services/telegram";
import {
  canDirectlyAccessMultipartMetadata,
  fileStorageBackend
} from "../services/file-access";
import {
  DIRECT_MULTIPART_ACCESS_MAX_BYTES
} from "../config/upload-limits";
import type { AppEnv } from "../runtime";
import {
  chunkDownloadFileName,
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

export async function handleMultipartChunkAccess(params: {
  env: AppEnv;
  payload: Awaited<ReturnType<typeof verifySignedToken>>;
  chunkIndex: number;
  rangeHeader: string | null;
}): Promise<Response> {
  if (params.payload.v !== 2) {
    throw new AppError(400, "NotMultipartFile", "Chunk download is only available for multipart files");
  }

  validatePayloadChunkIndex(params.payload, params.chunkIndex);

  const db = requireDb(params.env);
  const chunk = await getFileChunkRecord(db, params.payload.file_record_id, params.chunkIndex);
  const expectedSize = expectedPayloadChunkSize(params.payload, params.chunkIndex);

  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "Multipart file chunk was not found");
  }

  const range = parseByteRange(params.rangeHeader, chunk.size);
  if (!range) {
    return rangeNotSatisfiableResponse(chunk.size);
  }

  const channel = await resolveTelegramChannel(params.env, db, chunk.telegram_channel_id);
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

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(chunkDownloadFileName(params.payload, params.chunkIndex)));
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${chunk.size}`);
  }
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(params.payload.chunk_count));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * params.payload.chunk_size));

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    headers
  });
}

export async function handleMultipartChunkRecordAccess(params: {
  env: AppEnv;
  file: FileRecord;
  chunkIndex: number;
}): Promise<Response> {
  if (fileStorageBackend(params.file) !== "telegram_multipart") {
    throw new AppError(400, "NotMultipartFile", "Chunk download is only available for multipart files");
  }

  const chunkSize = requirePositiveRecordInteger(params.file.chunk_size, "chunk_size");
  const chunkCount = requirePositiveRecordInteger(params.file.chunk_count, "chunk_count");

  if (!Number.isSafeInteger(params.chunkIndex) || params.chunkIndex < 0 || params.chunkIndex >= chunkCount) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  const db = requireDb(params.env);
  const chunk = await getFileChunkRecord(db, params.file.id, params.chunkIndex);
  const expectedSize = expectedRecordChunkSize(params.file.size, chunkSize, chunkCount, params.chunkIndex);

  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "Multipart file chunk was not found");
  }

  const channel = await resolveTelegramChannel(params.env, db, chunk.telegram_channel_id);
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: chunk.telegram_file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: null
  });

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.file.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(recordChunkDownloadFileName(params.file.file_name, chunkCount, params.chunkIndex)));
  headers.set("Content-Length", String(chunk.size));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(chunkCount));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * chunkSize));

  return new Response(telegramResponse.body, {
    status: 200,
    headers
  });
}

export async function handleMultipartFileAccess(params: {
  env: AppEnv;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!canDirectlyAccessMultipartPayload(params.payload)) {
    throw new AppError(
      403,
      "DirectAccessDisabled",
      "该文件超过系统直链大小上限，不提供完整文件访问链接，请在控制台使用加速下载",
      {
        size: params.payload.size,
        chunk_count: params.payload.chunk_count,
        direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
      }
    );
  }

  const db = requireDb(params.env);
  const chunks = await listFileChunkRecords(db, params.payload.file_record_id);

  validateTokenChunks(params.payload, chunks);
  const range = parseByteRange(params.rangeHeader, params.payload.size);
  if (!range) {
    return rangeNotSatisfiableResponse(params.payload.size);
  }

  const headers = withEmbeddableFileSecurityHeaders();
  headers.set("Content-Type", params.payload.mime_type);
  headers.set(
    "Content-Disposition",
    params.forceDownload
      ? contentDispositionAttachment(params.payload.name)
      : contentDispositionInline(params.payload.name)
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range.end - range.start + 1));

  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${params.payload.size}`);
  }

  return new Response(streamMultipartFile({
    env: params.env,
    payload: params.payload,
    chunks,
    range
  }), {
    status: range.partial ? 206 : 200,
    headers
  });
}

export function validateTokenChunks(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunks: FileChunkRecord[]
): void {
  if (chunks.length !== payload.chunk_count) {
    throw new AppError(404, "FileChunksNotFound", "Multipart file chunks are incomplete");
  }

  for (let index = 0; index < payload.chunk_count; index += 1) {
    const chunk = chunks[index];
    const expectedSize = expectedPayloadChunkSize(payload, index);

    if (!chunk || chunk.chunk_index !== index || chunk.size !== expectedSize) {
      throw new AppError(404, "FileChunksNotFound", "Multipart file chunks are incomplete");
    }
  }
}

function validatePayloadChunkIndex(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= payload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }
}

function expectedPayloadChunkSize(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): number {
  return chunkIndex === payload.chunk_count - 1
    ? payload.size - payload.chunk_size * chunkIndex
    : payload.chunk_size;
}

export function streamMultipartFile(params: {
  env: AppEnv;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  chunks: FileChunkRecord[];
  range: ParsedByteRange;
}): ReadableStream<Uint8Array> {
  const segments = params.chunks
    .map((chunk) => {
      const chunkStart = chunk.chunk_index * params.payload.chunk_size;
      const chunkEnd = chunkStart + chunk.size - 1;
      const overlapStart = Math.max(params.range.start, chunkStart);
      const overlapEnd = Math.min(params.range.end, chunkEnd);

      if (overlapStart > overlapEnd) {
        return undefined;
      }

      return {
        chunk,
        chunkStart,
        chunkEnd,
        overlapStart,
        overlapEnd
      };
    })
    .filter((segment): segment is {
      chunk: FileChunkRecord;
      chunkStart: number;
      chunkEnd: number;
      overlapStart: number;
      overlapEnd: number;
    } => Boolean(segment));

  let segmentIndex = 0;
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
              segmentIndex += 1;
              continue;
            }

            if (value) {
              controller.enqueue(value);
              return;
            }

            continue;
          }

          const segment = segments[segmentIndex];
          if (!segment) {
            controller.close();
            return;
          }

          const { chunk, chunkStart, chunkEnd, overlapStart, overlapEnd } = segment;
          const channel = await resolveTelegramChannel(params.env, params.env.DATABASE, chunk.telegram_channel_id);
          const telegramFileUrl = await getRateLimitedTelegramFileUrl({
            env: params.env,
            botToken: channel.botToken,
            channelId: channel.id,
            fileId: chunk.telegram_file_id
          });
          const telegramResponse = await fetchTelegramFile({
            fileUrl: telegramFileUrl,
            rangeHeader: `bytes=${overlapStart - chunkStart}-${overlapEnd - chunkStart}`
          });

          if (telegramResponse.status !== 206 && (overlapStart !== chunkStart || overlapEnd !== chunkEnd)) {
            throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
          }

          if (!telegramResponse.body) {
            throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
          }

          reader = telegramResponse.body.getReader();
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

function canDirectlyAccessMultipartPayload(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>
): boolean {
  return canDirectlyAccessMultipartMetadata(payload.size, payload.chunk_count, DIRECT_MULTIPART_ACCESS_MAX_BYTES);
}
