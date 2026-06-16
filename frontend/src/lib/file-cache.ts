import type { FileItem } from "../api";
import { canUseAcceleratedDownload, extractSignedFileToken } from "./accelerated-download";
import { hasFileLinkAccess } from "./file-access";
import { getVideoPreviewServiceWorkerController } from "./video-preview-service-worker";

export type FileCacheSource = "auto" | "manual";
export type FileCacheKind = "single" | "multipart" | "hls";

const DEFAULT_FILE_CACHE_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_REQUEST_TIMEOUT_MS = 2_000;
const LONG_CACHE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface FileCacheMetadata {
  kind: FileCacheKind;
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  sourceUrl?: string;
  token?: string;
  cacheMaxBytes: number;
  cacheSource: FileCacheSource;
}

export interface FileCacheEntry {
  fileId: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  cachedChunks: number;
  cachedBytes: number;
  manualBytes: number;
  autoBytes: number;
  cacheSource: FileCacheSource;
  lastAccessed: number;
  complete: boolean;
}

export interface FileCacheSummary {
  entries: FileCacheEntry[];
  totalBytes: number;
  manualBytes: number;
  autoBytes: number;
}

export function buildFileCacheMetadata(file: FileItem, cacheMaxBytes: number, cacheSource: FileCacheSource): FileCacheMetadata | null {
  if (file.storage_backend === "hls_package" && hasFileLinkAccess(file)) {
    const chunkCount = Math.max(1, file.hls_download?.part_count ?? file.hls_download?.segment_count ?? 1);
    return {
      kind: "hls",
      fileId: file.id,
      fileName: file.file_name,
      mimeType: file.mime_type || "application/vnd.apple.mpegurl",
      size: file.size,
      chunkSize: Math.max(1, Math.ceil(file.size / chunkCount)),
      chunkCount,
      sourceUrl: file.file_path,
      cacheMaxBytes,
      cacheSource
    };
  }

  if (canUseAcceleratedDownload(file)) {
    const token = extractSignedFileToken(file.file_path) || (hasFileLinkAccess(file) ? extractSignedFileToken(file.url) : null);
    if (token) {
      return {
        kind: "multipart",
        fileId: file.id,
        fileName: file.file_name,
        mimeType: file.mime_type || "application/octet-stream",
        size: file.size,
        chunkSize: file.chunk_size,
        chunkCount: file.chunk_count,
        token,
        cacheMaxBytes,
        cacheSource
      };
    }
  }

  if (!hasFileLinkAccess(file)) {
    return null;
  }

  const chunkSize = DEFAULT_FILE_CACHE_CHUNK_BYTES;
  return {
    kind: "single",
    fileId: file.id,
    fileName: file.file_name,
    mimeType: file.mime_type || "application/octet-stream",
    size: file.size,
    chunkSize,
    chunkCount: Math.max(1, Math.ceil(file.size / chunkSize)),
    sourceUrl: file.file_path,
    cacheMaxBytes,
    cacheSource
  };
}

export function buildFileCacheUrl(metadata: FileCacheMetadata | null): string | null {
  if (!metadata) {
    return null;
  }

  const params = new URLSearchParams({
    kind: metadata.kind,
    file_name: metadata.fileName,
    mime: metadata.mimeType,
    size: String(metadata.size),
    chunk_size: String(metadata.chunkSize),
    chunk_count: String(metadata.chunkCount),
    cache_max: String(metadata.cacheMaxBytes),
    cache_source: metadata.cacheSource
  });

  if (metadata.sourceUrl) params.set("source", metadata.sourceUrl);
  if (metadata.token) params.set("token", metadata.token);

  return `/__file-cache/${metadata.kind}/${encodeURIComponent(metadata.fileId)}/${encodeURIComponent(metadata.fileName)}?${params.toString()}`;
}

export function canCacheFile(file: FileItem): boolean {
  return Boolean(buildFileCacheMetadata(file, Number.MAX_SAFE_INTEGER, "manual"));
}

