import type { FileItem } from "./api";

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const normalized = value / 1024 ** index;

  return `${normalized >= 10 || index === 0 ? normalized.toFixed(0) : normalized.toFixed(1)} ${units[index]}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "未记录";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function fileKind(file: Pick<FileItem, "mime_type" | "file_name">): {
  label: string;
  tone: "image" | "video" | "text" | "pdf" | "archive" | "file";
} {
  const mime = file.mime_type.toLowerCase();
  const name = file.file_name.toLowerCase();

  if (mime.startsWith("image/")) {
    return { label: "图片", tone: "image" };
  }

  if (mime.startsWith("video/") || /\.(mp4|m4v|mov|webm|ogv)$/i.test(name)) {
    return { label: "视频", tone: "video" };
  }

  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    return { label: "PDF", tone: "pdf" };
  }

  if (mime.startsWith("text/") || /\.(md|markdown|txt|json|csv|log|js|jsx|ts|tsx|css|html|htm|yaml|yml|toml)$/i.test(name)) {
    return { label: "文本", tone: "text" };
  }

  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) {
    return { label: "压缩包", tone: "archive" };
  }

  return { label: "文件", tone: "file" };
}

export type PreviewKind = "image" | "video" | "text" | "markdown";

export function previewKind(file: Pick<FileItem, "mime_type" | "file_name">): PreviewKind | null {
  const mime = file.mime_type.toLowerCase();
  const name = file.file_name.toLowerCase();

  if (mime.startsWith("image/")) {
    return "image";
  }

  if (mime.startsWith("video/") || /\.(mp4|m4v|mov|webm|ogv)$/i.test(name)) {
    return "video";
  }

  if (mime === "text/markdown" || name.endsWith(".md") || name.endsWith(".markdown")) {
    return "markdown";
  }

  if (
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml"].includes(mime) ||
    /\.(txt|log|csv|json|xml|yaml|yml|toml|js|jsx|ts|tsx|css|html|htm)$/i.test(name)
  ) {
    return "text";
  }

  return null;
}

export function canPreview(file: Pick<FileItem, "mime_type" | "file_name">): boolean {
  return previewKind(file) !== null;
}

export function fileInitial(file: Pick<FileItem, "mime_type" | "file_name">): string {
  const kind = fileKind(file);

  if (kind.tone === "pdf") {
    return "PDF";
  }

  return kind.label.slice(0, 1);
}

export function sumFileSize(files: FileItem[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

export function dateInputToIso(value: string, edge: "start" | "end"): string | undefined {
  if (!value) {
    return undefined;
  }

  const time = edge === "start" ? "00:00:00.000" : "23:59:59.999";
  const date = new Date(`${value}T${time}`);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}
