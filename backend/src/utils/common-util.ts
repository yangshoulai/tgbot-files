import { AppError, normalizeBaseUrl } from "./http";

const AUDIO_LIKE_EXTENSIONS = new Set([
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus",
  "wma", "alac", "aiff", "aif", "ape", "amr", "mid", "midi"
]);

const TEXT_LIKE_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "ndjson", "csv", "tsv", "log",
  "xml", "yaml", "yml", "toml", "ini", "conf", "cfg", "env",
  "js", "jsx", "ts", "tsx", "css", "scss", "less", "html", "htm",
  "svg", "sh", "bash", "zsh", "fish", "sql", "py", "go", "rs", "java",
  "kt", "c", "h", "cpp", "hpp", "cs", "php", "rb", "lua", "vue", "svelte"
]);

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessageForServer(error: unknown, fallback = "服务处理失败"): string {
  if (error instanceof AppError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function maskSecret(value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    return "未配置";
  }

  if (normalized.length <= 8) {
    return "••••";
  }

  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

export function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function fileExtension(fileName: string): string {
  const trimmed = fileName.trim().toLowerCase();
  const slashIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const baseName = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  const dotIndex = baseName.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < baseName.length - 1 ? baseName.slice(dotIndex + 1) : "";
}

export function isTextLikeMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/ld+json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-javascript" ||
    mimeType === "application/typescript" ||
    mimeType === "application/x-typescript" ||
    mimeType === "application/x-sh" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml");
}

export function isTextLikeFileName(fileName: string): boolean {
  return TEXT_LIKE_EXTENSIONS.has(fileExtension(fileName));
}

export function isAudioLikeFileName(fileName: string): boolean {
  return AUDIO_LIKE_EXTENSIONS.has(fileExtension(fileName));
}

export function isReadRequest(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export function getPublicBaseUrl(request: Request, publicBaseUrl: string | undefined): string {
  return normalizeBaseUrl(publicBaseUrl || new URL(request.url).origin);
}

export function extractOptionalFileToken(pathname: string): string | undefined {
  const match = /^\/f\/([^/]+)(?:\/.*)?$/.exec(pathname);

  return match?.[1];
}

export function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);

  if (value) {
    target.set(name, value);
  }
}

export function inferRemoteFileName(sourceUrl: URL, headers: Headers): string {
  const contentDispositionName = parseContentDispositionFileName(headers.get("Content-Disposition"));
  if (contentDispositionName) {
    return contentDispositionName;
  }

  const rawSegment = sourceUrl.pathname.split("/").filter(Boolean).at(-1);
  if (!rawSegment) {
    return "download";
  }

  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return rawSegment;
  }
}

function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const encodedMatch = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value);
  const encodedValue = encodedMatch?.[1]?.trim();
  if (encodedValue) {
    const decoded = decodeContentDispositionFileName(encodedValue);
    if (decoded) {
      return decoded;
    }
  }

  const plainMatch = /(?:^|;)\s*filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  const plainValue = plainMatch?.[2] ?? plainMatch?.[1];
  const normalized = plainValue?.trim().replace(/^"|"$/g, "");

  return normalized || undefined;
}

function decodeContentDispositionFileName(value: string): string | undefined {
  const normalized = value.replace(/^"|"$/g, "");
  const encodedPart = normalized.includes("''") ? normalized.split("''").slice(1).join("''") : normalized;

  try {
    return decodeURIComponent(encodedPart);
  } catch {
    return encodedPart || undefined;
  }
}
