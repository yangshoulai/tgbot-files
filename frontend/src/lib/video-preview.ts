import type { FileItem } from "../api";
import { canUseAcceleratedDownload, extractSignedFileToken } from "./accelerated-download";
import { hasFileLinkAccess } from "./file-access";
import { getVideoPreviewServiceWorkerController } from "./video-preview-service-worker";

export const VIDEO_PREVIEW_CACHE_HEARTBEAT_MS = 4_000;
const DEFAULT_PREVIEW_CHUNK_BYTES = 2 * 1024 * 1024;

export type VideoPreviewKind = "single" | "multipart" | "hls";

export interface VideoPreviewMetadata {
  kind: VideoPreviewKind;
  fileId: string;
  sourceUrl?: string;
  token?: string;
  size?: number;
  chunkSize?: number;
  chunkCount?: number;
  mimeType: string;
  cacheMaxBytes: number;
}

export function buildVideoPreviewMetadata(file: FileItem, cacheMaxBytes: number): VideoPreviewMetadata | null {
  if (file.storage_backend === "hls_package" && hasFileLinkAccess(file)) {
    return {
      kind: "hls",
      fileId: file.id,
      sourceUrl: file.file_path,
      mimeType: file.mime_type || "application/vnd.apple.mpegurl",
      cacheMaxBytes
    };
  }

  if (canUseAcceleratedDownload(file)) {
    const token = extractSignedFileToken(file.file_path) || (hasFileLinkAccess(file) ? extractSignedFileToken(file.url) : null);
    if (token) {
      return {
        kind: "multipart",
        fileId: file.id,
        token,
        size: file.size,
        chunkSize: file.chunk_size,
        chunkCount: file.chunk_count,
        mimeType: file.mime_type || "application/octet-stream",
        cacheMaxBytes
      };
    }
  }

  if (hasFileLinkAccess(file)) {
    return {
      kind: "single",
      fileId: file.id,
      sourceUrl: file.file_path,
      size: file.size,
      chunkSize: DEFAULT_PREVIEW_CHUNK_BYTES,
      chunkCount: Math.max(1, Math.ceil(file.size / DEFAULT_PREVIEW_CHUNK_BYTES)),
      mimeType: file.mime_type || "application/octet-stream",
      cacheMaxBytes
    };
  }

  return null;
}

export function buildVideoPreviewUrl(file: FileItem, metadata: VideoPreviewMetadata | null): string | null {
  if (!metadata) {
    return null;
  }

  const params = new URLSearchParams({
    kind: metadata.kind,
    mime: metadata.mimeType,
    cache_max: String(metadata.cacheMaxBytes)
  });

  if (metadata.sourceUrl) params.set("source", metadata.sourceUrl);
  if (metadata.token) params.set("token", metadata.token);
  if (metadata.size !== undefined) params.set("size", String(metadata.size));
  if (metadata.chunkSize !== undefined) params.set("chunk_size", String(metadata.chunkSize));
  if (metadata.chunkCount !== undefined) params.set("chunk_count", String(metadata.chunkCount));

  return `/__video-preview/${metadata.kind}/${encodeURIComponent(file.id)}/${encodeURIComponent(file.file_name)}?${params.toString()}`;
}

export function startVideoPreviewCacheSession(sessionId: string, metadata: VideoPreviewMetadata): boolean {
  return postVideoPreviewCacheMessage({
    type: "VIDEO_PREVIEW_CACHE_START",
    sessionId,
    metadata
  });
}

export function stopVideoPreviewCacheSession(sessionId: string): boolean {
  return postVideoPreviewCacheMessage({
    type: "VIDEO_PREVIEW_CACHE_STOP",
    sessionId
  });
}

function postVideoPreviewCacheMessage(message: VideoPreviewCacheMessage): boolean {
  const controller = getVideoPreviewServiceWorkerController();
  if (!controller) {
    return false;
  }

  controller.postMessage(message);
  return true;
}

type VideoPreviewCacheMessage =
  | {
      type: "VIDEO_PREVIEW_CACHE_START";
      sessionId: string;
      metadata: VideoPreviewMetadata;
    }
  | {
      type: "VIDEO_PREVIEW_CACHE_STOP";
      sessionId: string;
    };
