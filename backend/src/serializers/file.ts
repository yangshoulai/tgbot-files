import type { FileRecord, ThumbnailStatus } from "../database";
import { DIRECT_MULTIPART_ACCESS_MAX_BYTES } from "../config/upload-limits";
import {
  appendDownloadParam,
  canDirectlyAccessFileRecord,
  canDirectlyAccessUploadResult,
  downloadStrategy,
  fileStorageBackend,
  publicFilePathForResponse,
  publicUploadFilePathForResponse,
  type StorageBackend
} from "../services/file-access";

export interface UploadedThumbnailResult {
  status: ThumbnailStatus;
  fileId?: string;
  fileUniqueId?: string;
  telegramChannelId?: string;
  filePath?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface UploadResult {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  md5: string;
  filePath: string;
  publicUrl: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  remark?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath: string;
  storageBackend: StorageBackend;
  telegramChannelId?: string;
  chunkSize?: number | null;
  chunkCount?: number | null;
  thumbnail?: UploadedThumbnailResult;
}

export interface HlsDownloadSummary {
  segment_count: number;
  kind: string | null;
  part_count: number;
  direct_access: boolean;
  direct_access_max_parts: number;
  downloadable: boolean;
}

export async function serializeFileRecord(params: {
  file: FileRecord;
  baseUrl: string;
  hlsPublicRoutePrefix: string;
  loadHlsDownloadSummary: (file: FileRecord) => Promise<HlsDownloadSummary>;
}): Promise<Record<string, unknown>> {
  const storageBackend = fileStorageBackend(params.file);
  const directAccess = canDirectlyAccessFileRecord(params.file, DIRECT_MULTIPART_ACCESS_MAX_BYTES);
  const filePath = publicFilePathForResponse(params.file.file_path, storageBackend, params.hlsPublicRoutePrefix);
  const url = `${params.baseUrl}${filePath}`;
  const hlsDownload = storageBackend === "hls_package"
    ? await params.loadHlsDownloadSummary(params.file)
    : null;
  const directDownload = hlsDownload ? hlsDownload.direct_access : directAccess;
  const thumbnailUrl = params.file.thumbnail_file_path && params.file.thumbnail_status === "ready"
    ? `${params.baseUrl}${params.file.thumbnail_file_path}`
    : null;

  return {
    ...params.file,
    file_path: filePath,
    directory_id: params.file.directory_id ?? null,
    directory_path: params.file.directory_path ?? "/",
    storage_backend: storageBackend,
    chunk_size: storageBackend === "telegram_multipart" ? params.file.chunk_size ?? null : null,
    chunk_count: storageBackend === "telegram_multipart" ? params.file.chunk_count ?? null : null,
    direct_access: directAccess,
    direct_download: directDownload,
    download_strategy: downloadStrategy(storageBackend, directDownload),
    url,
    download_url: directDownload ? appendDownloadParam(url) : null,
    hls_download: hlsDownload,
    thumbnail_status: params.file.thumbnail_status ?? "none",
    thumbnail_url: thumbnailUrl,
    telegram_channel_id: params.file.telegram_channel_id ?? "default",
    thumbnail_file_id: params.file.thumbnail_file_id ?? null,
    thumbnail_file_unique_id: params.file.thumbnail_file_unique_id ?? null,
    thumbnail_file_path: params.file.thumbnail_file_path ?? null,
    thumbnail_mime_type: params.file.thumbnail_mime_type ?? null,
    thumbnail_size: params.file.thumbnail_size ?? null,
    thumbnail_width: params.file.thumbnail_width ?? null,
    thumbnail_height: params.file.thumbnail_height ?? null
  };
}

export function serializeUploadedFileResult(
  result: UploadResult,
  username: string | null,
  hlsPublicRoutePrefix: string
): Record<string, unknown> {
  const directAccess = canDirectlyAccessUploadResult(result, DIRECT_MULTIPART_ACCESS_MAX_BYTES);
  const filePath = publicUploadFilePathForResponse(result, hlsPublicRoutePrefix);
  const publicOrigin = new URL(result.publicUrl).origin;
  const url = `${publicOrigin}${filePath}`;
  const thumbnailUrl = result.thumbnail?.status === "ready" && result.thumbnail.filePath
    ? `${publicOrigin}${result.thumbnail.filePath}`
    : null;

  return {
    id: result.id,
    file_name: result.name,
    mime_type: result.mimeType,
    size: result.size,
    md5: result.md5,
    telegram_file_id: result.telegramFileId,
    telegram_file_unique_id: result.telegramFileUniqueId ?? null,
    telegram_channel_id: result.telegramChannelId ?? "default",
    file_path: filePath,
    remark: result.remark ?? null,
    url,
    download_url: directAccess ? appendDownloadParam(url) : null,
    uploaded_by: username,
    created_at: result.createdAt,
    directory_id: result.directoryId ?? null,
    directory_path: result.directoryPath,
    storage_backend: result.storageBackend,
    chunk_size: result.storageBackend === "telegram_multipart" ? result.chunkSize ?? null : null,
    chunk_count: result.storageBackend === "telegram_multipart" ? result.chunkCount ?? null : null,
    direct_access: directAccess,
    download_strategy: downloadStrategy(result.storageBackend, directAccess),
    thumbnail_status: result.thumbnail?.status ?? "none",
    thumbnail_url: thumbnailUrl,
    thumbnail_file_id: result.thumbnail?.fileId ?? null,
    thumbnail_file_unique_id: result.thumbnail?.fileUniqueId ?? null,
    thumbnail_file_path: result.thumbnail?.filePath ?? null,
    thumbnail_mime_type: result.thumbnail?.mimeType ?? null,
    thumbnail_size: result.thumbnail?.size ?? null,
    thumbnail_width: result.thumbnail?.width ?? null,
    thumbnail_height: result.thumbnail?.height ?? null
  };
}
