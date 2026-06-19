import { FolderTree } from "lucide-react";
import { cn } from "../../../../lib/cn";
import {
  buildFolderTree,
  countFolderTreeDirectories,
  folderNodeStatusClass,
  folderNodeStatusLabel,
  type FolderTreeNode
} from "../folder-tree";
import type { QueueItem } from "../types";

export function FolderUploadTree({ items, baseDirectoryPath }: { items: QueueItem[]; baseDirectoryPath: string }) {
  const folderItems = items.filter((item) => item.relativePath);
  if (folderItems.length === 0) {
    return null;
  }

  const root = buildFolderTree(folderItems);
  const nodes = Array.from(root.children.values());
  const directoryCount = countFolderTreeDirectories(root);

  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
            <FolderTree size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">文件夹目录树</p>
            <p className="truncate text-xs text-muted" title={baseDirectoryPath}>
              上传到 {baseDirectoryPath}
            </p>
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted">
          {folderItems.length} 文件 · {directoryCount} 目录
        </span>
      </div>
      <div className="max-h-56 overflow-auto rounded-lg border border-border bg-surface/70 p-2 scroll-thin">
        {nodes.map((node) => (
          <FolderTreeNodeRow key={node.path} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}

function FolderTreeNodeRow({ node, depth }: { node: FolderTreeNode; depth: number }) {
  const children = Array.from(node.children.values());
  const isFile = node.kind === "file";

  return (
    <div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs",
          isFile ? "text-muted" : "font-medium text-foreground"
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", folderNodeStatusClass(node, isFile))} />
        <span className="min-w-0 flex-1 truncate" title={node.path}>{node.name}</span>
        {isFile && node.status ? (
          <span className="shrink-0 text-[11px] text-subtle">{folderNodeStatusLabel(node)}</span>
        ) : null}
      </div>
      {children.map((child) => (
        <FolderTreeNodeRow key={child.path} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
