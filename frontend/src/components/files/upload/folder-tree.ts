import { type FileNameConflictAction } from "../../../api";
import type { ItemStatus, QueueItem } from "./types";
import { effectiveFileName } from "./filename-conflict";

export interface FolderTreeNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  status?: ItemStatus;
  conflict?: boolean;
  conflictAction?: FileNameConflictAction;
  renamed?: boolean;
  children: Map<string, FolderTreeNode>;
}

export function buildFolderTree(items: QueueItem[]): FolderTreeNode {
  const root: FolderTreeNode = {
    name: "root",
    path: "/",
    kind: "directory",
    children: new Map()
  };

  for (const item of items) {
    const relativePath = item.relativePath;
    if (!relativePath) continue;

    const segments = relativePath.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      currentPath = `${currentPath}/${segment}`;
      const key = `${isFile ? "file" : "dir"}:${segment}`;
      let child = current.children.get(key);

      if (!child) {
        child = {
          name: isFile ? effectiveFileName(item) : segment,
          path: currentPath,
          kind: isFile ? "file" : "directory",
          children: new Map()
        };
        current.children.set(key, child);
      }

      if (isFile) {
        child.name = effectiveFileName(item);
        child.status = item.status;
        child.conflict = Boolean(item.conflict);
        child.conflictAction = item.conflictAction;
        child.renamed = Boolean(item.fileNameOverride);
      }

      current = child;
    });
  }

  sortFolderTree(root);
  return root;
}

export function sortFolderTree(node: FolderTreeNode): void {
  const sorted = Array.from(node.children.entries()).sort(([, left], [, right]) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  node.children = new Map(sorted);
  for (const child of node.children.values()) {
    sortFolderTree(child);
  }
}

export function countFolderTreeDirectories(node: FolderTreeNode): number {
  let count = node.kind === "directory" && node.path !== "/" ? 1 : 0;
  for (const child of node.children.values()) {
    count += countFolderTreeDirectories(child);
  }
  return count;
}

export function folderNodeStatusClass(node: FolderTreeNode, isFile: boolean): string {
  if (!isFile) return "bg-primary";

  if (node.conflict) return "bg-warning";
  if (node.conflictAction === "overwrite") return "bg-warning";
  if (node.renamed) return "bg-primary";

  switch (node.status) {
    case "done":
      return "bg-success";
    case "error":
      return "bg-warning";
    case "skipped":
      return "bg-subtle";
    case "uploading":
      return "bg-primary";
    default:
      return "bg-border-strong";
  }
}

export function folderNodeStatusLabel(node: FolderTreeNode): string {
  if (node.conflict) return "冲突";
  if (node.conflictAction === "overwrite") return "覆盖";
  if (node.renamed) return "改名";

  switch (node.status) {
    case "done":
      return "完成";
    case "error":
      return "待处理";
    case "skipped":
      return "忽略";
    case "uploading":
      return "上传中";
    default:
      return "待上传";
  }
}