export async function requestPersistentFileCacheStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    return false;
  }

  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function cacheFileManually(metadata: FileCacheMetadata): Promise<FileCacheEntry | null> {
  return requestFileCacheMessage<FileCacheEntry | null>({
    type: "FILE_CACHE_CACHE_FILE",
    metadata: {
      ...metadata,
      cacheSource: "manual"
    }
  }, LONG_CACHE_REQUEST_TIMEOUT_MS);
}

export function getFileCacheSummary(): Promise<FileCacheSummary> {
  return requestFileCacheMessage<FileCacheSummary>({
    type: "FILE_CACHE_LIST_REQUEST"
  }).then((summary) => normalizeFileCacheSummary(summary));
}

export function getFileCacheState(metadata: FileCacheMetadata): Promise<FileCacheEntry | null> {
  return requestFileCacheMessage<FileCacheEntry | null>({
    type: "FILE_CACHE_STATE_REQUEST",
    metadata
  });
}

export function clearFileCache(fileId: string): Promise<FileCacheSummary> {
  return requestFileCacheMessage<FileCacheSummary>({
    type: "FILE_CACHE_CLEAR_FILE",
    fileId
  }).then((summary) => normalizeFileCacheSummary(summary));
}

export function clearFilesCache(fileIds: string[]): Promise<FileCacheSummary> {
  return requestFileCacheMessage<FileCacheSummary>({
    type: "FILE_CACHE_CLEAR_FILES",
    fileIds
  }).then((summary) => normalizeFileCacheSummary(summary));
}

export function clearAutomaticFileCache(): Promise<FileCacheSummary> {
  return requestFileCacheMessage<FileCacheSummary>({
    type: "FILE_CACHE_CLEAR_AUTO"
  }).then((summary) => normalizeFileCacheSummary(summary));
}

function requestFileCacheMessage<T>(message: FileCacheRequestMessage, timeoutMs = DEFAULT_CACHE_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = getVideoPreviewServiceWorkerController();
  if (!controller || typeof MessageChannel === "undefined") {
    return Promise.reject(new Error("文件缓存 Service Worker 尚未接管当前页面，请刷新后重试"));
  }

  const requestId = `file-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const channel = new MessageChannel();

  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      cleanup();
      reject(new Error("文件缓存请求超时"));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timerId);
      channel.port1.onmessage = null;
      channel.port1.close();
    };

    channel.port1.onmessage = (event: MessageEvent<FileCacheResponseMessage<T>>) => {
      if (event.data?.type !== "FILE_CACHE_RESPONSE" || event.data.requestId !== requestId) {
        return;
      }

      cleanup();
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve(event.data.result as T);
      }
    };

    try {
      controller.postMessage({ ...message, requestId }, [channel.port2]);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("文件缓存请求发送失败"));
    }
  });
}

function normalizeFileCacheSummary(value: FileCacheSummary | null | undefined): FileCacheSummary {
  return {
    entries: Array.isArray(value?.entries) ? value.entries : [],
    totalBytes: Number(value?.totalBytes) || 0,
    manualBytes: Number(value?.manualBytes) || 0,
    autoBytes: Number(value?.autoBytes) || 0
  };
}

type FileCacheRequestMessage =
  | { type: "FILE_CACHE_CACHE_FILE"; metadata: FileCacheMetadata }
  | { type: "FILE_CACHE_STATE_REQUEST"; metadata: FileCacheMetadata }
  | { type: "FILE_CACHE_LIST_REQUEST" }
  | { type: "FILE_CACHE_CLEAR_FILE"; fileId: string }
  | { type: "FILE_CACHE_CLEAR_FILES"; fileIds: string[] }
  | { type: "FILE_CACHE_CLEAR_AUTO" };

interface FileCacheResponseMessage<T> {
  type: "FILE_CACHE_RESPONSE";
  requestId: string;
  result?: T;
  error?: string;
}
