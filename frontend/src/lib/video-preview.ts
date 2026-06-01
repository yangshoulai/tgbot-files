import type { FileItem } from "../api";
import { canUseAcceleratedDownload, extractSignedFileToken } from "./accelerated-download";
import { isVideoPreviewServiceWorkerControlling } from "./video-preview-service-worker";

export function canUseChunkedVideoPreview(file: FileItem): boolean {
  return canUseAcceleratedDownload(file) &&
    file.mime_type.toLowerCase().startsWith("video/") &&
    isVideoPreviewServiceWorkerControlling();
}

export function buildChunkedVideoPreviewUrl(file: FileItem): string | null {
  if (!canUseAcceleratedDownload(file)) {
    return null;
  }

  const token = extractSignedFileToken(file.file_path);
  if (!token) {
    return null;
  }

  const params = new URLSearchParams({
    token,
    size: String(file.size),
    chunk_size: String(file.chunk_size),
    chunk_count: String(file.chunk_count),
    mime: file.mime_type
  });

  return `/__video-preview/${encodeURIComponent(file.id)}/${encodeURIComponent(file.file_name)}?${params.toString()}`;
}
