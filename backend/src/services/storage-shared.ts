import { verifySignedToken } from "../utils/crypto";
import {
  completeMultipartUploadWithFileRecord,
  getTelegramChunkSizeBytesSetting,
  getTelegramVideoChunkSizeBytesSetting,
  getTelegramAudioChunkSizeBytesSetting,
  getTelegramTextChunkSizeBytesSetting,
  getTelegramImageChunkSizeBytesSetting,
  type FileChunkRecord,
  type FileNameConflictAction,
  type HlsAssetRecord,
  type HlsSegmentRecord,
  type MultipartUploadRecord
} from "../database";
import {
  AppError,
  withSecurityHeaders
} from "../utils/http";
import { extensionForMimeType, mimeTypeForFileName } from "../utils/mime";
import {
  fileTooLargeError,
  formatHumanFileSize,
  remoteFetchHeaders,
  type RemoteRequestHeaders
} from "../services/remote-source";
import {
  MAX_TELEGRAM_MULTIPART_BYTES,
  TELEGRAM_CHUNK_SIZE_BYTES,
  maxTelegramMultipartChunks
} from "../config/upload-limits";
import { type UploadedThumbnailResult } from "../serializers/file";
import type { AppDatabase, AppEnv } from "../runtime";
import {
  getPublicBaseUrl as getPublicBaseUrlBase,
  isAudioLikeFileName,
  isTextLikeFileName,
  isTextLikeMimeType,
  parseContentLength
} from "../utils/common-util";
import {
  hlsPublicFilePath as hlsPublicFilePathBase,
  hlsPublicInitSegmentPath as hlsPublicInitSegmentPathBase,
  hlsPublicSegmentChunkPath as hlsPublicSegmentChunkPathBase,
  hlsPublicSegmentPath as hlsPublicSegmentPathBase
} from "../utils/hls-util";

export const HLS_PUBLIC_ROUTE_PREFIX = "/api/hls";

export interface ParsedByteRange {
  start: number;
  end: number;
  partial: boolean;
}

export async function resolveTelegramChunkSizeBytes(params: {
  db: AppDatabase;
  mimeType: string;
  fileName: string;
}): Promise<number> {
  const kind = telegramChunkSizeKind(params.mimeType, params.fileName);
  switch (kind) {
    case "video":
      return getTelegramVideoChunkSizeBytesSetting(params.db);
    case "audio":
      return getTelegramAudioChunkSizeBytesSetting(params.db);
    case "text":
      return getTelegramTextChunkSizeBytesSetting(params.db);
    case "image":
      return getTelegramImageChunkSizeBytesSetting(params.db);
    default:
      return getTelegramChunkSizeBytesSetting(params.db);
  }
}

type TelegramChunkSizeKind = "default" | "video" | "audio" | "text" | "image";

function telegramChunkSizeKind(mimeType: string, fileName: string): TelegramChunkSizeKind {
  const normalizedMimeType = mimeType.toLowerCase().split(";")[0]?.trim() || "";
  if (normalizedMimeType.startsWith("video/")) return "video";
  if (normalizedMimeType.startsWith("audio/") || isAudioLikeFileName(fileName)) return "audio";
  if (normalizedMimeType.startsWith("image/")) return "image";
  if (isTextLikeMimeType(normalizedMimeType) || isTextLikeFileName(fileName)) return "text";
  return "default";
}

export function normalizeChunkIndex(value: string, upload: MultipartUploadRecord): number {
  const index = Number(value);

  if (!Number.isSafeInteger(index) || index < 0 || index >= upload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  return index;
}

export function expectedChunkSize(upload: MultipartUploadRecord, chunkIndex: number): number {
  if (chunkIndex === upload.chunk_count - 1) {
    return upload.size - upload.chunk_size * chunkIndex;
  }

  return upload.chunk_size;
}

export function validateChunkFile(chunk: Blob, expectedSize: number): void {
  if (chunk.size !== expectedSize) {
    throw new AppError(400, "InvalidChunkSize", `分片大小必须为 ${formatHumanFileSize(expectedSize)}（当前 ${formatHumanFileSize(chunk.size)}）`, {
      expected_chunk_bytes: expectedSize,
      actual_chunk_bytes: chunk.size,
      expected_chunk_size: formatHumanFileSize(expectedSize),
      actual_chunk_size: formatHumanFileSize(chunk.size)
    });
  }
}

export function missingChunkIndexes(upload: MultipartUploadRecord, chunks: FileChunkRecord[]): number[] {
  const uploaded = new Set(chunks.map((chunk) => chunk.chunk_index));
  const missing: number[] = [];

  for (let index = 0; index < upload.chunk_count; index += 1) {
    if (!uploaded.has(index)) {
      missing.push(index);
    }
  }

  return missing;
}

export function validateMultipartFileSize(size: number, chunkSizeBytes = TELEGRAM_CHUNK_SIZE_BYTES): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size, {
      chunk_size_bytes: chunkSizeBytes,
      chunk_size: formatHumanFileSize(chunkSizeBytes),
      max_chunks: maxTelegramMultipartChunks(chunkSizeBytes)
    });
  }
}

export function requirePositiveRecordInteger(value: number | null | undefined, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new AppError(500, "InvalidFileRecord", `File record is missing ${fieldName}`);
  }

  return value as number;
}

export function expectedRecordChunkSize(size: number, chunkSize: number, chunkCount: number, chunkIndex: number): number {
  return chunkIndex === chunkCount - 1
    ? size - chunkSize * chunkIndex
    : chunkSize;
}

export function recordChunkDownloadFileName(fileName: string, chunkCount: number, chunkIndex: number): string {
  const paddedIndex = String(chunkIndex + 1).padStart(String(chunkCount).length, "0");
  return `${fileName}.part-${paddedIndex}-of-${chunkCount}`;
}

