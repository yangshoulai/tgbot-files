import { AppError, sanitizeFileName } from "./http";
import { mimeTypeForFileName } from "./mime";
import { isPlainRecord, normalizeOptionalFileName, positiveIntegerField } from "../validators/request";
import type { FileNameConflictAction, MagnetImportFileRecord, MagnetImportRecord } from "../database";
import path from "node:path";

export interface MagnetFileUploadOption {
  fileName?: string;
  conflictAction?: FileNameConflictAction;
}

export interface MagnetAria2TuningConfig {
  split: number;
  maxConnectionPerServer: number;
  minSplitSize: string;
  btMaxPeers: number;
  btTrackers?: string | undefined;
}

export type BValue = number | Uint8Array | BValue[] | Map<string, BValue>;

export function isInitializedMagnetImportStatus(status: MagnetImportRecord["status"]): boolean {
  return status === "downloading" || status === "downloaded" || status === "importing" || status === "done";
}

export function selectedMagnetFileIndexes(record: MagnetImportRecord, files: MagnetImportFileRecord[]): number[] {
  const fromRecord = parseSelectedMagnetIndexes(record.selected_indexes_json);
  if (fromRecord.length > 0) {
    return fromRecord;
  }

  return files
    .filter((file) => file.selected === 1)
    .map((file) => file.file_index)
    .sort((left, right) => left - right);
}

export function parseSelectedMagnetIndexes(value: string | null): number[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return Array.from(new Set(parsed.map((item) => Number(item))))
      .filter((item) => Number.isSafeInteger(item) && item > 0)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

export function sameNumberSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort((a, b) => a - b);
  const normalizedRight = [...right].sort((a, b) => a - b);
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function normalizeMagnetUri(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "MissingMagnet", "JSON field 'magnet' is required");
  }

  const normalized = value.trim();
  if (!normalized.toLowerCase().startsWith("magnet:?")) {
    throw new AppError(400, "InvalidMagnet", "仅支持 magnet:? 磁力链接");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AppError(400, "InvalidMagnet", "磁力链接格式无效");
  }

  if (parsed.protocol !== "magnet:" || !parsed.searchParams.get("xt")) {
    throw new AppError(400, "InvalidMagnet", "磁力链接缺少 xt 参数");
  }

  return normalized;
}

export function normalizeMagnetFileIndexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, "InvalidMagnetFileSelection", "file_indexes must be a non-empty array");
  }

  const indexes = Array.from(new Set(value.map((item) => Number(item))));
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index <= 0) {
      throw new AppError(400, "InvalidMagnetFileSelection", "file_indexes contains an invalid file index");
    }
  }

  return indexes.sort((left, right) => left - right);
}

export function normalizeMagnetFileUploadOptions(
  value: unknown,
  selectedIndexes: number[],
  normalizeConflictAction: (value: unknown) => FileNameConflictAction
): Map<number, MagnetFileUploadOption> {
  const options = new Map<number, MagnetFileUploadOption>();

  if (value === undefined || value === null) {
    return options;
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidMagnetFileOptions", "file_options must be an array");
  }

  const selectedSet = new Set(selectedIndexes);
  for (const [position, item] of value.entries()) {
    if (!isPlainRecord(item)) {
      throw new AppError(400, "InvalidMagnetFileOptions", `file_options[${position}] must be an object`);
    }

    const fileIndex = positiveIntegerField(item.file_index, `file_options[${position}].file_index`);
    if (!selectedSet.has(fileIndex)) {
      throw new AppError(400, "InvalidMagnetFileOptions", `file_options[${position}].file_index is not selected`);
    }

    const option: MagnetFileUploadOption = {};
    const fileName = normalizeOptionalFileName(item.file_name);
    if (fileName) {
      option.fileName = fileName;
    }

    if (item.on_conflict !== undefined) {
      option.conflictAction = normalizeConflictAction(item.on_conflict);
    }

    if (option.fileName || option.conflictAction) {
      options.set(fileIndex, option);
    }
  }

  return options;
}

export function parseMagnetFileIndex(value: string): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new AppError(400, "InvalidMagnetFileIndex", "Magnet file index is invalid");
  }
  return index;
}

