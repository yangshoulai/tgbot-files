import type { DroppedFileEntry } from "./types";

interface WebkitFileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface WebkitFileSystemFileEntryLike extends WebkitFileSystemEntryLike {
  isFile: true;
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
}

interface WebkitFileSystemDirectoryEntryLike extends WebkitFileSystemEntryLike {
  isDirectory: true;
  createReader: () => {
    readEntries: (
      success: (entries: WebkitFileSystemEntryLike[]) => void,
      failure?: (error: DOMException) => void
    ) => void;
  };
}

interface OptionalWebkitEntryGetter {
  webkitGetAsEntry?: () => WebkitFileSystemEntryLike | null;
}

export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFileEntry[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => {
      const getter = (item as unknown as OptionalWebkitEntryGetter).webkitGetAsEntry;
      return typeof getter === "function" ? getter.call(item) : null;
    })
    .filter((entry): entry is WebkitFileSystemEntryLike => Boolean(entry));

  if (entries.length === 0) {
    return [];
  }

  const nested = await Promise.all(entries.map((entry) => readDroppedEntry(entry, "")));
  return nested.flat();
}

export async function readDroppedEntry(entry: WebkitFileSystemEntryLike, parentPath: string): Promise<DroppedFileEntry[]> {
  if (entry.isFile) {
    const file = await readDroppedFile(entry as WebkitFileSystemFileEntryLike);
    return [{
      file,
      ...(parentPath ? { relativePath: normalizeRelativePath(`${parentPath}/${file.name}`) } : {})
    }];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const directory = entry as WebkitFileSystemDirectoryEntryLike;
  const directoryPath = parentPath ? `${parentPath}/${directory.name}` : directory.name;
  const children = await readDroppedDirectoryEntries(directory);
  const nested = await Promise.all(children.map((child) => readDroppedEntry(child, directoryPath)));
  return nested.flat();
}

export function readDroppedFile(entry: WebkitFileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

export async function readDroppedDirectoryEntries(directory: WebkitFileSystemDirectoryEntryLike): Promise<WebkitFileSystemEntryLike[]> {
  const reader = directory.createReader();
  const entries: WebkitFileSystemEntryLike[] = [];

  while (true) {
    const batch = await new Promise<WebkitFileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) {
      break;
    }
    entries.push(...batch);
  }

  return entries;
}

export function browserRelativePath(file: File): string | undefined {
  const value = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeRelativePath(value);
}

export function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");

  return segments.length > 0 ? segments.join("/") : undefined;
}

export function relativeDirectoryPathFor(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length <= 1) return undefined;
  return segments.slice(0, -1).join("/");
}

export function joinDirectoryPath(baseDirectoryPath: string, relativeDirectoryPath: string | undefined): string {
  const base = baseDirectoryPath === "/" ? "" : baseDirectoryPath.replace(/\/+$/g, "");
  const relative = relativeDirectoryPath?.replace(/^\/+|\/+$/g, "");

  if (!relative) {
    return base || "/";
  }

  return `${base}/${relative}`.replace(/\/+/g, "/") || "/";
}
