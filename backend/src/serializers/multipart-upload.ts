import type { FileChunkRecord, MultipartUploadRecord } from "../database";
import {
  DIRECT_MULTIPART_ACCESS_MAX_BYTES,
  MAX_TELEGRAM_MULTIPART_BYTES,
  maxTelegramMultipartChunks
} from "../config/upload-limits";
import { canDirectlyAccessMultipartMetadata } from "../services/file-access";

export interface ThumbnailSourceInfo {
  available: boolean;
  kind: "image" | "video";
  url: string;
  mimeType: string;
  expiresAt: string;
}

export interface MultipartInitResult {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  directoryPath: string;
  thumbnailSource?: ThumbnailSourceInfo;
}

export type UploadedChunkRecord = Pick<
  FileChunkRecord,
  "size" | "md5"
> & {
  chunkIndex: number;
  telegramFileId: string;
  telegramChannelId?: string;
};

export function serializeMultipartInit(result: MultipartInitResult): Record<string, unknown> {
  return {
    id: result.id,
    file_name: result.fileName,
    mime_type: result.mimeType,
    size: result.size,
    chunk_size: result.chunkSize,
    chunk_count: result.chunkCount,
    directory_path: result.directoryPath,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access: canDirectlyAccessMultipartMetadata(result.size, result.chunkCount, DIRECT_MULTIPART_ACCESS_MAX_BYTES),
    direct_access_max_chunks: maxTelegramMultipartChunks(result.chunkSize),
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    thumbnail_source: result.thumbnailSource
      ? {
          available: result.thumbnailSource.available,
          kind: result.thumbnailSource.kind,
          url: result.thumbnailSource.url,
          mime_type: result.thumbnailSource.mimeType,
          expires_at: result.thumbnailSource.expiresAt
        }
      : null
  };
}

export function multipartInitResultFromUploadRecord(record: MultipartUploadRecord): MultipartInitResult {
  return {
    id: record.id,
    fileName: record.file_name,
    mimeType: record.mime_type,
    size: record.size,
    chunkSize: record.chunk_size,
    chunkCount: record.chunk_count,
    directoryPath: record.directory_path ?? "/"
  };
}

export function serializeChunk(record: UploadedChunkRecord): Record<string, unknown> {
  return {
    chunk_index: record.chunkIndex,
    size: record.size,
    md5: record.md5,
    telegram_file_id: record.telegramFileId,
    telegram_channel_id: record.telegramChannelId ?? "default"
  };
}

export function serializeMultipartUploadStatus(upload: MultipartUploadRecord): Record<string, unknown> {
  return {
    id: upload.id,
    source_kind: upload.source_kind,
    file_name: upload.file_name,
    mime_type: upload.mime_type,
    size: upload.size,
    chunk_size: upload.chunk_size,
    chunk_count: upload.chunk_count,
    directory_path: upload.directory_path ?? "/",
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access: canDirectlyAccessMultipartMetadata(upload.size, upload.chunk_count, DIRECT_MULTIPART_ACCESS_MAX_BYTES),
    direct_access_max_chunks: maxTelegramMultipartChunks(upload.chunk_size),
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    thumbnail_source: null
  };
}