export function magnetInfoHash(magnetUri: string): string | null {
  try {
    const xt = new URL(magnetUri).searchParams.get("xt");
    const match = /^urn:btih:([a-z0-9]+)$/i.exec(xt || "");
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function normalizeTorrentRelativePath(value: string): string | null {
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment, index, all) => index === all.length - 1 ? sanitizeFileName(segment) : sanitizeDirectorySegment(segment))
    .filter(Boolean);

  return segments.length > 0 ? segments.join("/") : null;
}

export function sanitizeDirectorySegment(value: string | undefined): string {
  const cleaned = sanitizeFileName(value)
    .replace(/[\\/]/g, "")
    .trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "folder";
  }

  return cleaned.slice(0, 80);
}

export function mimeTypeForMagnetFileName(fileName: string): string {
  return mimeTypeForFileName(fileName) ?? "application/octet-stream";
}

export function aria2MagnetOptions(config: MagnetAria2TuningConfig, options: Record<string, string>): Record<string, string> {
  const tunedOptions = {
    split: String(config.split),
    "max-connection-per-server": String(config.maxConnectionPerServer),
    "min-split-size": config.minSplitSize,
    "bt-max-peers": String(config.btMaxPeers),
    ...options
  };

  return config.btTrackers
    ? { ...tunedOptions, "bt-tracker": config.btTrackers }
    : tunedOptions;
}

export function safeMagnetFilePath(downloadDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(downloadDir);
  const resolved = path.resolve(downloadDir, relativePath);
  if (resolved !== resolvedBase && resolved.startsWith(`${resolvedBase}${path.sep}`)) {
    return resolved;
  }
  throw new AppError(400, "InvalidMagnetFilePath", "磁力文件路径无效");
}

export function parseBencode(bytes: Uint8Array): Map<string, BValue> {
  let offset = 0;

  const parseValue = (): BValue => {
    const byte = bytes[offset];
    if (byte === undefined) {
      throw new AppError(400, "InvalidTorrentMetadata", "Torrent metadata is truncated");
    }

    if (byte === 0x69) {
      offset += 1;
      const end = bytes.indexOf(0x65, offset);
      if (end < 0) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent integer is invalid");
      }
      const text = new TextDecoder().decode(bytes.slice(offset, end));
      offset = end + 1;
      const value = Number(text);
      if (!Number.isSafeInteger(value)) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent integer is out of range");
      }
      return value;
    }

    if (byte === 0x6c) {
      offset += 1;
      const values: BValue[] = [];
      while (bytes[offset] !== 0x65) {
        values.push(parseValue());
      }
      offset += 1;
      return values;
    }

    if (byte === 0x64) {
      offset += 1;
      const values = new Map<string, BValue>();
      while (bytes[offset] !== 0x65) {
        const key = parseValue();
        if (!(key instanceof Uint8Array)) {
          throw new AppError(400, "InvalidTorrentMetadata", "Torrent dictionary key is invalid");
        }
        values.set(new TextDecoder().decode(key), parseValue());
      }
      offset += 1;
      return values;
    }

    if (byte >= 0x30 && byte <= 0x39) {
      let colon = offset;
      while (bytes[colon] !== 0x3a) {
        colon += 1;
        if (colon >= bytes.length) {
          throw new AppError(400, "InvalidTorrentMetadata", "Torrent byte string is invalid");
        }
      }
      const length = Number(new TextDecoder().decode(bytes.slice(offset, colon)));
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent byte string length is invalid");
      }
      offset = colon + 1;
      const end = offset + length;
      if (end > bytes.length) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent byte string is truncated");
      }
      const value = bytes.slice(offset, end);
      offset = end;
      return value;
    }

    throw new AppError(400, "InvalidTorrentMetadata", "Torrent metadata is invalid");
  };

  const root = parseValue();
  if (!(root instanceof Map)) {
    throw new AppError(400, "InvalidTorrentMetadata", "Torrent root must be a dictionary");
  }
  return root;
}

export function bencodeDictValue(root: Map<string, BValue>, key: string): Map<string, BValue> {
  const value = root.get(key);
  if (!(value instanceof Map)) {
    throw new AppError(400, "InvalidTorrentMetadata", `Torrent metadata missing ${key}`);
  }
  return value;
}

export function bencodeListValue(value: BValue | undefined): BValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function bencodeStringValue(value: BValue | undefined): string | undefined {
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
}

export function bencodeNumberValue(value: BValue | undefined): number {
  return typeof value === "number" ? value : Number.NaN;
}
