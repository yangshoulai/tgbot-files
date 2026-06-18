import { AppError } from "../utils/http";

export type RemoteRequestHeaders = Record<string, string>;

const MAX_REMOTE_REQUEST_HEADER_COUNT = 32;
const MAX_REMOTE_REQUEST_HEADER_NAME_BYTES = 128;
const MAX_REMOTE_REQUEST_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_REMOTE_REQUEST_HEADERS_BYTES = 16 * 1024;

export function validateUploadFileSize(file: File, maxFileBytes: number): void {
  if (file.size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (file.size > maxFileBytes) {
    throw fileTooLargeError(maxFileBytes, file.size);
  }
}

export function renameUploadFile(file: File, fileName: string): File {
  return new File([file], fileName, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified
  });
}

export function fileTooLargeError(
  maxFileBytes: number,
  actualFileBytes: number,
  extraDetails: Record<string, unknown> = {}
): AppError {
  const maxFileSize = formatHumanFileSize(maxFileBytes);
  const actualFileSize = formatHumanFileSize(actualFileBytes);

  return new AppError(413, "FileTooLarge", `文件大小不能超过 ${maxFileSize}（当前 ${actualFileSize}）`, {
    max_file_bytes: maxFileBytes,
    actual_file_bytes: actualFileBytes,
    max_file_size: maxFileSize,
    actual_file_size: actualFileSize,
    ...extraDetails
  });
}

export function formatHumanFileSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0B";
  }

  const units = [
    { label: "T", bytes: 1024 ** 4 },
    { label: "G", bytes: 1024 ** 3 },
    { label: "MB", bytes: 1024 ** 2 },
    { label: "KB", bytes: 1024 },
    { label: "B", bytes: 1 }
  ];
  let remaining = Math.floor(value);
  const parts: string[] = [];

  for (const unit of units) {
    const count = Math.floor(remaining / unit.bytes);
    if (count <= 0) {
      continue;
    }

    parts.push(`${count}${unit.label}`);
    remaining -= count * unit.bytes;
  }

  return parts.join("") || "0B";
}

export function normalizeSourceUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 4096) {
    throw new AppError(400, "InvalidUrl", "URL is too long");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new AppError(400, "InvalidUrl", "URL must be absolute");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "InvalidUrl", "URL protocol must be http or https");
  }

  return url;
}

export function normalizeRemoteRequestHeaders(value: unknown): RemoteRequestHeaders | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const entries = remoteHeaderEntries(value);
  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length > MAX_REMOTE_REQUEST_HEADER_COUNT) {
    throw new AppError(400, "TooManySourceHeaders", `远端请求头最多支持 ${MAX_REMOTE_REQUEST_HEADER_COUNT} 个`);
  }

  const encoder = new TextEncoder();
  const result: RemoteRequestHeaders = {};
  const names = new Map<string, string>();
  let totalBytes = 0;

  for (const [rawName, rawValue] of entries) {
    const name = normalizeRemoteRequestHeaderName(rawName);
    const valueText = normalizeRemoteRequestHeaderValue(rawValue, name);

    if (!valueText) {
      continue;
    }

    const lowerName = name.toLowerCase();
    const previousName = names.get(lowerName);
    if (previousName) {
      delete result[previousName];
    }

    names.set(lowerName, name);
    result[name] = valueText;
    totalBytes += encoder.encode(name).byteLength + encoder.encode(valueText).byteLength;
  }

  if (Object.keys(result).length > MAX_REMOTE_REQUEST_HEADER_COUNT) {
    throw new AppError(400, "TooManySourceHeaders", `远端请求头最多支持 ${MAX_REMOTE_REQUEST_HEADER_COUNT} 个`);
  }

  if (totalBytes > MAX_REMOTE_REQUEST_HEADERS_BYTES) {
    throw new AppError(400, "SourceHeadersTooLarge", "远端请求头总大小过大");
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function remoteRequestHeadersJson(headers: RemoteRequestHeaders | undefined): string | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  return JSON.stringify(Object.fromEntries(
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right, "en", { sensitivity: "base" }))
  ));
}

