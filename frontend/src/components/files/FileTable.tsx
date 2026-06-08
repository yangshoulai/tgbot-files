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
  Pencil,
  Trash2
} from "lucide-react";
import type { DirectoryItem, FileItem } from "../../api";
import {
  canUseAnyAcceleratedDownload,
  canPreviewThroughAvailableAccess,
  hasDirectDownloadAccess,
  hasFileLinkAccess,
  type DirectDownloadableFile
} from "../../lib/file-access";
import { fileKind, formatBytes, formatDateTime } from "../../utils";
import { FileVisual } from "../ui/FileVisual";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";

type FileSortKey = "name" | "size" | "created_at" | "type";
type SortDirection = "asc" | "desc";

interface FileTableProps {
  directories: DirectoryItem[];
  files: FileItem[];
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
  onToggleFileSelected: (file: FileItem, selected: boolean) => void;
  onToggleDirectorySelected: (directory: DirectoryItem, selected: boolean) => void;
  onTogglePage: (selected: boolean) => void;
  onDetail: (file: FileItem) => void;
  onEdit: (file: FileItem) => void;
  onMoveFile: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
  onThumbnailPreview: (file: FileItem) => void;
  onCopy: (file: FileItem) => void;
  onAcceleratedDownload: (file: FileItem) => void;
  onDelete: (file: FileItem) => void;
}

const checkboxClass =
  "block size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, [role='button']"));
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

function DownloadIconAction({
  file,
  directFile,
  canAccelerateDownload,
  onAcceleratedDownload
}: {
  file: FileItem;
  directFile: DirectDownloadableFile | null;
  canAccelerateDownload: boolean;
  onAcceleratedDownload: (file: FileItem) => void;
}) {
  if (canAccelerateDownload) {
    return (
      <IconButton
        variant="ghost"
        size="sm"
        label="加速下载"
        onClick={() => onAcceleratedDownload(file)}
      >
        <Download size={16} />
      </IconButton>
    );
  }

  if (!directFile) {
    return null;
  }

  return (
    <a
      href={directFile.download_url}
      title="下载"
      aria-label="下载"
      className="inline-grid size-8 shrink-0 place-items-center rounded-lg border border-transparent bg-transparent text-muted transition-colors duration-150 hover:bg-primary-soft hover:text-primary-strong"
    >
      <Download size={16} />
    </a>
  );
}

