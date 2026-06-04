import type { FileItem } from "../api";
import { canUseAcceleratedDownload, extractSignedFileToken } from "./accelerated-download";
import { getVideoPreviewServiceWorkerController, isVideoPreviewServiceWorkerControlling } from "./video-preview-service-worker";

export const VIDEO_PREVIEW_CACHE_HEARTBEAT_MS = 4_000;

export interface ChunkedVideoPreviewMetadata {
  fileId: string;
  token: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  mimeType: string;
}

export function canUseChunkedVideoPreview(file: FileItem): boolean {
  return canUseAcceleratedDownload(file) &&
    file.mime_type.toLowerCase().startsWith("video/") &&
    isVideoPreviewServiceWorkerControlling();
}

export function buildChunkedVideoPreviewMetadata(file: FileItem): ChunkedVideoPreviewMetadata | null {
  if (!canUseAcceleratedDownload(file)) {
    return null;
  }

  const token = extractSignedFileToken(file.file_path);
  if (!token) {
    return null;
  }

  return {
    fileId: file.id,
    token,
    size: file.size,
    chunkSize: file.chunk_size,
    chunkCount: file.chunk_count,
    mimeType: file.mime_type
  };
}

export function buildChunkedVideoPreviewUrl(file: FileItem, metadata = buildChunkedVideoPreviewMetadata(file)): string | null {
  if (!metadata) {
    return null;
  }

  const params = new URLSearchParams({
    token: metadata.token,
    size: String(metadata.size),
    chunk_size: String(metadata.chunkSize),
    chunk_count: String(metadata.chunkCount),
    mime: metadata.mimeType
  });

  return `/__video-preview/${encodeURIComponent(file.id)}/${encodeURIComponent(file.file_name)}?${params.toString()}`;
}

export function startChunkedVideoPreviewCacheSession(sessionId: string, metadata: ChunkedVideoPreviewMetadata): boolean {
  return postVideoPreviewCacheMessage({
    type: "VIDEO_PREVIEW_CACHE_START",
    sessionId,
    metadata
  });
}

export function stopChunkedVideoPreviewCacheSession(sessionId: string): boolean {
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
      metadata: ChunkedVideoPreviewMetadata;
    }
  | {
      type: "VIDEO_PREVIEW_CACHE_STOP";
      sessionId: string;
    };
