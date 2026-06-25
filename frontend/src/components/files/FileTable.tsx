import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Copy,
  Download,
  Eye,
  Folder,
  FolderInput,
  FolderOpen,
  Info,
  ImagePlus,
  Pencil,
  MoreVertical,
  Trash2,
  UploadCloud
} from "lucide-react";
import type { DirectoryItem, FileItem } from "../../api";
import {
  canPreviewThroughAvailableAccess,
  hasFileLinkAccess
} from "../../lib/file-access";
import { cn } from "../../lib/cn";
import type { FileCacheEntry, FileCacheSummary } from "../../lib/file-cache";
import { fileKind, formatBytes, formatDateTime } from "../../utils";
import { IconButton } from "../ui/IconButton";
import { FileVisual } from "../ui/FileVisual";
import { EmptyState } from "../ui/EmptyState";

type FileSortKey = "name" | "size" | "created_at" | "type";
type SortDirection = "asc" | "desc";

type ContextMenuState =
  | { kind: "directory"; directory: DirectoryItem; x: number; y: number }
  | { kind: "file"; file: FileItem; x: number; y: number }
  | null;

type ContextMenuEntry =
  | { type: "separator"; key: string }
  | {
      type: "item";
      key: string;
      label: string;
      icon: ReactNode;
      tone?: "default" | "danger";
      disabled?: boolean;
      onSelect: () => void;
    };

interface FileTableProps {
  directories: DirectoryItem[];
  files: FileItem[];
  layout?: "list" | "grid";
  selectedFileIds: Set<string>;
  selectedDirectoryIds: Set<string>;
  allPageSelected: boolean;
  sortKey: FileSortKey;
  sortDirection: SortDirection;
  onSort: (key: FileSortKey) => void;
  onOpenDirectory: (directory: DirectoryItem) => void;
  onRenameDirectory: (directory: DirectoryItem) => void;
  onMoveDirectory: (directory: DirectoryItem) => void;
  onDeleteDirectory: (directory: DirectoryItem) => void;
  onUploadToDirectory: (directory: DirectoryItem) => void;
  onToggleFileSelected: (file: FileItem, selected: boolean) => void;
  onToggleDirectorySelected: (directory: DirectoryItem, selected: boolean) => void;
  onTogglePage: (selected: boolean) => void;
  onDetail: (file: FileItem) => void;
  onEdit: (file: FileItem) => void;
  onEditThumbnail: (file: FileItem) => void;
  onMoveFile: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
  onThumbnailPreview: (file: FileItem) => void;
  onCopy: (file: FileItem) => void;
  onAcceleratedDownload: (file: FileItem) => void;
  onClearFileCache: (file: FileItem) => void;
  cacheSummary: FileCacheSummary | null;
  onDelete: (file: FileItem) => void;
}

const checkboxClass =
  "block size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring";
const CONTEXT_MENU_MARGIN = 8;

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, [role='button']"));
}

function isSelectionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, select, textarea"));
}

function SortHeader({
  label,
  sortId,
  activeSort,
  direction,
  onSort,
  className
}: {
  label: string;
  sortId: FileSortKey;
  activeSort: FileSortKey;
  direction: SortDirection;
  onSort: (key: FileSortKey) => void;
  className?: string;
}) {
  const active = activeSort === sortId;
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  const nextDirection = active && direction === "asc" ? "降序" : "升序";

  return (
    <th className={className}>
      <button
        type="button"
        aria-label={`按${label}${nextDirection}排序`}
        onClick={() => onSort(sortId)}
        className="inline-flex items-center gap-1.5 rounded-md text-left font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
      >
        <span>{label}</span>
        <Icon size={14} className={active ? "text-primary" : "text-subtle"} />
      </button>
    </th>
  );
}

function fileCachePercent(entry: FileCacheEntry | null): number {
  if (!entry) return 0;
  if (entry.chunkCount > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedChunks / entry.chunkCount) * 100)));
  }
  if (entry.complete) return 100;
  if (entry.size > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedBytes / entry.size) * 100)));
  }
  return 0;
}