export function storedRemoteRequestHeaders(value: string | null | undefined): RemoteRequestHeaders | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return normalizeRemoteRequestHeaders(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(500, "InvalidStoredSourceHeaders", "保存的远端请求头无效");
    }
    throw new AppError(500, "InvalidStoredSourceHeaders", "保存的远端请求头 JSON 无效");
  }
}

export function remoteFetchHeaders(
  sourceHeaders: RemoteRequestHeaders | undefined,
  defaults: Record<string, string>,
  overrides: Record<string, string> = {}
): Headers {
  const headers = new Headers(defaults);

  for (const [name, value] of Object.entries(sourceHeaders ?? {})) {
    headers.set(name, value);
  }

  for (const [name, value] of Object.entries(overrides)) {
    headers.set(name, value);
  }

  return headers;
}

function remoteHeaderEntries(value: unknown): Array<[string, unknown]> {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return [];
    }

    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return remoteHeaderEntries(JSON.parse(text) as unknown);
      } catch {
        throw new AppError(400, "InvalidSourceHeaders", "远端请求头 JSON 无效");
      }
    }

    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator <= 0) {
          throw new AppError(400, "InvalidSourceHeaders", "远端请求头每行必须是 Header-Name: value 格式");
        }
        return [line.slice(0, separator), line.slice(separator + 1)] satisfies [string, string];
      });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return [String(entry[0]), entry[1]] satisfies [string, unknown];
      }

      if (isPlainRecord(entry) && typeof entry.name === "string") {
        return [entry.name, entry.value] satisfies [string, unknown];
      }

      throw new AppError(400, "InvalidSourceHeaders", "远端请求头数组必须包含 {name, value}");
    });
  }

  if (isPlainRecord(value)) {
    return Object.entries(value);
  }

  throw new AppError(400, "InvalidSourceHeaders", "headers 必须是对象、数组或 Header-Name: value 文本");
}

function normalizeRemoteRequestHeaderName(value: string): string {
  const name = value.trim();
  const nameBytes = new TextEncoder().encode(name).byteLength;

  if (!name || nameBytes > MAX_REMOTE_REQUEST_HEADER_NAME_BYTES || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new AppError(400, "InvalidSourceHeaderName", `无效的远端请求头名称：${value}`);
  }

  const lowerName = name.toLowerCase();
  if (isBlockedRemoteRequestHeader(lowerName)) {
    throw new AppError(400, "UnsupportedSourceHeader", `不允许自定义远端请求头：${name}`);
  }

  return name;
}

function normalizeRemoteRequestHeaderValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidSourceHeaderValue", `远端请求头 ${name} 的值必须是字符串`);
  }

  const normalized = value.trim();
  if (!normalized) {
    return "";
  }

  if (/[\r\n]/.test(normalized)) {
    throw new AppError(400, "InvalidSourceHeaderValue", `远端请求头 ${name} 的值不能包含换行`);
  }

  if (new TextEncoder().encode(normalized).byteLength > MAX_REMOTE_REQUEST_HEADER_VALUE_BYTES) {
    throw new AppError(400, "SourceHeaderTooLarge", `远端请求头 ${name} 的值过大`);
  }

  return normalized;
}

function isBlockedRemoteRequestHeader(lowerName: string): boolean {
  return lowerName === "host" ||
    lowerName === "range" ||
    lowerName === "content-length" ||
    lowerName === "connection" ||
    lowerName === "keep-alive" ||
    lowerName === "proxy-authenticate" ||
    lowerName === "proxy-authorization" ||
    lowerName === "te" ||
    lowerName === "trailer" ||
    lowerName === "transfer-encoding" ||
    lowerName === "upgrade" ||
    lowerName === "accept-encoding" ||
    lowerName === "cf-connecting-ip" ||
    lowerName === "cf-ipcountry" ||
    lowerName === "cf-ray" ||
    lowerName === "cf-visitor" ||
    lowerName === "true-client-ip" ||
    lowerName === "x-forwarded-for" ||
    lowerName === "x-forwarded-host" ||
    lowerName === "x-forwarded-proto" ||
    lowerName === "x-real-ip";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
