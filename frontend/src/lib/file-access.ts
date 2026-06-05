import type { FileItem } from "../api";
import { previewKind } from "../utils";
import { canUseAcceleratedDownload } from "./accelerated-download";

export interface LinkAccessibleFile extends FileItem {
  url: string;
}

export interface DirectDownloadableFile extends LinkAccessibleFile {
  download_url: string;
}

export function hasFileLinkAccess(file: FileItem): file is LinkAccessibleFile {
  return file.direct_access !== false &&
    typeof file.url === "string" &&
    file.url.length > 0;
}

export function hasDirectDownloadAccess(file: FileItem): file is DirectDownloadableFile {
  return hasFileLinkAccess(file) &&
    file.direct_download !== false &&
    typeof file.download_url === "string" &&
    file.download_url.length > 0;
}

export const hasDirectFileAccess = hasDirectDownloadAccess;

export function canPreviewThroughAvailableAccess(file: FileItem): boolean {
  const kind = previewKind(file);

  if (!kind) {
    return false;
  }

  if (hasFileLinkAccess(file)) {
    return true;
  }

  return kind === "video" && (canUseAcceleratedDownload(file) || canUseHlsAcceleratedDownload(file));
}

export function canUseHlsAcceleratedDownload(file: FileItem): boolean {
  return file.storage_backend === "hls_package" &&
    Boolean(file.hls_download?.downloadable) &&
    Number.isSafeInteger(file.hls_download?.part_count) &&
    Number(file.hls_download?.part_count) > 0;
}

export function canUseAnyAcceleratedDownload(file: FileItem): boolean {
  return canUseAcceleratedDownload(file) || canUseHlsAcceleratedDownload(file);
}

export function fileAccessLabel(file: FileItem): string {
  if (file.storage_backend === "hls_package") {
    const summary = file.hls_download;
    if (!summary?.downloadable) {
      return "HLS 播放列表";
    }
    return summary.direct_access
      ? `HLS 播放列表 · 可直链下载 ${summary.part_count} 段`
      : `HLS 播放列表 · 仅加速下载 ${summary.part_count} 段`;
  }

  if (file.storage_backend !== "telegram_multipart") {
    return "文件链接";
  }

  if (hasDirectDownloadAccess(file)) {
    return `文件链接 · ${file.chunk_count ?? "?"} 个分片`;
  }

  return `仅加速下载 · ${file.chunk_count ?? "?"} 个分片`;
}