function fileCacheStatusText(entry: FileCacheEntry | null): string {
  if (!entry) return "未缓存";
  const percent = fileCachePercent(entry);
  if (entry.cachedBytes <= 0) return "未缓存";
  if (entry.complete) return "已缓存（100%）";
  return `已缓存（${percent}%）`;
}

function FileCacheBadge({ entry }: { entry: FileCacheEntry | null }) {
  const percent = fileCachePercent(entry);

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        !entry
          ? "bg-surface text-subtle ring-1 ring-border"
          : entry.cachedBytes <= 0
            ? "bg-surface text-subtle ring-1 ring-border"
          : entry.complete
            ? "bg-success-soft text-success"
            : "bg-primary-soft text-primary-strong"
      )}
      title={entry ? `已缓存 ${formatBytes(entry.cachedBytes)} / ${formatBytes(entry.size)}` : "未缓存"}
    >
      <span className="truncate">{fileCacheStatusText(entry)}</span>
      {entry && entry.cachedBytes > 0 && !entry.complete ? (
        <span className="hidden text-current/70 xl:inline">{percent}%</span>
      ) : null}
    </span>
  );
}

export function FileTable({
  directories,
  files,
  layout = "list",
  selectedFileIds,
  selectedDirectoryIds,
  allPageSelected,
  sortKey,
  sortDirection,
  onSort,
  onOpenDirectory,
  onRenameDirectory,
  onMoveDirectory,
  onDeleteDirectory,
  onUploadToDirectory,
  onToggleFileSelected,
  onToggleDirectorySelected,
  onTogglePage,
  onDetail,
  onEdit,
  onEditThumbnail,
  onMoveFile,
  onPreview,
  onThumbnailPreview,
  onCopy,
  onAcceleratedDownload,
  onClearFileCache,
  cacheSummary,
  onDelete
}: FileTableProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const cacheEntryMap = useMemo(() => {
    const map = new Map<string, FileCacheEntry>();
    for (const entry of cacheSummary?.entries ?? []) {
      map.set(entry.fileId, entry);
    }
    return map;
  }, [cacheSummary]);

  useEffect(() => {
    if (!contextMenu) return;

    function onPointerDown(event: PointerEvent) {
      const menu = contextMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) return;
      setContextMenu(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
      }
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("scroll", closeContextMenu, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;

    const frame = window.requestAnimationFrame(() => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const nextX = Math.max(
        CONTEXT_MENU_MARGIN,
        Math.min(contextMenu.x, window.innerWidth - rect.width - CONTEXT_MENU_MARGIN)
      );
      const nextY = Math.max(
        CONTEXT_MENU_MARGIN,
        Math.min(contextMenu.y, window.innerHeight - rect.height - CONTEXT_MENU_MARGIN)
      );

      if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
        setContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu]);

  function closeContextMenu() {
    setContextMenu(null);
  }

  function openDirectoryContextMenu(event: MouseEvent, directory: DirectoryItem) {
    if (isSelectionTarget(event.target)) return;
    event.preventDefault();
    setContextMenu({ kind: "directory", directory, x: event.clientX, y: event.clientY });
  }

  function openFileContextMenu(event: MouseEvent, file: FileItem) {
    if (isSelectionTarget(event.target)) return;
    event.preventDefault();
    setContextMenu({ kind: "file", file, x: event.clientX, y: event.clientY });
  }

  function openDirectoryActionsMenu(directory: DirectoryItem, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setContextMenu({
      kind: "directory",
      directory,
      x: rect.right,
      y: rect.bottom + 8
    });
  }

  function openFileActionsMenu(file: FileItem, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setContextMenu({
      kind: "file",
      file,
      x: rect.right,
      y: rect.bottom + 8
    });
  }

  function runContextAction(action: () => void) {
    setContextMenu(null);
    action();
  }

  function contextMenuEntries(state: Exclude<ContextMenuState, null>): ContextMenuEntry[] {
    if (state.kind === "directory") {
      const { directory } = state;
      return [
        {
          type: "item",
          key: "open",
          label: "打开",
          icon: <FolderOpen size={15} />,
          onSelect: () => runContextAction(() => onOpenDirectory(directory))
        },
        {
          type: "item",
          key: "upload",
          label: "上传到此目录",
          icon: <UploadCloud size={15} />,
          onSelect: () => runContextAction(() => onUploadToDirectory(directory))
        },
        { type: "separator", key: "directory-main-separator" },
        {
          type: "item",
          key: "rename",
          label: "重命名",
          icon: <Pencil size={15} />,
          onSelect: () => runContextAction(() => onRenameDirectory(directory))
        },
        {
          type: "item",
          key: "move",
          label: "移动到…",
          icon: <FolderInput size={15} />,
          onSelect: () => runContextAction(() => onMoveDirectory(directory))
        },
        { type: "separator", key: "directory-danger-separator" },
        {
          type: "item",
          key: "delete",
          label: "删除目录",
          icon: <Trash2 size={15} />,
          tone: "danger",
          onSelect: () => runContextAction(() => onDeleteDirectory(directory))
        }
      ];
    }

    const { file } = state;
    const linkFile = hasFileLinkAccess(file) ? file : null;
    const canPreviewFile = canPreviewThroughAvailableAccess(file);
    const cacheEntry = cacheEntryMap.get(file.id) ?? null;
    const cached = Boolean(cacheEntry?.cachedBytes);

    return [
      {
        type: "item",
        key: "preview",
        label: "预览",
        icon: <Eye size={15} />,
        disabled: !canPreviewFile,
        onSelect: () => runContextAction(() => onPreview(file))
      },
      {
        type: "item",
        key: "detail",
        label: "属性 / 详情",
        icon: <Info size={15} />,
        onSelect: () => runContextAction(() => onDetail(file))
      },
      { type: "separator", key: "file-main-separator" },
      {
        type: "item",
        key: "edit",
        label: "重命名 / 编辑信息",
        icon: <Pencil size={15} />,
        onSelect: () => runContextAction(() => onEdit(file))
      },
      {
        type: "item",
        key: "thumbnail",
        label: "修改缩略图",
        icon: <ImagePlus size={15} />,
        onSelect: () => runContextAction(() => onEditThumbnail(file))
      },
      {
        type: "item",
        key: "move",
        label: "移动到…",
        icon: <FolderInput size={15} />,
        onSelect: () => runContextAction(() => onMoveFile(file))
      },
      { type: "separator", key: "file-link-separator" },
      {
        type: "item",
        key: "copy",
        label: "复制链接",
        icon: <Copy size={15} />,
        disabled: !linkFile,
        onSelect: () => runContextAction(() => onCopy(file))
      },
      {
        type: "item",
        key: "download",
        label: "加速下载",
        icon: <Download size={15} />,
        onSelect: () => runContextAction(() => onAcceleratedDownload(file))
      },
      {
        type: "item",
        key: "clear-cache",
        label: cached ? `清除缓存（${formatBytes(cacheEntry!.cachedBytes)}）` : "清除缓存",
        icon: <Trash2 size={15} />,
        disabled: !cached,
        onSelect: () => runContextAction(() => onClearFileCache(file))
      },
      { type: "separator", key: "file-danger-separator" },
      {
        type: "item",
        key: "delete",
        label: "删除索引",
        icon: <Trash2 size={15} />,
        tone: "danger",
        onSelect: () => runContextAction(() => onDelete(file))
      }
    ];
  }

  if (files.length === 0 && directories.length === 0) {
    return <EmptyState title="没有文件或子目录" description="试试调整搜索条件，或新建目录、上传文件。" />;
  }

  const desktopLayout = layout === "grid" ? (
    <FileGridView
      directories={directories}
      files={files}
      allPageSelected={allPageSelected}
      selectedFileIds={selectedFileIds}
      selectedDirectoryIds={selectedDirectoryIds}
      onOpenDirectory={onOpenDirectory}
      onToggleFileSelected={onToggleFileSelected}
      onToggleDirectorySelected={onToggleDirectorySelected}
      onTogglePage={onTogglePage}
      onDetail={onDetail}
      onPreview={onPreview}
      onThumbnailPreview={onThumbnailPreview}
      openDirectoryContextMenu={openDirectoryContextMenu}
      openFileContextMenu={openFileContextMenu}
      openDirectoryActionsMenu={openDirectoryActionsMenu}
      openFileActionsMenu={openFileActionsMenu}
      cacheEntryMap={cacheEntryMap}
    />
  ) : (
    <FileListTableView
      directories={directories}
      files={files}
      selectedFileIds={selectedFileIds}
      selectedDirectoryIds={selectedDirectoryIds}
      allPageSelected={allPageSelected}
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSort={onSort}
      onOpenDirectory={onOpenDirectory}
      onToggleFileSelected={onToggleFileSelected}
      onToggleDirectorySelected={onToggleDirectorySelected}
      onTogglePage={onTogglePage}
      onDetail={onDetail}
      onPreview={onPreview}
      onThumbnailPreview={onThumbnailPreview}
      openDirectoryContextMenu={openDirectoryContextMenu}
      openFileContextMenu={openFileContextMenu}
      cacheEntryMap={cacheEntryMap}
    />
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className={cn("divide-y divide-border sm:hidden", layout === "grid" && "hidden")}>
        {directories.map((directory) => (
          <div
            key={directory.id}
            onContextMenu={(event) => openDirectoryContextMenu(event, directory)}
            className={cn(
              "p-3 transition-colors duration-150",
              selectedDirectoryIds.has(directory.id) && "bg-primary-soft/20"
            )}
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                aria-label={`选择目录 ${directory.name}`}
                checked={selectedDirectoryIds.has(directory.id)}
                onChange={(event) => onToggleDirectorySelected(directory, event.target.checked)}
                className={checkboxClass}
              />
              <button
                type="button"
                onClick={() => onOpenDirectory(directory)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:focus-ring"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong">
                  <Folder size={21} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground" title={directory.name}>
                    {directory.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    文件夹 · {directory.file_count} 个文件 · {formatBytes(directory.total_size)}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {formatDateTime(directory.created_at)}
                  </span>
                </span>
              </button>
              <IconButton
                size="sm"
                variant="ghost"
                label="更多操作"
                onClick={(event) => openDirectoryActionsMenu(directory, event.currentTarget)}
              >
                <MoreVertical size={16} />
              </IconButton>
            </div>
          </div>
        ))}
        {files.map((file) => {
          const linkFile = hasFileLinkAccess(file) ? file : null;
          const kind = fileKind(file);
          const mimeLabel = file.mime_type || "未知 MIME";
          const previewFromThumbnail = file.thumbnail_url ? () => onThumbnailPreview(file) : undefined;
          const canPreviewFile = canPreviewThroughAvailableAccess(file);
          const cacheEntry = cacheEntryMap.get(file.id) ?? null;

          return (
            <div
              key={file.id}
              onContextMenu={(event) => openFileContextMenu(event, file)}
              onDoubleClick={(event) => {
                if (isInteractiveTarget(event.target)) return;
                if (canPreviewFile) {
                  onPreview(file);
                } else {
                  onDetail(file);
                }
              }}
              className={cn(
                "p-3 transition-colors duration-150",
                selectedFileIds.has(file.id) && "bg-primary-soft/20"
              )}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  aria-label={`选择 ${file.file_name}`}
                  checked={selectedFileIds.has(file.id)}
                  onChange={(event) => onToggleFileSelected(file, event.target.checked)}
                  className={checkboxClass}
                />
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <FileVisual
                    mimeType={file.mime_type}
                    fileName={file.file_name}
                    url={linkFile ? file.file_path : undefined}
                    thumbnailUrl={file.thumbnail_url}
                    size="sm"
                    className="size-11 rounded-xl"
                    onClick={previewFromThumbnail}
                    actionLabel={`预览缩略图 ${file.file_name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={file.file_name}>
                      {file.file_name}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {kind.label} · {mimeLabel}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {formatBytes(file.size)} · {formatDateTime(file.created_at)}
                    </p>
                    <p className="mt-1">
                      <FileCacheBadge entry={cacheEntry} />
                    </p>
                  </div>
                </div>
                <IconButton
                  size="sm"
                  variant="ghost"
                  label="更多操作"
                  onClick={(event) => openFileActionsMenu(file, event.currentTarget)}
                >
                  <MoreVertical size={16} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
      {desktopLayout}
      {contextMenu ? (
        <ContextMenuSurface
          refNode={contextMenuRef}
          x={contextMenu.x}
          y={contextMenu.y}
          entries={contextMenuEntries(contextMenu)}
        />
      ) : null}
    </div>
  );
}

function FileListTableView({
  directories,
  files,
  selectedFileIds,
  selectedDirectoryIds,
  allPageSelected,
  sortKey,
  sortDirection,
  onSort,
  onOpenDirectory,
  onToggleFileSelected,
  onToggleDirectorySelected,
  onTogglePage,
  onDetail,
  onPreview,
  onThumbnailPreview,
  openDirectoryContextMenu,
  openFileContextMenu,
  cacheEntryMap
}: {
  directories: DirectoryItem[];
  files: FileItem[];
  selectedFileIds: Set<string>;
  selectedDirectoryIds: Set<string>;
  allPageSelected: boolean;
  sortKey: FileSortKey;
  sortDirection: SortDirection;
  onSort: (key: FileSortKey) => void;
  onOpenDirectory: (directory: DirectoryItem) => void;
  onToggleFileSelected: (file: FileItem, selected: boolean) => void;
  onToggleDirectorySelected: (directory: DirectoryItem, selected: boolean) => void;
  onTogglePage: (selected: boolean) => void;
  onDetail: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
  onThumbnailPreview: (file: FileItem) => void;
  openDirectoryContextMenu: (event: MouseEvent, directory: DirectoryItem) => void;
  openFileContextMenu: (event: MouseEvent, file: FileItem) => void;
  cacheEntryMap: Map<string, FileCacheEntry>;
}) {
  return (
    <div className="hidden overflow-x-hidden sm:block">
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-background/70">
            <th className="w-10 px-4 py-3 align-middle font-medium text-muted">
              <div className="flex h-full items-center">
                <input
                  type="checkbox"
                  aria-label="选择当前页内容"
                  checked={allPageSelected}
                  disabled={files.length === 0 && directories.length === 0}
                  onChange={(event) => onTogglePage(event.target.checked)}
                  className={checkboxClass}
                />
              </div>
            </th>
            <SortHeader
              label="文件"
              sortId="name"
              activeSort={sortKey}
              direction={sortDirection}
              onSort={onSort}
              className="px-4 py-3 text-left font-medium text-muted"
            />
            <SortHeader
              label="大小"
              sortId="size"
              activeSort={sortKey}
              direction={sortDirection}
              onSort={onSort}
              className="hidden w-32 px-4 py-3 text-left font-medium text-muted lg:table-cell"
            />
            <th className="hidden w-36 px-4 py-3 text-left font-medium text-muted xl:table-cell">
              缓存
            </th>
            <SortHeader
              label="上传时间"
              sortId="created_at"
              activeSort={sortKey}
              direction={sortDirection}
              onSort={onSort}
              className="hidden w-44 px-4 py-3 text-left font-medium text-muted md:table-cell"
            />
          </tr>
        </thead>
        <tbody>
          {directories.map((directory) => (
            <tr
              key={directory.id}
              onContextMenu={(event) => openDirectoryContextMenu(event, directory)}
              onDoubleClick={(event) => {
                if (isInteractiveTarget(event.target)) return;
                onOpenDirectory(directory);
              }}
              className={cn(
                "cursor-pointer border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-primary-soft/25",
                selectedDirectoryIds.has(directory.id) && "bg-primary-soft/20"
              )}
            >
              <td className="px-4 py-3 align-middle">
                <input
                  type="checkbox"
                  aria-label={`选择目录 ${directory.name}`}
                  checked={selectedDirectoryIds.has(directory.id)}
                  onChange={(event) => onToggleDirectorySelected(directory, event.target.checked)}
                  className={checkboxClass}
                />
              </td>
              <td className="max-w-0 px-4 py-3 align-middle">
                <button
                  type="button"
                  onClick={() => onOpenDirectory(directory)}
                  className="flex w-full min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:focus-ring"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong">
                    <Folder size={20} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold text-foreground" title={directory.name}>
                      {directory.name}
                    </span>
                    <span className="truncate text-xs text-muted">文件夹</span>
                    <span className="truncate text-xs text-muted lg:hidden">
                      {directory.file_count} 个文件 · {formatBytes(directory.total_size)}
                    </span>
                  </div>
                </button>
              </td>
              <td className="hidden whitespace-nowrap px-4 py-3 align-middle lg:table-cell">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">{formatBytes(directory.total_size)}</span>
                  <span className="text-xs text-muted">{directory.file_count} 个文件</span>
                </div>
              </td>
              <td className="hidden px-4 py-3 align-middle xl:table-cell">
                <span className="text-xs text-subtle">不适用</span>
              </td>
              <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                {formatDateTime(directory.created_at)}
              </td>
            </tr>
          ))}
          {files.map((file) => {
            const linkFile = hasFileLinkAccess(file) ? file : null;
            const canPreviewFile = canPreviewThroughAvailableAccess(file);
            const kind = fileKind(file);
            const mimeLabel = file.mime_type || "未知 MIME";
            const previewFromThumbnail = file.thumbnail_url ? () => onThumbnailPreview(file) : undefined;
            const cacheEntry = cacheEntryMap.get(file.id) ?? null;

            return (
              <tr
                key={file.id}
                onContextMenu={(event) => openFileContextMenu(event, file)}
                onDoubleClick={(event) => {
                  if (isInteractiveTarget(event.target)) return;
                  if (canPreviewFile) {
                    onPreview(file);
                  } else {
                    onDetail(file);
                  }
                }}
                className={cn(
                  "cursor-default border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-primary-soft/25",
                  selectedFileIds.has(file.id) && "bg-primary-soft/20"
                )}
              >
                <td className="px-4 py-3 align-middle">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${file.file_name}`}
                    checked={selectedFileIds.has(file.id)}
                    onChange={(event) => onToggleFileSelected(file, event.target.checked)}
                    className={checkboxClass}
                  />
                </td>
                <td className="max-w-0 px-4 py-3 align-middle">
                  <div className="flex w-full min-w-0 items-center gap-3">
                    <FileVisual
                      mimeType={file.mime_type}
                      fileName={file.file_name}
                      url={linkFile ? file.file_path : undefined}
                      thumbnailUrl={file.thumbnail_url}
                      size="sm"
                      onClick={previewFromThumbnail}
                      actionLabel={`预览缩略图 ${file.file_name}`}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground" title={file.file_name}>
                        {file.file_name}
                      </span>
                      <span className="truncate text-xs text-muted lg:hidden">
                        {kind.label} · {mimeLabel} · {formatBytes(file.size)}
                      </span>
                      <span className="hidden truncate text-xs text-muted lg:inline">
                        {kind.label} · {mimeLabel}
                      </span>
                      <span className="truncate text-xs text-muted xl:hidden">
                        {fileCacheStatusText(cacheEntry)}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-foreground lg:table-cell">
                  {formatBytes(file.size)}
                </td>
                <td className="hidden px-4 py-3 align-middle xl:table-cell">
                  <FileCacheBadge entry={cacheEntry} />
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                  {formatDateTime(file.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileGridView({
  directories,
  files,
  selectedFileIds,
  selectedDirectoryIds,
  allPageSelected,
  onOpenDirectory,
  onToggleFileSelected,
  onToggleDirectorySelected,
  onTogglePage,
  onDetail,
  onPreview,
  onThumbnailPreview,
  openDirectoryContextMenu,
  openFileContextMenu,
  openDirectoryActionsMenu,
  openFileActionsMenu,
  cacheEntryMap
}: {
  directories: DirectoryItem[];
  files: FileItem[];
  selectedFileIds: Set<string>;
  selectedDirectoryIds: Set<string>;
  allPageSelected: boolean;
  onOpenDirectory: (directory: DirectoryItem) => void;
  onToggleFileSelected: (file: FileItem, selected: boolean) => void;
  onToggleDirectorySelected: (directory: DirectoryItem, selected: boolean) => void;
  onTogglePage: (selected: boolean) => void;
  onDetail: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
  onThumbnailPreview: (file: FileItem) => void;
  openDirectoryContextMenu: (event: MouseEvent, directory: DirectoryItem) => void;
  openFileContextMenu: (event: MouseEvent, file: FileItem) => void;
  openDirectoryActionsMenu: (directory: DirectoryItem, anchor: HTMLElement) => void;
  openFileActionsMenu: (file: FileItem, anchor: HTMLElement) => void;
  cacheEntryMap: Map<string, FileCacheEntry>;
}) {
  return (
    <div className="bg-background/45">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3">
        <label className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            aria-label="选择当前页内容"
            checked={allPageSelected}
            disabled={files.length === 0 && directories.length === 0}
            onChange={(event) => onTogglePage(event.target.checked)}
            className={checkboxClass}
          />
          选择当前页
        </label>
        <p className="text-xs text-muted">
          {directories.length} 个目录 · {files.length} 个文件 · 双击可打开或预览
        </p>
      </div>
      <div className="grid gap-4 p-4 [grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr))]">
        {directories.map((directory) => {
          const selected = selectedDirectoryIds.has(directory.id);

          return (
            <article
              key={directory.id}
              onContextMenu={(event) => openDirectoryContextMenu(event, directory)}
              onDoubleClick={(event) => {
                if (isInteractiveTarget(event.target)) return;
                onOpenDirectory(directory);
              }}
              className={cn(
                "group flex min-h-[17rem] min-w-0 flex-col overflow-hidden rounded-2xl border bg-surface p-3 shadow-card transition-[border-color,box-shadow,transform,background-color] duration-150 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover",
                selected ? "border-primary/35 bg-primary-soft/25 ring-1 ring-primary/15" : "border-border"
              )}
            >
              <div className="relative overflow-hidden rounded-2xl border border-primary/10 bg-gradient-to-br from-primary-soft via-background to-surface">
                <div className="absolute left-3 top-3 z-10 grid size-7 place-items-center rounded-lg border border-border bg-surface/90 shadow-card backdrop-blur">
                  <input
                    type="checkbox"
                    aria-label={`选择目录 ${directory.name}`}
                    checked={selected}
                    onChange={(event) => onToggleDirectorySelected(directory, event.target.checked)}
                    className={checkboxClass}
                  />
                </div>

                <IconButton
                  size="sm"
                  variant="ghost"
                  label="更多操作"
                  onClick={(event) => openDirectoryActionsMenu(directory, event.currentTarget)}
                  className="absolute right-2 top-2 z-10 bg-surface/90 shadow-card backdrop-blur"
                >
                  <MoreVertical size={16} />
                </IconButton>

                <button
                  type="button"
                  onClick={() => onOpenDirectory(directory)}
                  className="grid aspect-[16/10] w-full place-items-center focus-visible:outline-none focus-visible:focus-ring"
                >
                  <span className="grid size-20 place-items-center rounded-3xl bg-primary-soft text-primary-strong shadow-card ring-1 ring-primary/15 transition-transform duration-150 group-hover:scale-105">
                    <Folder size={38} />
                  </span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => onOpenDirectory(directory)}
                className="mt-3 min-w-0 rounded-xl text-left focus-visible:outline-none focus-visible:focus-ring"
              >
                <span className="block h-10 overflow-hidden break-all text-[15px] font-semibold leading-5 text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" title={directory.name}>
                  {directory.name}
                </span>
              </button>

              <div className="mt-auto flex flex-col gap-1.5 pt-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary-strong">文件夹</span>
                  <span className="truncate text-xs text-muted">{directory.file_count} 个文件 · {formatBytes(directory.total_size)}</span>
                </div>
                <span className="truncate text-xs text-subtle">{formatDateTime(directory.created_at)}</span>
              </div>
            </article>
          );
        })}

        {files.map((file) => {
          const selected = selectedFileIds.has(file.id);
          const linkFile = hasFileLinkAccess(file) ? file : null;
          const kind = fileKind(file);
          const previewFromThumbnail = file.thumbnail_url ? () => onThumbnailPreview(file) : undefined;
          const canPreviewFile = canPreviewThroughAvailableAccess(file);
          const cacheEntry = cacheEntryMap.get(file.id) ?? null;

          return (
            <article
              key={file.id}
              onContextMenu={(event) => openFileContextMenu(event, file)}
              onDoubleClick={(event) => {
                if (isInteractiveTarget(event.target)) return;
                if (canPreviewFile) {
                  onPreview(file);
                } else {
                  onDetail(file);
                }
              }}
              className={cn(
                "group flex min-h-[17rem] min-w-0 flex-col overflow-hidden rounded-2xl border bg-surface p-3 shadow-card transition-[border-color,box-shadow,transform,background-color] duration-150 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover",
                selected ? "border-primary/35 bg-primary-soft/25 ring-1 ring-primary/15" : "border-border"
              )}
            >
              <div className="relative overflow-hidden rounded-2xl bg-background ring-1 ring-border">
                <div className="absolute left-3 top-3 z-10 grid size-7 place-items-center rounded-lg border border-border bg-surface/90 shadow-card backdrop-blur">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${file.file_name}`}
                    checked={selected}
                    onChange={(event) => onToggleFileSelected(file, event.target.checked)}
                    className={checkboxClass}
                  />
                </div>

                <IconButton
                  size="sm"
                  variant="ghost"
                  label="更多操作"
                  onClick={(event) => openFileActionsMenu(file, event.currentTarget)}
                  className="absolute right-2 top-2 z-10 bg-surface/90 shadow-card backdrop-blur"
                >
                  <MoreVertical size={16} />
                </IconButton>

                <FileVisual
                  mimeType={file.mime_type}
                  fileName={file.file_name}
                  url={linkFile ? file.file_path : undefined}
                  thumbnailUrl={file.thumbnail_url}
                  size="lg"
                  className="!h-auto !w-full aspect-[16/10] rounded-2xl border-0 ring-0"
                  onClick={previewFromThumbnail}
                  actionLabel={`预览缩略图 ${file.file_name}`}
                />
              </div>

              <button
                type="button"
                onClick={() => (canPreviewFile ? onPreview(file) : onDetail(file))}
                className="mt-3 min-w-0 rounded-xl text-left focus-visible:outline-none focus-visible:focus-ring"
              >
                <span className="block h-10 overflow-hidden break-all text-[15px] font-semibold leading-5 text-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" title={file.file_name}>
                  {file.file_name}
                </span>
              </button>

              <div className="mt-auto flex flex-col gap-1.5 pt-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted ring-1 ring-border">{kind.label}</span>
                  <span className="truncate text-xs text-muted">{formatBytes(file.size)}</span>
                </div>
                <div>
                  <FileCacheBadge entry={cacheEntry} />
                </div>
                <span className="truncate text-xs text-subtle">{formatDateTime(file.created_at)}</span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ContextMenuSurface({
  refNode,
  x,
  y,
  entries
}: {
  refNode: RefObject<HTMLDivElement>;
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}) {
  return (
    <div
      ref={refNode}
      role="menu"
      style={{ left: x, top: y }}
      className="fixed z-[70] w-56 overflow-hidden rounded-xl border border-border bg-surface/98 p-1.5 text-sm shadow-[0_18px_55px_rgba(15,23,42,0.22)] backdrop-blur-md animate-fade-in"
    >
      {entries.map((entry) => {
        if (entry.type === "separator") {
          return <div key={entry.key} className="my-1 h-px bg-border" role="separator" />;
        }

        return (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={entry.onSelect}
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-45",
              entry.tone === "danger"
                ? "text-danger hover:bg-danger-soft"
                : "text-foreground hover:bg-primary-soft hover:text-primary-strong"
            )}
          >
            <span className="grid size-5 shrink-0 place-items-center text-current/80">{entry.icon}</span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}
