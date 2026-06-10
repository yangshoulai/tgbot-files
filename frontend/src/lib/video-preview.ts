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

export interface VideoPreviewPlaybackProgress {
  currentTime: number;
  duration?: number;
  ratio?: number;
  byteOffset?: number;
}

export interface VideoPreviewCacheState {
  fileId: string;
  kind: VideoPreviewKind;
  chunkCount: number;
  cachedChunks: number[];
}

export function buildVideoPreviewMetadata(file: FileItem, cacheMaxBytes: number): VideoPreviewMetadata | null {
  if (file.storage_backend === "hls_package" && hasFileLinkAccess(file)) {
    return {
      kind: "hls",
      fileId: file.id,
      sourceUrl: file.file_path,
      chunkCount: file.hls_download?.segment_count,
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

export function reportVideoPreviewPlaybackProgress(
  sessionId: string,
  metadata: VideoPreviewMetadata,
  progress: VideoPreviewPlaybackProgress
): boolean {
  return postVideoPreviewCacheMessage({
    type: "VIDEO_PREVIEW_PLAYBACK_PROGRESS",
    sessionId,
    metadata,
    progress
  });
}

export function requestVideoPreviewCacheState(metadata: VideoPreviewMetadata, timeoutMs = 1500): Promise<VideoPreviewCacheState | null> {
  const controller = getVideoPreviewServiceWorkerController();
  if (!controller || typeof MessageChannel === "undefined") {
    return Promise.resolve(null);
  }

  const requestId = `video-preview-cache-state-${metadata.fileId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const channel = new MessageChannel();

  return new Promise((resolve) => {
    const timerId = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timerId);
      channel.port1.onmessage = null;
      channel.port1.close();
    };

    channel.port1.onmessage = (event: MessageEvent<VideoPreviewCacheStateResponse>) => {
      if (event.data?.type !== "VIDEO_PREVIEW_CACHE_STATE_RESPONSE" || event.data.requestId !== requestId) {
        return;
      }

      cleanup();
      resolve(normalizeVideoPreviewCacheState(event.data.state, metadata));
    };

    try {
      controller.postMessage({
        type: "VIDEO_PREVIEW_CACHE_STATE_REQUEST",
        requestId,
        metadata
      }, [channel.port2]);
    } catch {
      cleanup();
      resolve(null);
    }
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
    }
  | {
      type: "VIDEO_PREVIEW_PLAYBACK_PROGRESS";
      sessionId: string;
      metadata: VideoPreviewMetadata;
      progress: VideoPreviewPlaybackProgress;
    }
  | {
      type: "VIDEO_PREVIEW_CACHE_STATE_REQUEST";
      requestId: string;
      metadata: VideoPreviewMetadata;
    };

interface VideoPreviewCacheStateResponse {
  type: "VIDEO_PREVIEW_CACHE_STATE_RESPONSE";
  requestId: string;
  state: unknown;
  error?: string;
}

function normalizeVideoPreviewCacheState(value: unknown, metadata: VideoPreviewMetadata): VideoPreviewCacheState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const state = value as Partial<VideoPreviewCacheState>;
  const chunkCount = Number(state.chunkCount);
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0 || state.fileId !== metadata.fileId || state.kind !== metadata.kind) {
    return null;
  }

  const seen = new Set<number>();
  const cachedChunks = Array.isArray(state.cachedChunks)
    ? state.cachedChunks
        .map((chunkIndex) => Number(chunkIndex))
        .filter((chunkIndex) => {
          const valid = Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 && chunkIndex < chunkCount && !seen.has(chunkIndex);
          if (valid) seen.add(chunkIndex);
          return valid;
        })
        .sort((left, right) => left - right)
    : [];

  return {
    fileId: metadata.fileId,
    kind: metadata.kind,
    chunkCount,
    cachedChunks
  };
}
