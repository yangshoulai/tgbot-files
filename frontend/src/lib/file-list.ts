import type { DirectoryItem, FileItem } from "../api";
import { fileKind } from "../utils";

export type FileTypeFilter = "all" | "image" | "video" | "text" | "pdf" | "archive" | "other";
export type FileSortKey = "name" | "size" | "created_at" | "type";
export type SortDirection = "asc" | "desc";
export type FileLayoutMode = "list" | "grid";

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function initialFileLayoutMode(storageKey: string): FileLayoutMode {
  if (typeof window === "undefined") {
    return "list";
  }

  try {
    return window.localStorage.getItem(storageKey) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function parentDirectoryPath(path: string): string {
  if (path === "/") return "/";
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function directoryBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const segments = path.split("/").filter(Boolean);
  const breadcrumbs = [{ label: "/", path: "/" }];
  let current = "";

  for (const segment of segments) {
    current += `/${segment}`;
    breadcrumbs.push({ label: segment, path: current });
  }

  return breadcrumbs;
}

export function compareFileItems(
  left: FileItem,
  right: FileItem,
  sortKey: FileSortKey,
  direction: SortDirection
): number {
  const modifier = direction === "asc" ? 1 : -1;

  switch (sortKey) {
    case "name":
      return modifier * collator.compare(left.file_name, right.file_name);
    case "size":
      return modifier * ((left.size || 0) - (right.size || 0));
    case "type": {
      const leftType = `${fileKind(left).label} ${left.mime_type || ""}`;
      const rightType = `${fileKind(right).label} ${right.mime_type || ""}`;
      return modifier * collator.compare(leftType, rightType);
    }
    case "created_at":
    default:
      return modifier * (Date.parse(left.created_at) - Date.parse(right.created_at));
  }
}

export function compareDirectoryItems(
  left: DirectoryItem,
  right: DirectoryItem,
  sortKey: FileSortKey,
  direction: SortDirection
): number {
  const modifier = direction === "asc" ? 1 : -1;
  let result = 0;

  switch (sortKey) {
    case "size":
      result = (left.total_size || 0) - (right.total_size || 0);
      break;
    case "created_at":
      result = Date.parse(left.created_at) - Date.parse(right.created_at);
      break;
    case "type":
      result = collator.compare("文件夹", "文件夹");
      break;
    case "name":
    default:
      result = collator.compare(left.name, right.name);
      break;
  }

  if (result === 0) {
    result = collator.compare(left.name, right.name);
  }

  return modifier * result;
}
