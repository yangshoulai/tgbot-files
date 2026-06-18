import type { FileRecord } from "../database";

export type StorageBackend = "telegram_single" | "telegram_multipart" | "hls_package";
export type DownloadStrategy = "direct" | "direct_or_accelerated" | "accelerated";

export interface UploadResultAccessInfo {
  storageBackend: StorageBackend;
  size: number;
  chunkCount?: number | null;
  filePath: string;
}

export function fileStorageBackend(file: FileRecord): StorageBackend {
  if (file.storage_backend === "hls_package" || file.telegram_file_id.startsWith("hls:")) {
    return "hls_package";
  }

  if (file.storage_backend === "telegram_multipart" || file.telegram_file_id.startsWith("multipart:")) {
    return "telegram_multipart";
  }

  return "telegram_single";
}

export function canDirectlyAccessFileRecord(file: FileRecord, maxDirectBytes: number): boolean {
  const storageBackend = fileStorageBackend(file);

  if (storageBackend === "telegram_single" || storageBackend === "hls_package") {
    return true;
  }

  return Number.isSafeInteger(file.chunk_count) &&
    canDirectlyAccessMultipartMetadata(file.size, file.chunk_count, maxDirectBytes);
}

export function canDirectlyAccessUploadResult(result: UploadResultAccessInfo, maxDirectBytes: number): boolean {
  if (result.storageBackend === "telegram_single" || result.storageBackend === "hls_package") {
    return true;
  }

  return canDirectlyAccessMultipartMetadata(result.size, result.chunkCount, maxDirectBytes);
}

export function canDirectlyAccessMultipartMetadata(
  size: number,
  chunkCount: number | null | undefined,
  maxDirectBytes: number
): boolean {
  return Number.isSafeInteger(size) &&
    size >= 0 &&
    size <= maxDirectBytes &&
    Number.isSafeInteger(chunkCount) &&
    Number(chunkCount) > 0;
}

export function downloadStrategy(storageBackend: StorageBackend, directAccess: boolean): DownloadStrategy {
  if (storageBackend === "telegram_single") {
    return "direct";
  }

  return directAccess ? "direct_or_accelerated" : "accelerated";
}

export function appendDownloadParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export function publicFilePathForResponse(filePath: string, storageBackend: StorageBackend, hlsPublicRoutePrefix: string): string {
  if (storageBackend === "hls_package" && filePath.startsWith("/hls/")) {
    return `${hlsPublicRoutePrefix}${filePath.slice("/hls".length)}`;
  }

  return filePath;
}

export function publicUploadFilePathForResponse(result: UploadResultAccessInfo, hlsPublicRoutePrefix: string): string {
  return publicFilePathForResponse(result.filePath, result.storageBackend, hlsPublicRoutePrefix);
}