export function chunkDownloadFileName(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): string {
  return recordChunkDownloadFileName(payload.name, payload.chunk_count, chunkIndex);
}

export function pickRemoteMimeHint(contentType: string | null, fileName: string): string | undefined {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  const nameMimeType = mimeTypeForFileName(fileName);

  if (normalizedContentType && normalizedContentType !== "application/octet-stream") {
    return normalizedContentType;
  }

  return nameMimeType ?? normalizedContentType;
}

export function ensureFileExtension(fileName: string, mimeType: string): string {
  if (/\.[a-z0-9]{1,12}$/i.test(fileName)) {
    return fileName;
  }

  const extension = extensionForMimeType(mimeType);

  return extension ? `${fileName}.${extension}` : fileName;
}

export async function fetchRemoteHead(sourceUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<Response | undefined> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      method: "HEAD",
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, { Accept: "*/*" })
    });

    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchRemoteRange(
  sourceUrl: URL,
  start: number,
  end: number,
  sourceHeaders?: RemoteRequestHeaders
): Promise<Response> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, { Accept: "*/*" }, { Range: `bytes=${start}-${end}` })
    });

    if (!response.ok && response.status !== 206) {
      throw new AppError(
        response.status >= 500 ? 502 : 400,
        "UrlFetchFailed",
        `Source URL returned ${response.status}`,
        { source_status: response.status }
      );
    }

    return response;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(502, "UrlFetchFailed", "Failed to fetch source URL");
  }
}

export function parseByteRange(rangeHeader: string | null, size: number): ParsedByteRange | null {
  if (!rangeHeader) {
    return { start: 0, end: size - 1, partial: false };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }

  let start: number;
  let end: number;

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      return null;
    }

    if (start >= size) {
      return null;
    }

    end = Math.min(end, size - 1);
  }

  return { start, end, partial: true };
}

export function rangeNotSatisfiableResponse(size: number): Response {
  const headers = withSecurityHeaders();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes */${size}`);
  return new Response(null, { status: 416, headers });
}

export function hlsPublicFilePath(token: string, fileName: string): string {
  return hlsPublicFilePathBase(HLS_PUBLIC_ROUTE_PREFIX, token, fileName);
}

export function hlsPublicSegmentPath(token: string, segment: HlsSegmentRecord): string {
  return hlsPublicSegmentPathBase(HLS_PUBLIC_ROUTE_PREFIX, token, segment);
}

export function hlsPublicInitSegmentPath(token: string, asset: HlsAssetRecord): string {
  return hlsPublicInitSegmentPathBase(HLS_PUBLIC_ROUTE_PREFIX, token, asset);
}

export function hlsPublicSegmentChunkPath(token: string, segmentIndex: number, chunkIndex: number): string {
  return hlsPublicSegmentChunkPathBase(HLS_PUBLIC_ROUTE_PREFIX, token, segmentIndex, chunkIndex);
}

export function getPublicBaseUrl(request: Request, env: AppEnv): string {
  return getPublicBaseUrlBase(request, env.PUBLIC_BASE_URL);
}

export function normalizeFileNameConflictAction(value: unknown): FileNameConflictAction {
  if (value === undefined || value === null || value === "") {
    return "error";
  }

  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "on_conflict must be error or overwrite");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "error") {
    return "error";
  }

  if (normalized === "overwrite") {
    return "overwrite";
  }

  throw new AppError(400, "InvalidBody", "on_conflict must be error or overwrite");
}

export function thumbnailFileRecordFields(thumbnail: UploadedThumbnailResult | undefined): Partial<Parameters<typeof completeMultipartUploadWithFileRecord>[0]["file"]> {
  if (!thumbnail) {
    return {};
  }

  return {
    thumbnailStatus: thumbnail.status,
    ...(thumbnail.fileId ? { thumbnailFileId: thumbnail.fileId } : {}),
    ...(thumbnail.fileUniqueId ? { thumbnailFileUniqueId: thumbnail.fileUniqueId } : {}),
    ...(thumbnail.filePath ? { thumbnailFilePath: thumbnail.filePath } : {}),
    ...(thumbnail.mimeType ? { thumbnailMimeType: thumbnail.mimeType } : {}),
    ...(thumbnail.size ? { thumbnailSize: thumbnail.size } : {}),
    ...(thumbnail.width ? { thumbnailWidth: thumbnail.width } : {}),
    ...(thumbnail.height ? { thumbnailHeight: thumbnail.height } : {})
  };
}

export function thumbnailRecordUpdateFields(thumbnail: UploadedThumbnailResult) {
  return {
    thumbnailFileId: thumbnail.fileId ?? null,
    thumbnailFileUniqueId: thumbnail.fileUniqueId ?? null,
    thumbnailFilePath: thumbnail.filePath ?? null,
    thumbnailMimeType: thumbnail.mimeType ?? null,
    thumbnailSize: thumbnail.size ?? null,
    thumbnailWidth: thumbnail.width ?? null,
    thumbnailHeight: thumbnail.height ?? null,
    thumbnailStatus: thumbnail.status
  };
}

export function emptyThumbnailRecordUpdateFields() {
  return {
    thumbnailFileId: null,
    thumbnailFileUniqueId: null,
    thumbnailFilePath: null,
    thumbnailMimeType: null,
    thumbnailSize: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    thumbnailStatus: "none" as const
  };
}

export function thumbnailSourceKind(mimeType: string): "image" | "video" | undefined {
  const normalized = mimeType.toLowerCase();

  if (normalized.startsWith("image/") && normalized !== "image/svg+xml") {
    return "image";
  }

  if (normalized.startsWith("video/")) {
    return "video";
  }

  return undefined;
}
