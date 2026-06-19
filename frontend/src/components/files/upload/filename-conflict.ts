import { ApiError, type UploadPreflightResultEntry } from "../../../api";
import type { FileNameConflictState, QueueItem } from "./types";
import { joinDirectoryPath } from "./dropped-files";

export function effectiveFileName(item: QueueItem): string {
  return normalizedFileNameOverride(item.fileNameOverride) ?? item.file.name;
}

export function effectiveDirectoryPath(item: QueueItem, baseDirectoryPath: string): string {
  return joinDirectoryPath(baseDirectoryPath, item.relativeDirectoryPath);
}

export function normalizedFileNameOverride(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function fileNameConflictFromError(error: unknown): FileNameConflictState | undefined {
  if (!(error instanceof ApiError) || error.status !== 409 || error.error !== "FileNameConflict") {
    return undefined;
  }

  const fileName = stringDetail(error.details, "file_name") || "同名文件";
  return {
    fileName,
    suggestedName: stringDetail(error.details, "suggested_name") || suggestAlternativeFileName(fileName),
    directoryPath: stringDetail(error.details, "directory_path") || "/",
    source: stringDetail(error.details, "source") === "file" ? "file" : undefined
  };
}

export function fileNameConflictFromPreflight(entry: UploadPreflightResultEntry): FileNameConflictState {
  return {
    fileName: entry.file_name,
    suggestedName: entry.suggested_name || suggestAlternativeFileName(entry.file_name),
    directoryPath: entry.directory_path,
    source: entry.source,
    message: entry.message
  };
}

export function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function suggestAlternativeFileName(fileName: string): string {
  const match = /^(.*?)(\.[^./\\]{1,12})$/.exec(fileName);
  const base = match?.[1] || fileName;
  const extension = match?.[2] || "";

  return `${base} (1)${extension}`;
}
