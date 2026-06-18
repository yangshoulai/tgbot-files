import { AppError, sanitizeFileName } from "../utils/http";
import type { ApiKeyStatus, FileTypeFilter } from "../database";

export function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} is required`);
  }

  return value.trim();
}

export function positiveIntegerField(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be a positive integer`);
  }

  return parsed;
}

export function optionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be a non-negative integer`);
  }

  return parsed;
}

export function optionalTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function normalizeMimeTypeField(value: unknown): string {
  if (typeof value !== "string") {
    return "application/octet-stream";
  }

  const normalized = value.split(";")[0]?.trim().toLowerCase();
  return normalized || "application/octet-stream";
}

export function parseContentRange(value: string | null): { start: number; end: number; size: number } | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    end < start ||
    size <= 0
  ) {
    return undefined;
  }

  return { start, end, size };
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError(400, "InvalidContentType", "Request must use application/json");
  }

  const body = await request.json();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(400, "InvalidBody", "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeName(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", `${fieldName} is required`);
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 80) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be 1-80 characters`);
  }

  return normalized;
}

export function normalizeFileNameUpdate(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "InvalidFileName", "File name must be 1-180 characters");
  }

  const normalized = sanitizeFileName(value);

  if (!normalized || normalized === "file" && value.trim().length === 0) {
    throw new AppError(400, "InvalidFileName", "File name must be 1-180 characters");
  }

  return normalized;
}

export function normalizeOptionalFileName(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeFileNameUpdate(value);
}

export function normalizeDirectoryName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidDirectoryName", "Directory name is required");
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 80) {
    throw new AppError(400, "InvalidDirectoryName", "Directory name must be 1-80 characters");
  }

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AppError(400, "InvalidDirectoryName", "Directory name contains unsupported characters");
  }

  return normalized;
}

export function normalizeDirectoryPath(value: unknown): string {
  if (typeof value !== "string") {
    return "/";
  }

  let normalized = value.trim();

  if (!normalized) {
    return "/";
  }

  if (normalized.length > 512) {
    throw new AppError(400, "InvalidDirectoryPath", "Directory path is too long");
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/g, "");
  }

  // 目录路径是用户可控输入，统一在入口处清洗，避免后续数据库和移动逻辑重复判断。
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (
      segment.length > 80 ||
      segment !== segment.trim() ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      throw new AppError(400, "InvalidDirectoryPath", "Directory path is invalid");
    }
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function normalizeFileIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", "file_ids must be an array");
  }

  const ids = Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))).filter(Boolean);

  if (ids.length === 0) {
    throw new AppError(400, "InvalidBody", "file_ids must not be empty");
  }

  if (ids.length > 100) {
    throw new AppError(400, "InvalidBody", "file_ids must contain at most 100 ids");
  }

  return ids;
}

export function normalizeQueryIdList(value: string | null, fieldName: string): string[] {
  if (!value) {
    return [];
  }

  const ids = Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
  if (ids.length === 0) {
    throw new AppError(400, "InvalidQuery", `${fieldName} must not be empty`);
  }
  if (ids.length > 100) {
    throw new AppError(400, "InvalidQuery", `${fieldName} must contain at most 100 ids`);
  }
  return ids;
}

export function normalizeOptionalIdList(value: unknown, fieldName: "file_ids" | "directory_ids"): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be an array`);
  }

  const ids = Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))).filter(Boolean);

  if (ids.length > 100) {
    throw new AppError(400, "InvalidBody", `${fieldName} must contain at most 100 ids`);
  }

  return ids;
}

export function requireEntrySelection(fileIds: string[], directoryIds: string[]): void {
  if (fileIds.length === 0 && directoryIds.length === 0) {
    throw new AppError(400, "InvalidBody", "file_ids or directory_ids must not be empty");
  }
}

export function normalizeApiKeyStatus(value: unknown): ApiKeyStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new AppError(400, "InvalidBody", "API key status must be active or disabled");
}

export function normalizeRemark(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 1000);
}

export function normalizeRemarkUpdate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "remark must be a string or null");
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

export function normalizeFileTypeFilter(value: string | null): FileTypeFilter | undefined {
  if (!value || value === "all") {
    return undefined;
  }

  if (
    value === "image" ||
    value === "video" ||
    value === "text" ||
    value === "pdf" ||
    value === "archive" ||
    value === "other"
  ) {
    return value;
  }

  throw new AppError(400, "InvalidQuery", "File type filter is invalid");
}

export function normalizeDateTimeParam(value: string | null, fieldName: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "InvalidQuery", `${fieldName} must be a valid date time`);
  }

  return date.toISOString();
}

export function parsePositiveInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}