export function FileTable({
  directories,
  files,
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
  onToggleFileSelected,
  onToggleDirectorySelected,
  onTogglePage,
  onDetail,
  onEdit,
  onMoveFile,
  onPreview,
  onThumbnailPreview,
  onCopy,
  onAcceleratedDownload,
  onDelete
}: FileTableProps) {
  if (files.length === 0 && directories.length === 0) {
    return <EmptyState title="没有文件或子目录" description="试试调整搜索条件，或新建目录、上传文件。" />;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="divide-y divide-border sm:hidden">
        {directories.map((directory) => (
          <div key={directory.id} className="p-3">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                aria-label={`选择目录 ${directory.name}`}
                checked={selectedDirectoryIds.has(directory.id)}
                onChange={(event) => onToggleDirectorySelected(directory, event.target.checked)}
                className={`${checkboxClass} mt-3`}
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
            </div>
            <div className="mt-3 flex flex-wrap justify-end gap-1.5">
              <IconButton
                variant="ghost"
                size="sm"
                label="进入目录"
                onClick={() => onOpenDirectory(directory)}
              >
                <FolderOpen size={16} />
              </IconButton>
              <IconButton
                variant="ghost"
                size="sm"
                label="重命名目录"
                onClick={() => onRenameDirectory(directory)}
              >
                <Pencil size={16} />
              </IconButton>
              <IconButton
                variant="ghost"
                size="sm"
                label="移动目录"
                onClick={() => onMoveDirectory(directory)}
              >
                <FolderInput size={16} />
              </IconButton>
              <IconButton
                variant="danger"
                size="sm"
                label="删除目录"
                onClick={() => onDeleteDirectory(directory)}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
          </div>
        ))}
        {files.map((file) => {
          const linkFile = hasFileLinkAccess(file) ? file : null;
          const directFile = hasDirectDownloadAccess(file) ? file : null;
          const canAccelerateDownload = canUseAnyAcceleratedDownload(file);
          const canPreviewFile = canPreviewThroughAvailableAccess(file);
          const kind = fileKind(file);
          const mimeLabel = file.mime_type || "未知 MIME";
          const previewFromThumbnail = file.thumbnail_url ? () => onThumbnailPreview(file) : undefined;

          return (
            <div key={file.id} className="p-3">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={`选择 ${file.file_name}`}
                  checked={selectedFileIds.has(file.id)}
                  onChange={(event) => onToggleFileSelected(file, event.target.checked)}
                  className={`${checkboxClass} mt-3`}
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
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-1.5">
                <IconButton
                  variant="ghost"
                  size="sm"
                  label="详情"
                  onClick={() => onDetail(file)}
                >
                  <Info size={16} />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label="编辑文件信息"
                  onClick={() => onEdit(file)}
                >
                  <Pencil size={16} />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label="移动文件"
                  onClick={() => onMoveFile(file)}
                >
                  <FolderInput size={16} />
                </IconButton>
                {canPreviewFile ? (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label="预览"
                    onClick={() => onPreview(file)}
                  >
                    <Eye size={16} />
                  </IconButton>
                ) : null}
                {linkFile ? (
                  <>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="复制链接"
                      onClick={() => onCopy(file)}
                    >
                      <Copy size={16} />
                    </IconButton>
                  </>
                ) : null}
                <DownloadIconAction
                  file={file}
                  directFile={directFile}
                  canAccelerateDownload={canAccelerateDownload}
                  onAcceleratedDownload={onAcceleratedDownload}
                />
                <IconButton
                  variant="danger"
                  size="sm"
                  label="删除索引"
                  onClick={() => onDelete(file)}
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
      <div className="hidden overflow-x-hidden sm:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-background/60">
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
                className="hidden w-28 px-4 py-3 text-left font-medium text-muted lg:table-cell"
              />
              <SortHeader
                label="类型"
                sortId="type"
                activeSort={sortKey}
                direction={sortDirection}
                onSort={onSort}
                className="hidden w-28 px-4 py-3 text-left font-medium text-muted md:table-cell"
              />
              <SortHeader
                label="上传时间"
                sortId="created_at"
                activeSort={sortKey}
                direction={sortDirection}
                onSort={onSort}
                className="hidden w-40 px-4 py-3 text-left font-medium text-muted md:table-cell"
              />
              <th className="w-44 px-4 py-3 text-right font-medium text-muted md:w-56 lg:w-72">操作</th>
            </tr>
          </thead>
          <tbody>
            {directories.map((directory) => (
              <tr
                key={directory.id}
                onDoubleClick={(event) => {
                  if (isInteractiveTarget(event.target)) return;
                  onOpenDirectory(directory);
                }}
                className="cursor-pointer border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-primary-soft/25"
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
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                  文件夹
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                  {formatDateTime(directory.created_at)}
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="进入目录"
                      onClick={() => onOpenDirectory(directory)}
                    >
                      <FolderOpen size={16} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="重命名目录"
                      onClick={() => onRenameDirectory(directory)}
                    >
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="移动目录"
                      onClick={() => onMoveDirectory(directory)}
                    >
                      <FolderInput size={16} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      size="sm"
                      label="删除目录"
                      onClick={() => onDeleteDirectory(directory)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
            {files.map((file) => {
              const linkFile = hasFileLinkAccess(file) ? file : null;
              const directFile = hasDirectDownloadAccess(file) ? file : null;
              const canAccelerateDownload = canUseAnyAcceleratedDownload(file);
              const canPreviewFile = canPreviewThroughAvailableAccess(file);
              const kind = fileKind(file);
              const mimeLabel = file.mime_type || "未知 MIME";
              const previewFromThumbnail = file.thumbnail_url ? () => onThumbnailPreview(file) : undefined;

              return (
                <tr
                  key={file.id}
                  className="border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-primary-soft/25"
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
                      </div>
                    </div>
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-foreground lg:table-cell">
                    {formatBytes(file.size)}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                    {kind.label}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                    {formatDateTime(file.created_at)}
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label="详情"
                        onClick={() => onDetail(file)}
                      >
                        <Info size={16} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label="编辑文件信息"
                        onClick={() => onEdit(file)}
                      >
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label="移动文件"
                        onClick={() => onMoveFile(file)}
                      >
                        <FolderInput size={16} />
                      </IconButton>
                      {canPreviewFile ? (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          label="预览"
                          onClick={() => onPreview(file)}
                        >
                          <Eye size={16} />
                        </IconButton>
                      ) : null}
                      {linkFile ? (
                        <>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            label="复制链接"
                            onClick={() => onCopy(file)}
                          >
                            <Copy size={16} />
                          </IconButton>
                        </>
                      ) : null}
                      <DownloadIconAction
                        file={file}
                        directFile={directFile}
                        canAccelerateDownload={canAccelerateDownload}
                        onAcceleratedDownload={onAcceleratedDownload}
                      />
                      <IconButton
                        variant="danger"
                        size="sm"
                        label="删除索引"
                        onClick={() => onDelete(file)}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
