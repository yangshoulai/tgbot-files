import type { FileItem } from "../api";
import { previewKind } from "../utils";
import { canUseAcceleratedDownload } from "./accelerated-download";

export interface DirectAccessibleFile extends FileItem {
  url: string;
  download_url: string;
}

export function hasDirectFileAccess(file: FileItem): file is DirectAccessibleFile {
  return file.direct_access !== false &&
    typeof file.url === "string" &&
    file.url.length > 0 &&
    typeof file.download_url === "string" &&
    file.download_url.length > 0;
}

export function canPreviewThroughAvailableAccess(file: FileItem): boolean {
  const kind = previewKind(file);

  if (!kind) {
    return false;
  }

  if (hasDirectFileAccess(file)) {
    return true;
  }

  return kind === "video" && canUseAcceleratedDownload(file);
}

export function fileAccessLabel(file: FileItem): string {
  if (file.storage_backend !== "telegram_multipart") {
    return "文件链接";
  }

  if (hasDirectFileAccess(file)) {
    return `文件链接 · ${file.chunk_count ?? "?"} 个分片`;
  }

  return `仅加速下载 · ${file.chunk_count ?? "?"} 个分片`;
}
