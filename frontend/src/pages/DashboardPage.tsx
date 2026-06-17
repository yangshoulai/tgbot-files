import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Database, FolderInput, FolderPlus, LayoutGrid, List, PanelLeftClose, PanelLeftOpen, Pencil, Play, RefreshCw, Search, Square, Trash2 } from "lucide-react";
import {
  ApiError,
  DirectoryItem,
  FileItem,
  HlsDownloadPart,
  SessionResponse,
  createDirectory,
  deleteEntries,
  deleteDirectory,
  deleteFile,
  getHlsDownloadPlan,
  listDirectories,
  listFiles,
  lookupFiles,
  moveDirectory,
  moveEntries,
  renameDirectory,
  updateFileMetadata
} from "../api";
import { fileKind, formatBytes, sumFileSize } from "../utils";
import { cn } from "../lib/cn";
import { useToast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import {
  buildFileCacheMetadata,
  buildFileCacheUrl,
  cacheFileManually,
  canCacheFile,
  clearAutomaticFileCache,
  clearFileCache,
  clearFilesCache,
  getFileCacheSummary,
  pauseFileCache,
  requestPersistentFileCacheStorage,
  resumeFileCache,
  terminateFileCache,
  type FileCacheEntry,
  type FileCacheSummary
} from "../lib/file-cache";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Textarea } from "../components/ui/Textarea";
import { Spinner } from "../components/ui/Spinner";
import { Segmented } from "../components/ui/Segmented";
import { FileVisual } from "../components/ui/FileVisual";
import { MetricsRow, Metric } from "../components/files/MetricsRow";
import { FileTable } from "../components/files/FileTable";
import { PreviewDialog } from "../components/files/PreviewDialog";
import { ThumbnailPreviewDialog } from "../components/files/ThumbnailPreviewDialog";
import { ThumbnailEditDialog } from "../components/files/ThumbnailEditDialog";
import { FileDetailDialog } from "../components/files/FileDetailDialog";
import { DirectoryTree } from "../components/files/DirectoryTree";
import {
  AcceleratedDownloadDialog,
  type AcceleratedChunkState,
  type AcceleratedDownloadState
} from "../components/files/AcceleratedDownloadDialog";
import {
  type MultipartDownloadFile,
  type NativeFileWritableStream,
  canUseAcceleratedDownload,
  createWritableFile,
  downloadAcceleratedPart,
  downloadMultipartChunk,
  extractSignedFileToken,
  expectedMultipartChunkSize,
  isAbortError,
  supportsNativeFileSave
} from "../lib/accelerated-download";
import { canUseHlsAcceleratedDownload, hasFileLinkAccess, type LinkAccessibleFile } from "../lib/file-access";
import { isVideoPreviewServiceWorkerControlling } from "../lib/video-preview-service-worker";

type FileTypeFilter = "all" | "image" | "video" | "text" | "pdf" | "archive" | "other";
type FileSortKey = "name" | "size" | "created_at" | "type";
type SortDirection = "asc" | "desc";
type FileLayoutMode = "list" | "grid";
type CacheOperation = { fileId: string; kind: "cache" | "pause" | "resume" | "terminate" | "clear" } | null;

const FILE_LAYOUT_STORAGE_KEY = "tgbot-files-layout-mode";

interface DashboardPageProps {
  session: SessionResponse;
  uploadVersion: number;
  copyText: (value: string) => void;
  onDirectoryChange: (path: string) => void;
  onUploadToDirectory: (path: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

const FILE_TYPE_OPTIONS: Array<{ value: FileTypeFilter; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "text", label: "文本" },
  { value: "pdf", label: "PDF" },
  { value: "archive", label: "压缩包" },
  { value: "other", label: "其他" }
];

function initialFileLayoutMode(): FileLayoutMode {
  if (typeof window === "undefined") {
    return "list";
  }

  try {
    return window.localStorage.getItem(FILE_LAYOUT_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

interface AcceleratedDownloadPartTask {
  index: number;
  size: number;
  offset: number;
  download: (
    signal: AbortSignal,
    onProgress: (downloadedBytes: number) => void
  ) => Promise<ArrayBuffer>;
}

interface HlsAcceleratedDownloadContext {
  fileId: string;
  fileName: string;
  directoryPath: string;
  mimeType: string;
  totalSize: number;
  chunkCount: number;
}

interface AcceleratedDownloadTask {
  fileId: string;
  fileName: string;
  writable: NativeFileWritableStream;
  concurrency: number;
  parts: AcceleratedDownloadPartTask[];
  queue: number[];
  running: Set<number>;
  completed: Set<number>;
  failed: Set<number>;
  controllers: Map<number, AbortController>;
  writeChain: Promise<void>;
  cancelled: boolean;
  finalized: boolean;
}

function parentDirectoryPath(path: string): string {
  if (path === "/") return "/";
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function directoryBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const segments = path.split("/").filter(Boolean);
  const breadcrumbs = [{ label: "/", path: "/" }];
  let current = "";

  for (const segment of segments) {
    current += `/${segment}`;
    breadcrumbs.push({ label: segment, path: current });
  }

  return breadcrumbs;
}

function compareFileItems(left: FileItem, right: FileItem, sortKey: FileSortKey, direction: SortDirection): number {
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

function compareDirectoryItems(
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

function FileListBusyOverlay({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center rounded-2xl bg-surface/75 px-4 backdrop-blur-[2px] animate-fade-in">
      <div
        role="status"
        aria-live="polite"
        className="flex min-w-48 flex-col items-center gap-3 rounded-2xl border border-border bg-background/90 px-5 py-4 text-center shadow-dialog"
      >
        <span className="grid size-11 place-items-center rounded-full bg-primary-soft text-primary-strong">
          <Spinner size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">{label}</p>
          <p className="text-xs text-muted">请稍候，列表会自动刷新</p>
        </div>
      </div>
    </div>
  );
}

function CacheManagerDialog({
  open,
  summary,
  operation,
  cacheFileIndex,
  onClose,
  onRefresh,
  onClearAutomatic,
  onPauseFile,
  onResumeFile,
  onTerminateFile,
  onClearFile
}: {
  open: boolean;
  summary: FileCacheSummary | null;
  operation: CacheOperation;
  cacheFileIndex: Map<string, FileItem>;
  onClose: () => void;
  onRefresh: () => void;
  onClearAutomatic: () => void;
  onPauseFile: (entry: FileCacheEntry) => void;
  onResumeFile: (entry: FileCacheEntry) => void;
  onTerminateFile: (entry: FileCacheEntry) => void;
  onClearFile: (entry: FileCacheEntry) => void;
}) {
  const entries = summary?.entries ?? [];
  const [actionEntry, setActionEntry] = useState<FileCacheEntry | null>(null);

  useEffect(() => {
    if (!open) {
      setActionEntry(null);
    }
  }, [open]);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="缓存管理"
        description={`已缓存 ${entries.length} 个文件，手动 ${formatBytes(summary?.manualBytes ?? 0)}，自动 ${formatBytes(summary?.autoBytes ?? 0)}`}
        size="full"
        className="h-[min(88dvh,56rem)] max-h-[88dvh] rounded-2xl border shadow-dialog sm:w-[min(96vw,118rem)] sm:max-w-[118rem]"
        bodyClassName="overflow-auto px-4 py-4 sm:px-5"
        footer={
          <>
            <Button variant="secondary" leadingIcon={<RefreshCw size={15} />} onClick={onRefresh}>
              刷新
            </Button>
            <Button variant="secondary" leadingIcon={<Trash2 size={15} />} disabled={(summary?.autoBytes ?? 0) <= 0} onClick={onClearAutomatic}>
              清理自动缓存
            </Button>
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </>
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-background">
          {entries.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-foreground">暂无缓存文件</p>
              <p className="mt-1 text-xs text-muted">预览文件会产生自动缓存，也可以在文件菜单中手动缓存。</p>
            </div>
          ) : (
            <div className="max-h-[min(70dvh,44rem)] overflow-y-auto overflow-x-hidden scroll-thin">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[12%]" />
                  <col className="w-[20%]" />
                  <col className="w-[13%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 border-b border-border bg-surface">
                  <tr className="text-left text-xs font-medium text-muted">
                    <th className="px-4 py-3">文件</th>
                    <th className="px-3 py-3">类型</th>
                    <th className="px-3 py-3">缓存进度</th>
                    <th className="px-3 py-3">空间</th>
                    <th className="px-3 py-3">状态</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const indexedFile = cacheFileIndex.get(entry.fileId);
                    const displayFileName = indexedFile?.file_name || entry.fileName;
                    const directoryPath = indexedFile?.directory_path || entry.directoryPath || "/";
                    const displayEntry = mergeCacheEntryWithIndexedFile(entry, indexedFile);
                    const entryOperation = operation?.fileId === entry.fileId ? operation.kind : null;
                    const progress = fileCacheProgressPercent(displayEntry);
                    const statusLabel = cacheEntryStatusLabel(displayEntry);
                    const actionDisabled = Boolean(entryOperation);

                    return (
                      <tr key={entry.fileId} className="border-b border-border last:border-b-0 hover:bg-primary-soft/20">
                        <td className="min-w-0 px-4 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <FileVisual
                              mimeType={indexedFile?.mime_type || entry.mimeType || "application/octet-stream"}
                              fileName={displayFileName}
                              url={cacheEntryVisualUrl(displayEntry, indexedFile)}
                              thumbnailUrl={indexedFile?.thumbnail_url}
                              size="sm"
                              className="size-12 rounded-lg bg-surface"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-foreground" title={displayFileName}>{displayFileName}</p>
                              <p className="mt-1 truncate text-xs text-subtle" title={directoryPath}>{directoryPath}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="w-fit rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted">
                              {entry.kind === "hls" ? "HLS" : entry.kind === "multipart" ? "分片" : "普通"}
                            </span>
                            <span className="truncate text-xs text-subtle" title={entry.mimeType || "未知"}>
                              {entry.mimeType || "未知"}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-2">
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span className="font-medium text-foreground">{progress}%</span>
                              <span className="truncate text-muted">{displayEntry.cachedChunks}/{displayEntry.chunkCount} 分片</span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-border">
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium text-foreground">{formatBytes(displayEntry.cachedBytes)}</span>
                            <span className="text-xs text-muted">共 {formatBytes(displayEntry.size)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-1.5">
                            <span className={cn(
                              "w-fit rounded-full px-2 py-0.5 text-xs font-medium",
                              entry.manualCacheStatus === "caching"
                                ? "bg-primary-soft text-primary-strong"
                                : entry.manualCacheStatus === "waiting"
                                  ? "bg-surface text-muted ring-1 ring-border"
                                : entry.manualCacheStatus === "paused"
                                  ? "bg-warning-soft text-warning"
                                  : entry.complete
                                    ? "bg-success-soft text-success"
                                    : "bg-surface text-muted ring-1 ring-border"
                            )}>
                              {statusLabel}
                            </span>
                            <span className="text-xs text-subtle">{entry.cacheSource === "manual" ? "手动缓存" : "自动缓存"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            {entry.manualCacheStatus === "caching" ? (
                              <CircularCacheAction
                                progress={progress}
                                label="停止或终止缓存"
                                disabled={actionDisabled}
                                onClick={() => setActionEntry(entry)}
                              />
                            ) : null}
                            {entry.manualCacheStatus === "waiting" ? (
                              <IconButton
                                size="sm"
                                variant="default"
                                label="停止或终止缓存"
                                disabled={actionDisabled}
                                onClick={() => setActionEntry(entry)}
                              >
                                <Square size={16} />
                              </IconButton>
                            ) : null}
                            {entry.manualCacheStatus === "paused" ? (
                              <IconButton
                                size="sm"
                                variant="default"
                                label={entryOperation === "resume" ? "继续中" : "继续缓存"}
                                disabled={actionDisabled}
                                onClick={() => onResumeFile(entry)}
                              >
                                <Play size={16} />
                              </IconButton>
                            ) : null}
                            {entry.manualCacheStatus ? (
                              <IconButton
                                size="sm"
                                variant="danger"
                                label={entryOperation === "terminate" ? "终止中" : "终止缓存"}
                                disabled={actionDisabled}
                                onClick={() => onTerminateFile(entry)}
                              >
                                <Trash2 size={16} />
                              </IconButton>
                            ) : (
                              <IconButton
                                size="sm"
                                variant="danger"
                                label={entryOperation === "clear" ? "清理中" : `清除缓存（${formatBytes(entry.cachedBytes)}）`}
                                disabled={actionDisabled || entry.cachedBytes <= 0}
                                onClick={() => onClearFile(entry)}
                              >
                                <Trash2 size={16} />
                              </IconButton>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(actionEntry)}
        onClose={() => setActionEntry(null)}
        title="处理正在进行的缓存"
        description="停止会保留已缓存分片，终止会停止并清除缓存。"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setActionEntry(null)}>
              取消
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<Square size={15} />}
              onClick={() => {
                if (!actionEntry) return;
                const entry = actionEntry;
                setActionEntry(null);
                onPauseFile(entry);
              }}
            >
              停止缓存
            </Button>
            <Button
              variant="danger"
              leadingIcon={<Trash2 size={15} />}
              onClick={() => {
                if (!actionEntry) return;
                const entry = actionEntry;
                setActionEntry(null);
                onTerminateFile(entry);
              }}
            >
              终止缓存
            </Button>
          </>
        }
      >
        {actionEntry ? (
          <div className="min-w-0 rounded-xl border border-border bg-background px-3 py-3">
            <p className="truncate text-sm font-semibold text-foreground">{actionEntry.fileName}</p>
            <p className="mt-1 truncate text-xs text-muted">{actionEntry.directoryPath || "/"}</p>
            <p className="mt-3 text-xs text-muted">
              当前进度 {fileCacheProgressPercent(actionEntry)}% · 已缓存 {formatBytes(actionEntry.cachedBytes)}
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function fileCacheProgressPercent(entry: FileCacheEntry): number {
  if (entry.complete) return 100;
  if (entry.size > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedBytes / entry.size) * 100)));
  }
  if (entry.chunkCount > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedChunks / entry.chunkCount) * 100)));
  }
  return 0;
}

function mergeCacheEntryWithIndexedFile(entry: FileCacheEntry, indexedFile: FileItem | undefined): FileCacheEntry {
  if (!indexedFile) return entry;

  const chunkCount = indexedFile.storage_backend === "hls_package"
    ? Math.max(1, indexedFile.hls_download?.part_count ?? indexedFile.hls_download?.segment_count ?? entry.chunkCount)
    : indexedFile.chunk_count && indexedFile.chunk_count > 0
      ? indexedFile.chunk_count
      : entry.chunkCount;
  const chunkSize = indexedFile.storage_backend === "hls_package"
    ? Math.max(1, Math.ceil(indexedFile.size / chunkCount))
    : indexedFile.chunk_size && indexedFile.chunk_size > 0
      ? indexedFile.chunk_size
      : entry.chunkSize;

  return {
    ...entry,
    fileName: indexedFile.file_name || entry.fileName,
    directoryPath: indexedFile.directory_path || entry.directoryPath || "/",
    mimeType: indexedFile.mime_type || entry.mimeType,
    size: indexedFile.size || entry.size,
    chunkSize,
    chunkCount,
    sourceUrl: hasFileLinkAccess(indexedFile) ? indexedFile.file_path : entry.sourceUrl
  };
}

function cacheEntryStatusLabel(entry: FileCacheEntry): string {
  if (entry.manualCacheStatus === "caching") return "缓存中";
  if (entry.manualCacheStatus === "waiting") return "等待中";
  if (entry.manualCacheStatus === "paused") return "已停止";
  if (entry.complete) return "已完成";
  return "部分缓存";
}

function cacheEntryVisualUrl(entry: FileCacheEntry, indexedFile: FileItem | undefined): string | undefined {
  if (indexedFile && hasFileLinkAccess(indexedFile)) {
    return indexedFile.url;
  }

  return entry.sourceUrl;
}

function CircularCacheAction({
  progress,
  disabled,
  label,
  onClick
}: {
  progress: number;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  const normalized = Math.max(0, Math.min(100, progress));

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="relative grid size-9 place-items-center rounded-full text-primary-strong transition-[opacity,transform] duration-150 hover:scale-105 focus-visible:outline-none focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 size-9 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--color-border)" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r="15.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray={`${normalized} 100`}
        />
      </svg>
      <span className="grid size-6 place-items-center rounded-full bg-surface shadow-card">
        <Square size={12} className="fill-current" />
      </span>
    </button>
  );
}

function DashboardPageComponent({ session, uploadVersion, copyText, onDirectoryChange, onUploadToDirectory }: DashboardPageProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const acceleratedDownloadTaskRef = useRef<AcceleratedDownloadTask | null>(null);

  const [files, setFiles] = useState<FileItem[]>([]);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [globalStats, setGlobalStats] = useState({ file_count: 0, total_size: 0 });
  const [currentDirPath, setCurrentDirPath] = useState("/");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [sortKey, setSortKey] = useState<FileSortKey>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [fileLayoutMode, setFileLayoutMode] = useState<FileLayoutMode>(initialFileLayoutMode);
  const [loading, setLoading] = useState(false);
  const [operationLabel, setOperationLabel] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [thumbnailPreviewFile, setThumbnailPreviewFile] = useState<FileItem | null>(null);
  const [thumbnailEditingFile, setThumbnailEditingFile] = useState<FileItem | null>(null);
  const [detailFile, setDetailFile] = useState<FileItem | null>(null);
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [editFileName, setEditFileName] = useState("");
  const [editRemark, setEditRemark] = useState("");
  const [savingFile, setSavingFile] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(() => new Set());
  const [selectedDirectoryIds, setSelectedDirectoryIds] = useState<Set<string>>(() => new Set());
  const [createDirOpen, setCreateDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [createDirParentPath, setCreateDirParentPath] = useState("/");
  const [creatingDir, setCreatingDir] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFileIds, setMoveFileIds] = useState<string[]>([]);
  const [moveDirectoryIds, setMoveDirectoryIds] = useState<string[]>([]);
  const [moveTargetPath, setMoveTargetPath] = useState("/");
  const [moveCreateNew, setMoveCreateNew] = useState(false);
  const [moveNewParentPath, setMoveNewParentPath] = useState("/");
  const [moveNewDirName, setMoveNewDirName] = useState("");
  const [movingFiles, setMovingFiles] = useState(false);
  const [movingDirectory, setMovingDirectory] = useState<DirectoryItem | null>(null);
  const [directoryMoveTargetPath, setDirectoryMoveTargetPath] = useState("/");
  const [movingDirectorySaving, setMovingDirectorySaving] = useState(false);
  const [renamingDirectory, setRenamingDirectory] = useState<DirectoryItem | null>(null);
  const [directoryRenameName, setDirectoryRenameName] = useState("");
  const [renamingDirectorySaving, setRenamingDirectorySaving] = useState(false);
  const [directoryPanelVisible, setDirectoryPanelVisible] = useState(true);
  const [acceleratedDownload, setAcceleratedDownload] = useState<AcceleratedDownloadState | null>(null);
  const [cacheSummary, setCacheSummary] = useState<FileCacheSummary | null>(null);
  const [cacheFiles, setCacheFiles] = useState<FileItem[]>([]);
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false);
  const [cacheOperation, setCacheOperation] = useState<CacheOperation>(null);
  const listBusyLabel = operationLabel ?? (loading ? "正在加载目录内容..." : undefined);
  const isListBusy = Boolean(listBusyLabel);

  const changeFileLayoutMode = useCallback((mode: FileLayoutMode) => {
    setFileLayoutMode(mode);
    try {
      window.localStorage.setItem(FILE_LAYOUT_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures; the current in-memory selection still applies.
    }
  }, []);

  const loadFiles = useCallback(
    async () => {
      setLoading(true);
      try {
        const response = await listFiles({
          q: query,
          dir: currentDirPath,
          type: typeFilter,
          all: true
        });
        setDirectories(response.directories);
        setFiles(response.files);
        setGlobalStats(response.global_stats);
      } catch (error) {
        toast.danger(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [currentDirPath, query, toast, typeFilter]
  );

  const loadDirectoryOptions = useCallback(async () => {
    try {
      const response = await listDirectories(true);
      setDirectoryOptions(response.directories);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }, [toast]);

  const refreshCacheSummary = useCallback(async () => {
    try {
      setCacheSummary(await getFileCacheSummary());
    } catch {
      setCacheSummary(null);
    }
  }, []);

  const refreshCacheFilesBySummary = useCallback(async (summary: FileCacheSummary | null) => {
    const entries = summary?.entries ?? [];
    if (entries.length === 0) return;

    const existingIds = new Set([...cacheFiles, ...files].map((file) => file.id));
    const missingIds = Array.from(new Set(entries.map((entry) => entry.fileId)))
      .filter((fileId) => fileId && !existingIds.has(fileId))
      .slice(0, 100);
    if (missingIds.length === 0) return;

    try {
      const response = await lookupFiles(missingIds);
      if (response.files.length === 0) return;
      setCacheFiles((current) => {
        const byId = new Map(current.map((file) => [file.id, file]));
        for (const file of response.files) {
          byId.set(file.id, file);
        }
        return Array.from(byId.values());
      });
    } catch {
      // The cache manager can still show service-worker metadata if lookup fails.
    }
  }, [cacheFiles, files]);

  const refreshCacheFileIndex = useCallback(async () => {
    try {
      const directoryResponse = await listDirectories(true);
      const directoryPaths = Array.from(new Set(["/", ...directoryResponse.directories.map((directory) => directory.path)]));
      const responses = await Promise.all(directoryPaths.map((dir) =>
        listFiles({
          q: "",
          dir,
          all: true,
          type: "all"
        })
      ));
      setCacheFiles(responses.flatMap((response) => response.files));
    } catch {
      setCacheFiles([]);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    void loadDirectoryOptions();
  }, [loadDirectoryOptions]);

  useEffect(() => {
    void refreshCacheSummary();
  }, [refreshCacheSummary]);

  useEffect(() => {
    if (cacheManagerOpen) {
      void refreshCacheSummary();
      void refreshCacheFileIndex();
    }
  }, [cacheManagerOpen, refreshCacheFileIndex, refreshCacheSummary]);

  useEffect(() => {
    if (cacheManagerOpen) {
      void refreshCacheFilesBySummary(cacheSummary);
    }
  }, [cacheManagerOpen, cacheSummary, refreshCacheFilesBySummary]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshCacheSummary();
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [refreshCacheSummary]);

  useEffect(() => {
    onDirectoryChange(currentDirPath);
  }, [currentDirPath, onDirectoryChange]);

  useEffect(() => {
    if (uploadVersion > 0) {
      void loadFiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadVersion]);

  useEffect(() => {
    const visibleIds = new Set(files.map((file) => file.id));
    setSelectedFileIds((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [files]);

  useEffect(() => {
    const visibleIds = new Set(directories.map((directory) => directory.id));
    setSelectedDirectoryIds((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [directories]);

  const metrics = useMemo<Metric[]>(() => {
    const recursiveFileCount = files.length + directories.reduce((total, directory) => total + directory.file_count, 0);
    const recursiveTotalSize = sumFileSize(files) + directories.reduce((total, directory) => total + directory.total_size, 0);

    return [
      {
        label: "目录文件",
        value: String(files.length),
        hint: `${currentDirPath} · 已加载全部文件`
      },
      {
        label: "当前目录占用",
        value: formatBytes(recursiveTotalSize),
        hint: `${directories.length} 个子目录 · ${recursiveFileCount} 个文件（含子目录）`
      },
      {
        label: "全局文件",
        value: String(globalStats.file_count),
        hint: `全局占用 ${formatBytes(globalStats.total_size)}`
      },
      {
        label: "存储后端",
        value:
          session.config.telegram_bot_token && session.config.telegram_storage_chat_id ? "已连接" : "未配置",
        hint: "Telegram Bot API"
      },
      {
        label: "缓存空间",
        value: formatBytes(cacheSummary?.totalBytes ?? 0),
        hint: `手动 ${formatBytes(cacheSummary?.manualBytes ?? 0)} · 自动 ${formatBytes(cacheSummary?.autoBytes ?? 0)}`
      }
    ];
  }, [cacheSummary?.autoBytes, cacheSummary?.manualBytes, cacheSummary?.totalBytes, currentDirPath, directories.length, files, globalStats, session.config]);

  async function onDelete(file: FileItem) {
    const ok = await confirm({
      title: "永久删除该文件索引？",
      description: (
        <>
          将从控制台永久移除 <span className="overflow-anywhere font-mono text-foreground">{file.file_name}</span>{" "}
          的索引和分片索引。Telegram 中的原始消息不会被删除；分片文件的已分发签名链接会失效。
        </>
      ),
      tone: "danger",
      confirmText: "删除"
    });
    if (!ok) return;

    setOperationLabel("正在删除文件索引...");
    try {
      await deleteFile(file.id);
      toast.success("索引已删除");
      if (previewFile?.id === file.id) setPreviewFile(null);
      if (thumbnailPreviewFile?.id === file.id) setThumbnailPreviewFile(null);
      if (detailFile?.id === file.id) setDetailFile(null);
      setSelectedFileIds((current) => {
        const next = new Set(current);
        next.delete(file.id);
        return next;
      });
      await clearCachesBestEffort([file.id]);
      await loadFiles();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setOperationLabel(null);
    }
  }

  async function onBulkDelete() {
    const targetFiles = files.filter((file) => selectedFileIds.has(file.id));
    const targetDirectories = directories.filter((directory) => selectedDirectoryIds.has(directory.id));
    const totalTargets = targetFiles.length + targetDirectories.length;
    if (totalTargets === 0) return;
    const cacheFileIds = [
      ...targetFiles.map((file) => file.id),
      ...await fileIdsForDirectoryTrees(targetDirectories).catch(() => [])
    ];

    const ok = await confirm({
      title: `删除选中的 ${totalTargets} 个项目？`,
      description: (
        <>
          将永久删除 {targetDirectories.length} 个目录及其子项、{targetFiles.length} 个文件索引。
          Telegram 中的原始消息不会被删除；分片文件的已分发签名链接会失效。
        </>
      ),
      tone: "danger",
      confirmText: "批量删除"
    });
    if (!ok) return;

    setOperationLabel("正在批量删除...");
    try {
      const result = await deleteEntries({
        file_ids: targetFiles.map((file) => file.id),
        directory_ids: targetDirectories.map((directory) => directory.id)
      });
      toast.success(`已删除 ${result.deleted_directories} 个目录、${result.deleted_files} 个文件索引`);
      if (previewFile && targetFiles.some((file) => file.id === previewFile.id)) setPreviewFile(null);
      if (thumbnailPreviewFile && targetFiles.some((file) => file.id === thumbnailPreviewFile.id)) setThumbnailPreviewFile(null);
      if (detailFile && targetFiles.some((file) => file.id === detailFile.id)) setDetailFile(null);
      setSelectedFileIds(new Set());
      setSelectedDirectoryIds(new Set());
      await clearCachesBestEffort(cacheFileIds);
      await loadFiles();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setOperationLabel(null);
    }
  }

  async function onCreateDirectory() {
    const name = newDirName.trim();
    if (!name) {
      toast.danger("请输入目录名称");
      return;
    }

    setCreatingDir(true);
    try {
      await createDirectory(createDirParentPath, name);
      toast.success("目录已创建");
      setCreateDirOpen(false);
      setNewDirName("");
      setCreateDirParentPath("/");
      await Promise.all([loadFiles(), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCreatingDir(false);
    }
  }

  async function onCacheFile(file: FileItem) {
    const metadata = buildFileCacheMetadata(file, session.video_preview_cache_bytes, "manual");
    if (!metadata || !canCacheFile(file)) {
      toast.danger("该文件缺少可缓存的访问链接");
      return;
    }

    setCacheOperation({ fileId: file.id, kind: "cache" });
    try {
      await requestPersistentFileCacheStorage();
      await cacheFileManually(metadata);
      await refreshCacheSummary();
      toast.success("文件已加入缓存队列");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onPauseFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "pause" });
    try {
      setCacheSummary(await pauseFileCache(file.id));
      toast.success("缓存已暂停");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onResumeFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "resume" });
    try {
      await requestPersistentFileCacheStorage();
      const metadata = buildFileCacheMetadata(file, Number.MAX_SAFE_INTEGER, "manual");
      setCacheSummary(await resumeFileCache(file.id, metadata ?? undefined));
      toast.success("缓存已继续");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onTerminateFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "terminate" });
    try {
      setCacheSummary(await terminateFileCache(file.id));
      toast.success("缓存已终止");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function resumeFileCacheById(fileId: string) {
    setCacheOperation({ fileId, kind: "resume" });
    try {
      await requestPersistentFileCacheStorage();
      const indexedFile = cacheFileIndex.get(fileId);
      const metadata = indexedFile ? buildFileCacheMetadata(indexedFile, Number.MAX_SAFE_INTEGER, "manual") : null;
      setCacheSummary(await resumeFileCache(fileId, metadata ?? undefined));
      toast.success("缓存已继续");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onClearFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "clear" });
    try {
      setCacheSummary(await clearFileCache(file.id));
      toast.success("缓存已清除");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onClearAutomaticCache() {
    try {
      setCacheSummary(await clearAutomaticFileCache());
      toast.success("自动缓存已清理");
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }

  async function onDeleteDirectory(directory: DirectoryItem) {
    const ok = await confirm({
      title: `删除目录 ${directory.name}？`,
      description: (
        <>
          将递归永久删除 <span className="font-mono text-foreground">{directory.path}</span>{" "}
          下的所有子目录、文件索引和分片索引。Telegram 中的原始消息不会被删除；分片文件的已分发签名链接会失效。
        </>
      ),
      tone: "danger",
      confirmText: "递归删除"
    });
    if (!ok) return;
    const cacheFileIds = await fileIdsForDirectoryTrees([directory]).catch(() => []);

    setOperationLabel("正在删除目录...");
    try {
      const result = await deleteDirectory(directory.id);
      toast.success(`已删除 ${result.deleted_directories} 个目录、${result.deleted_files} 个文件索引`);
      setSelectedDirectoryIds((current) => {
        const next = new Set(current);
        next.delete(directory.id);
        return next;
      });
      await clearCachesBestEffort(cacheFileIds);
      await Promise.all([loadFiles(), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setOperationLabel(null);
    }
  }

  async function fileIdsForDirectoryTrees(targetDirectories: DirectoryItem[]): Promise<string[]> {
    if (targetDirectories.length === 0) return [];

    const paths = new Set<string>();
    for (const directory of targetDirectories) {
      paths.add(directory.path);
      for (const option of directoryOptions) {
        if (option.path.startsWith(`${directory.path}/`)) {
          paths.add(option.path);
        }
      }
    }

    const ids = new Set<string>();
    for (const path of paths) {
      const response = await listFiles({ q: "", dir: path, all: true, type: "all" });
      for (const file of response.files) {
        ids.add(file.id);
      }
    }

    return Array.from(ids);
  }

  async function clearCachesBestEffort(fileIds: string[]) {
    const uniqueIds = Array.from(new Set(fileIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;

    try {
      setCacheSummary(await clearFilesCache(uniqueIds));
    } catch {
      // 删除文件不应被浏览器本地缓存清理失败阻塞。
    }
  }

  function openRenameDirectoryDialog(directory: DirectoryItem) {
    setRenamingDirectory(directory);
    setDirectoryRenameName(directory.name);
  }

  async function onRenameDirectory() {
    if (!renamingDirectory) return;

    const name = directoryRenameName.trim();
    if (!name) {
      toast.danger("请输入目录名称");
      return;
    }

    setRenamingDirectorySaving(true);
    try {
      const result = await renameDirectory(renamingDirectory.id, name);
      toast.success(`已重命名 ${result.renamed_directories} 个目录、更新 ${result.updated_files} 个文件索引`);
      setRenamingDirectory(null);
      await Promise.all([loadFiles(), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setRenamingDirectorySaving(false);
    }
  }

  function openMoveDirectoryDialog(directory: DirectoryItem) {
    const currentParent = parentDirectoryPath(directory.path);
    const firstOtherTarget = directoryOptions.find((option) =>
      option.path !== directory.path &&
      !option.path.startsWith(`${directory.path}/`) &&
      option.path !== currentParent
    );
    setMovingDirectory(directory);
    setDirectoryMoveTargetPath(currentParent === "/" && firstOtherTarget ? firstOtherTarget.path : "/");
    void loadDirectoryOptions();
  }

  async function onMoveDirectory() {
    if (!movingDirectory) return;

    setMovingDirectorySaving(true);
    setOperationLabel("正在移动目录...");
    try {
      const result = await moveDirectory(movingDirectory.id, directoryMoveTargetPath);
      toast.success(`已移动 ${result.moved_directories} 个目录、${result.moved_files} 个文件索引到 ${result.directory.path}`);
      setMovingDirectory(null);
      setSelectedDirectoryIds((current) => {
        const next = new Set(current);
        next.delete(result.directory.id);
        return next;
      });
      await Promise.all([loadFiles(), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMovingDirectorySaving(false);
      setOperationLabel(null);
    }
  }

  function openMoveDialog(file?: FileItem) {
    const fileIds = file ? [file.id] : files.filter((item) => selectedFileIds.has(item.id)).map((item) => item.id);
    const directoryIds = file ? [] : directories.filter((item) => selectedDirectoryIds.has(item.id)).map((item) => item.id);
    if (fileIds.length + directoryIds.length === 0) return;
    setMoveFileIds(fileIds);
    setMoveDirectoryIds(directoryIds);
    setMoveTargetPath(currentDirPath);
    setMoveNewParentPath(currentDirPath);
    setMoveNewDirName("");
    setMoveCreateNew(false);
    setMoveOpen(true);
    void loadDirectoryOptions();
  }

  function openEditDialog(file: FileItem) {
    setEditingFile(file);
    setEditFileName(file.file_name);
    setEditRemark(file.remark ?? "");
  }

  async function onSaveFileMetadata() {
    if (!editingFile) return;

    const nextName = editFileName.trim();
    if (!nextName) {
      toast.danger("请输入文件名");
      return;
    }

    setSavingFile(true);
    try {
      const response = await updateFileMetadata(editingFile.id, {
        file_name: nextName,
        remark: editRemark
      });
      const updated = response.file;
      setFiles((current) => current.map((file) => (file.id === updated.id ? updated : file)));
      if (previewFile?.id === updated.id) setPreviewFile(updated);
      if (thumbnailPreviewFile?.id === updated.id) setThumbnailPreviewFile(updated.thumbnail_url ? updated : null);
      if (detailFile?.id === updated.id) setDetailFile(updated);
      setEditingFile(null);
      toast.success(updated.file_path !== editingFile.file_path ? "文件信息已保存，链接已更新" : "文件信息已保存");
      await loadFiles();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSavingFile(false);
    }
  }

  function handleThumbnailSaved(updated: FileItem) {
    setFiles((current) => current.map((file) => (file.id === updated.id ? updated : file)));
    if (previewFile?.id === updated.id) setPreviewFile(updated);
    if (thumbnailPreviewFile?.id === updated.id) setThumbnailPreviewFile(updated.thumbnail_url ? updated : null);
    if (thumbnailEditingFile?.id === updated.id) setThumbnailEditingFile(updated);
    if (detailFile?.id === updated.id) setDetailFile(updated);
    if (editingFile?.id === updated.id) setEditingFile(updated);
  }

  async function onMoveSelected() {
    if (moveFileIds.length + moveDirectoryIds.length === 0) return;

    const newName = moveNewDirName.trim();
    if (moveCreateNew && !newName) {
      toast.danger("请输入新目录名称");
      return;
    }

    setMovingFiles(true);
    setOperationLabel("正在移动项目...");
    try {
      const result = await moveEntries(
        moveCreateNew
          ? {
              file_ids: moveFileIds,
              directory_ids: moveDirectoryIds,
              new_directory_parent_path: moveNewParentPath,
              new_directory_name: newName
            }
          : {
              file_ids: moveFileIds,
              directory_ids: moveDirectoryIds,
              directory_path: moveTargetPath
            }
      );
      toast.success(`已移动 ${result.moved_directories} 个目录、${result.moved_files} 个文件索引到 ${result.directory_path}`);
      setMoveOpen(false);
      setMoveFileIds([]);
      setMoveDirectoryIds([]);
      setSelectedFileIds(new Set());
      setSelectedDirectoryIds(new Set());
      await Promise.all([loadFiles(), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMovingFiles(false);
      setOperationLabel(null);
    }
  }

  function goToDirectory(path: string) {
    if (isListBusy || path === currentDirPath) return;
    setCurrentDirPath(path);
    setSelectedFileIds(new Set());
    setSelectedDirectoryIds(new Set());
  }

  function onCopy(file: FileItem) {
    if (!hasFileLinkAccess(file)) {
      toast.info("该文件暂无可复制链接");
      return;
    }

    copyText(file.url);
  }

  async function onAcceleratedDownload(file: FileItem) {
    if (acceleratedDownloadTaskRef.current) {
      toast.info("已有加速下载任务进行中，请先完成或取消当前任务");
      return;
    }

    const isMultipart = canUseAcceleratedDownload(file);
    const isHls = canUseHlsAcceleratedDownload(file);
    const isHlsPackage = file.storage_backend === "hls_package";
    const linkFile = hasFileLinkAccess(file) ? file : null;

    if (isHlsPackage && !isHls) {
      toast.info("该 HLS 文件暂不支持加速下载");
      return;
    }

    if (!isMultipart && !isHls && !linkFile) {
      toast.info("该文件暂无可下载链接");
      return;
    }

    if (!supportsNativeFileSave()) {
      toast.info("当前浏览器不支持加速下载，请使用支持本地文件保存的浏览器");
      return;
    }

    let fileName = file.file_name;
    let totalBytes = file.size;
    let parts: AcceleratedDownloadPartTask[];
    const downloadConcurrency = session.upload_concurrency;

    try {
      if (isMultipart) {
        const token = extractSignedFileToken(file.file_path) || (linkFile ? extractSignedFileToken(linkFile.url) : null);
        if (!token) {
          if (!linkFile) {
            toast.info("无法解析分片下载 token，且该文件暂无可下载链接");
            return;
          }
          parts = createSingleFileAcceleratedParts(linkFile);
        } else {
          parts = createMultipartAcceleratedParts(file, token);
        }
      } else if (isHls) {
        const plan = (await getHlsDownloadPlan(file.id)).hls_download;
        fileName = plan.file_name;
        totalBytes = plan.total_size;
        parts = createHlsAcceleratedParts(plan.parts, {
          fileId: file.id,
          fileName: file.file_name,
          directoryPath: file.directory_path || "/",
          mimeType: file.mime_type || "application/vnd.apple.mpegurl",
          totalSize: plan.total_size,
          chunkCount: plan.part_count
        });
      } else {
        if (!linkFile) {
          toast.info("该文件暂无可下载链接");
          return;
        }
        parts = createSingleFileAcceleratedParts(linkFile);
      }
    } catch (error) {
      toast.danger(errorMessage(error));
      return;
    }

    setAcceleratedDownload({
      fileId: file.id,
      fileName,
      status: "preparing",
      concurrency: downloadConcurrency,
      totalBytes,
      chunks: createInitialAcceleratedChunks(parts)
    });

    let writable: Awaited<ReturnType<typeof createWritableFile>>;
    try {
      writable = await createWritableFile(fileName);
    } catch (error) {
      setAcceleratedDownload(null);
      if (!isAbortError(error)) {
        toast.danger(errorMessage(error));
      }
      return;
    }

    const task: AcceleratedDownloadTask = {
      fileId: file.id,
      fileName,
      writable,
      concurrency: downloadConcurrency,
      parts,
      queue: parts.map((part) => part.index),
      running: new Set(),
      completed: new Set(),
      failed: new Set(),
      controllers: new Map(),
      writeChain: Promise.resolve(),
      cancelled: false,
      finalized: false
    };

    acceleratedDownloadTaskRef.current = task;
    setAcceleratedDownload((current) =>
      current?.fileId === task.fileId
        ? { ...current, status: "downloading" }
        : current
    );
    startAcceleratedQueuedChunks(task);
  }

  function startAcceleratedQueuedChunks(task: AcceleratedDownloadTask) {
    if (task.cancelled || task.finalized) {
      return;
    }

    while (task.running.size < task.concurrency && task.queue.length > 0) {
      const chunkIndex = task.queue.shift();
      if (chunkIndex === undefined || task.running.has(chunkIndex) || task.completed.has(chunkIndex)) {
        continue;
      }

      task.failed.delete(chunkIndex);
      task.running.add(chunkIndex);
      void runAcceleratedChunk(task, chunkIndex);
    }

    updateAcceleratedOverallStatus(task);
  }

  async function runAcceleratedChunk(task: AcceleratedDownloadTask, chunkIndex: number) {
    const part = task.parts[chunkIndex];
    if (!part) {
      task.failed.add(chunkIndex);
      updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
        ...chunk,
        status: "failed",
        errorMessage: "下载 part 不存在"
      }));
      return;
    }

    const controller = new AbortController();
    task.controllers.set(chunkIndex, controller);
    updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
      ...chunk,
      status: "downloading",
      downloadedBytes: 0,
      attempts: chunk.attempts + 1,
      errorMessage: undefined
    }));

    try {
      const bytes = await part.download(controller.signal, (downloadedBytes) => {
        updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) =>
          chunk.downloadedBytes === downloadedBytes
            ? chunk
            : {
                ...chunk,
                downloadedBytes
              }
        );
      });

      if (task.cancelled) {
        return;
      }

      await writeAcceleratedChunk(task, chunkIndex, bytes);

      if (task.cancelled) {
        return;
      }

      task.failed.delete(chunkIndex);
      task.completed.add(chunkIndex);
      updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
        ...chunk,
        status: "completed",
        downloadedBytes: chunk.size,
        errorMessage: undefined
      }));
      await finalizeAcceleratedDownloadIfReady(task);
    } catch (error) {
      if (!task.cancelled) {
        task.failed.add(chunkIndex);
        updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
          ...chunk,
          status: "failed",
          errorMessage: errorMessage(error)
        }));
      }
    } finally {
      task.controllers.delete(chunkIndex);
      task.running.delete(chunkIndex);
      if (!task.cancelled && !task.finalized) {
        startAcceleratedQueuedChunks(task);
      }
    }
  }

  function writeAcceleratedChunk(
    task: AcceleratedDownloadTask,
    chunkIndex: number,
    bytes: ArrayBuffer
  ): Promise<void> {
    const part = task.parts[chunkIndex];
    if (!part) {
      return Promise.reject(new Error("下载 part 不存在"));
    }

    const writeOperation = task.writeChain.then(() =>
      task.writable.write({
        type: "write",
        position: part.offset,
        data: bytes
      })
    );

    task.writeChain = writeOperation.catch(() => undefined);
    return writeOperation;
  }

  async function finalizeAcceleratedDownloadIfReady(task: AcceleratedDownloadTask) {
    if (task.finalized || task.cancelled || task.completed.size !== task.parts.length) {
      return;
    }

    task.finalized = true;
    setAcceleratedDownload((current) =>
      current?.fileId === task.fileId ? { ...current, status: "finalizing" } : current
    );

    try {
      await task.writeChain;
      await task.writable.close();
      if (acceleratedDownloadTaskRef.current === task) {
        acceleratedDownloadTaskRef.current = null;
      }
      setAcceleratedDownload((current) =>
        current?.fileId === task.fileId ? { ...current, status: "completed" } : current
      );
      toast.success("加速下载完成");
    } catch (error) {
      if (acceleratedDownloadTaskRef.current === task) {
        acceleratedDownloadTaskRef.current = null;
      }
      setAcceleratedDownload((current) =>
        current?.fileId === task.fileId
          ? {
              ...current,
              status: "error",
              errorMessage: errorMessage(error)
            }
          : current
      );
      toast.danger(errorMessage(error));
    }
  }

  function retryAcceleratedChunk(chunkIndex: number) {
    const task = acceleratedDownloadTaskRef.current;
    if (!task || task.cancelled || task.finalized || task.running.has(chunkIndex) || task.completed.has(chunkIndex)) {
      return;
    }

    task.failed.delete(chunkIndex);
    if (!task.queue.includes(chunkIndex)) {
      task.queue.unshift(chunkIndex);
    }
    updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
      ...chunk,
      status: "queued",
      downloadedBytes: 0,
      errorMessage: undefined
    }));
    startAcceleratedQueuedChunks(task);
  }

  function retryFailedAcceleratedChunks() {
    const task = acceleratedDownloadTaskRef.current;
    if (!task || task.cancelled || task.finalized) {
      return;
    }

    const failedChunks = Array.from(task.failed).sort((left, right) => left - right);
    if (failedChunks.length === 0) {
      return;
    }

    for (const chunkIndex of failedChunks) {
      if (task.running.has(chunkIndex) || task.completed.has(chunkIndex) || task.queue.includes(chunkIndex)) {
        continue;
      }
      task.queue.push(chunkIndex);
      updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
        ...chunk,
        status: "queued",
        downloadedBytes: 0,
        errorMessage: undefined
      }));
    }
    task.failed.clear();
    startAcceleratedQueuedChunks(task);
  }

  function cancelAcceleratedDownload() {
    const task = acceleratedDownloadTaskRef.current;
    if (!task) {
      setAcceleratedDownload((current) =>
        current && current.status === "preparing" ? { ...current, status: "cancelled" } : current
      );
      return;
    }

    task.cancelled = true;
    task.queue = [];
    for (const controller of task.controllers.values()) {
      controller.abort();
    }
    task.controllers.clear();
    task.running.clear();
    acceleratedDownloadTaskRef.current = null;
    void task.writeChain
      .catch(() => undefined)
      .finally(async () => {
        try {
          await task.writable.abort?.("cancelled");
        } catch {
          // 忽略取消写入时的浏览器实现差异。
        }
      });
    setAcceleratedDownload((current) =>
      current?.fileId === task.fileId ? { ...current, status: "cancelled" } : current
    );
    toast.info("下载已取消");
  }

  function updateAcceleratedChunk(
    fileId: string,
    chunkIndex: number,
    updater: (chunk: AcceleratedChunkState) => AcceleratedChunkState
  ) {
    setAcceleratedDownload((current) => {
      if (!current || current.fileId !== fileId) {
        return current;
      }

      let changed = false;
      const chunks = current.chunks.map((chunk) => {
        if (chunk.index !== chunkIndex) {
          return chunk;
        }

        const nextChunk = updater(chunk);
        if (nextChunk !== chunk) {
          changed = true;
        }
        return nextChunk;
      });

      return changed ? { ...current, chunks } : current;
    });
  }

  function updateAcceleratedOverallStatus(task: AcceleratedDownloadTask) {
    setAcceleratedDownload((current) => {
      if (!current || current.fileId !== task.fileId || task.finalized || task.cancelled) {
        return current;
      }

      const nextStatus = task.running.size > 0 || task.queue.length > 0
        ? "downloading"
        : task.failed.size > 0
          ? "partial_failed"
          : current.status;

      if (nextStatus !== current.status) {
        return { ...current, status: nextStatus };
      }

      return current;
    });
  }

  function createMultipartAcceleratedParts(file: MultipartDownloadFile, token: string): AcceleratedDownloadPartTask[] {
    const cacheUrl = isVideoPreviewServiceWorkerControlling()
      ? buildFileCacheUrl(buildFileCacheMetadata(file, session.video_preview_cache_bytes, "auto"))
      : null;

    return Array.from({ length: file.chunk_count }, (_, index) => ({
      index,
      size: expectedMultipartChunkSize(file, index),
      offset: index * file.chunk_size,
      download: (signal, onProgress) =>
        cacheUrl
          ? downloadAcceleratedPart({
              url: cacheUrl,
              expectedSize: expectedMultipartChunkSize(file, index),
              label: `分片 ${index + 1}`,
              signal,
              headers: { Range: `bytes=${index * file.chunk_size}-${index * file.chunk_size + expectedMultipartChunkSize(file, index) - 1}` },
              onProgress: (progress) => onProgress(progress.downloadedBytes)
            })
          : downloadMultipartChunk({
              file,
              token,
              chunkIndex: index,
              signal,
              onProgress: (progress) => onProgress(progress.downloadedBytes)
            })
    }));
  }

  function createSingleFileAcceleratedParts(file: LinkAccessibleFile): AcceleratedDownloadPartTask[] {
    const cacheUrl = isVideoPreviewServiceWorkerControlling()
      ? buildFileCacheUrl(buildFileCacheMetadata(file, session.video_preview_cache_bytes, "auto"))
      : null;

    return [{
      index: 0,
      size: file.size,
      offset: 0,
      download: (signal, onProgress) =>
        downloadAcceleratedPart({
          url: cacheUrl || file.url,
          expectedSize: file.size,
          label: "文件",
          signal,
          onProgress: (progress) => onProgress(progress.downloadedBytes)
        })
    }];
  }

  function createHlsAcceleratedParts(parts: HlsDownloadPart[], context: HlsAcceleratedDownloadContext): AcceleratedDownloadPartTask[] {
    const fullSegments = new Map<number, { offset: number; size: number; url: string }>();
    for (const part of parts) {
      if (part.kind === "segment" && part.segment_index !== null && part.chunk_index === null) {
        const path = sameOriginPath(part.url);
        if (path) {
          fullSegments.set(part.segment_index, {
            offset: part.offset,
            size: part.size,
            url: path
          });
        }
      }
    }

    return parts.map((part) => ({
      index: part.index,
      size: part.size,
      offset: part.offset,
      download: (signal, onProgress) =>
        downloadAcceleratedPart({
          url: hlsAcceleratedPartCacheUrl(part, context, fullSegments) || part.url,
          expectedSize: part.size,
          label: part.kind === "init" || part.segment_index === null
            ? "HLS 初始化片段"
            : part.chunk_index === null
              ? `HLS 片段 ${part.segment_index + 1}`
              : `HLS 片段 ${part.segment_index + 1} / 分片 ${part.chunk_index + 1}`,
          signal,
          headers: hlsAcceleratedPartCacheHeaders(part, fullSegments),
          onProgress: (progress) => onProgress(progress.downloadedBytes)
        })
    }));
  }

  function hlsAcceleratedPartCacheUrl(part: HlsDownloadPart, context: HlsAcceleratedDownloadContext, fullSegments: Map<number, { offset: number; size: number; url: string }>): string | null {
    if (!isVideoPreviewServiceWorkerControlling()) {
      return null;
    }

    const fullSegment = part.kind === "segment" && part.chunk_index !== null && part.segment_index !== null
      ? fullSegments.get(part.segment_index)
      : null;
    if (part.kind === "segment" && part.chunk_index !== null && !fullSegment) {
      return null;
    }

    const sourceUrl = sameOriginPath(part.url);
    if (!sourceUrl) {
      return null;
    }

    const partKind = part.kind === "init" || part.segment_index === null ? "init" : "segment";
    const partIndex = partKind === "init" ? 0 : part.segment_index;
    if (partIndex === null || !Number.isSafeInteger(partIndex) || partIndex < 0) {
      return null;
    }

    const params = new URLSearchParams({
      source: sourceUrl,
      cache_max: String(session.video_preview_cache_bytes),
      prefetch_concurrency: String(Math.max(1, Math.min(session.upload_concurrency, 32))),
      file_name: context.fileName,
      directory_path: context.directoryPath,
      mime: context.mimeType,
      size: String(context.totalSize),
      chunk_size: String(part.size),
      chunk_count: String(context.chunkCount),
      cache_source: "auto"
    });

    if (fullSegment) {
      params.set("full_source", fullSegment.url);
      params.set("full_size", String(fullSegment.size));
    }

    return `/__video-preview/hls-part/${encodeURIComponent(context.fileId)}/${partKind}/${partIndex}?${params.toString()}`;
  }

  function hlsAcceleratedPartCacheHeaders(part: HlsDownloadPart, fullSegments: Map<number, { offset: number; size: number; url: string }>): HeadersInit | undefined {
    const fullSegment = part.kind === "segment" && part.chunk_index !== null && part.segment_index !== null
      ? fullSegments.get(part.segment_index)
      : null;
    if (!fullSegment) {
      return undefined;
    }

    const start = part.offset - fullSegment.offset;
    return { Range: `bytes=${start}-${start + part.size - 1}` };
  }

  function sameOriginPath(url: string): string | null {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) {
        return null;
      }
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  function createInitialAcceleratedChunks(parts: AcceleratedDownloadPartTask[]): AcceleratedChunkState[] {
    return parts.map((part) => ({
      index: part.index,
      size: part.size,
      downloadedBytes: 0,
      status: "queued",
      attempts: 0
    }));
  }

  function toggleFileSelected(file: FileItem, selected: boolean) {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(file.id);
      } else {
        next.delete(file.id);
      }
      return next;
    });
  }

  function toggleDirectorySelected(directory: DirectoryItem, selected: boolean) {
    setSelectedDirectoryIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(directory.id);
      } else {
        next.delete(directory.id);
      }
      return next;
    });
  }

  const sortedFiles = useMemo(
    () => [...files].sort((left, right) => compareFileItems(left, right, sortKey, sortDirection)),
    [files, sortDirection, sortKey]
  );
  const sortedDirectories = useMemo(
    () => [...directories].sort((left, right) => compareDirectoryItems(left, right, sortKey, sortDirection)),
    [directories, sortDirection, sortKey]
  );
  const cacheFileIndex = useMemo(
    () => new Map([...cacheFiles, ...files].map((file) => [file.id, file])),
    [cacheFiles, files]
  );

  function changeSort(nextKey: FileSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(nextKey);
    setSortDirection(nextKey === "created_at" ? "desc" : "asc");
  }

  function togglePage(selected: boolean) {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      for (const file of sortedFiles) {
        if (selected) next.add(file.id);
        else next.delete(file.id);
      }
      return next;
    });
    setSelectedDirectoryIds((current) => {
      const next = new Set(current);
      for (const directory of sortedDirectories) {
        if (selected) next.add(directory.id);
        else next.delete(directory.id);
      }
      return next;
    });
  }

  const visibleEntryCount = sortedFiles.length + sortedDirectories.length;
  const selectedFileCount = files.filter((file) => selectedFileIds.has(file.id)).length;
  const selectedDirectoryCount = directories.filter((directory) => selectedDirectoryIds.has(directory.id)).length;
  const selectedCount = selectedFileCount + selectedDirectoryCount;
  const allPageSelected = visibleEntryCount > 0 &&
    sortedFiles.every((file) => selectedFileIds.has(file.id)) &&
    sortedDirectories.every((directory) => selectedDirectoryIds.has(directory.id));
  const directoryMoveTargets = useMemo(() => {
    if (!movingDirectory) {
      return directoryOptions;
    }

    return directoryOptions.filter((directory) =>
      directory.id !== movingDirectory.id &&
      !directory.path.startsWith(`${movingDirectory.path}/`)
    );
  }, [directoryOptions, movingDirectory]);
  const bulkMoveTargets = useMemo(() => {
    const selectedDirectories = directories.filter((directory) => selectedDirectoryIds.has(directory.id));
    if (selectedDirectories.length === 0) {
      return directoryOptions;
    }

    return directoryOptions.filter((directory) =>
      selectedDirectories.every((selectedDirectory) =>
        directory.id !== selectedDirectory.id &&
        !directory.path.startsWith(`${selectedDirectory.path}/`)
      )
    );
  }, [directories, directoryOptions, selectedDirectoryIds]);

  return (
    <div className="flex flex-col gap-5">
      <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card">
        <div className="relative px-5 py-6 sm:px-7 lg:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_0%,rgba(16,185,129,0.18),transparent_34%),radial-gradient(circle_at_88%_12%,rgba(56,189,248,0.12),transparent_30%),linear-gradient(135deg,rgba(236,253,245,0.82),rgba(255,255,255,0)_48%)]" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-4xl">
              <p className="inline-flex items-center rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-xs font-medium uppercase tracking-wide text-primary-strong">
                控制台
              </p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">文件管理</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                上传、检索、预览与分发存储在 Telegram 中的文件。当前目录{" "}
                <span className="font-mono text-foreground">{currentDirPath}</span>
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
                <span className="rounded-full border border-border bg-surface/80 px-3 py-1 text-muted">
                  全站 {globalStats.file_count} 个文件
                </span>
                <span className="rounded-full border border-border bg-surface/80 px-3 py-1 text-muted">
                  总容量 {formatBytes(globalStats.total_size)}
                </span>
                <span className="rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-primary-strong">
                  {directoryOptions.length} 个目录
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <MetricsRow metrics={metrics} />

      <div className={directoryPanelVisible ? "grid items-start gap-4 xl:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]" : "grid items-start gap-4"}>
        {directoryPanelVisible ? (
          <DirectoryTree
            ariaLabel="目录导航"
            value={currentDirPath}
            directories={directoryOptions}
            disabled={isListBusy}
            onChange={goToDirectory}
            variant="sidebar"
            title="目录导航"
            summary={`${directoryOptions.length} 个目录 · 点击节点进入目标目录`}
            showExpandControls
            onCreateDirectory={(parentPath) => {
              setCreateDirParentPath(parentPath);
              setCreateDirOpen(true);
            }}
            onRenameDirectory={openRenameDirectoryDialog}
            onMoveDirectory={openMoveDirectoryDialog}
            onDeleteDirectory={(directory) => void onDeleteDirectory(directory)}
            onUploadToDirectory={onUploadToDirectory}
            className="xl:sticky xl:top-4"
            treeClassName="max-h-none overflow-visible"
            headerAction={(
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<PanelLeftClose size={15} />}
                onClick={() => setDirectoryPanelVisible(false)}
                className="h-8 px-2.5"
              >
                隐藏
              </Button>
            )}
          />
        ) : null}

        <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-card sm:p-4">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/60 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {!directoryPanelVisible ? (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<PanelLeftOpen size={15} />}
                  onClick={() => setDirectoryPanelVisible(true)}
                  className="mr-1"
                >
                  显示目录树
                </Button>
              ) : null}
              {directoryBreadcrumbs(currentDirPath).map((item, index, array) => (
                <div key={item.path} className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={isListBusy}
                    onClick={() => goToDirectory(item.path)}
                    title={item.path}
                    className="max-w-[13rem] truncate rounded-md px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-primary-soft hover:text-primary-strong focus-visible:outline-none focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
                  >
                    {item.label}
                  </button>
                  {index < array.length - 1 ? <ChevronRight size={14} className="shrink-0 text-subtle" /> : null}
                </div>
              ))}
              {query.trim() ? (
                <span className="shrink-0 rounded-full bg-primary-soft px-2 py-1 text-xs font-medium text-primary-strong">
                  当前目录内搜索
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                leadingIcon={<Database size={16} />}
                onClick={() => setCacheManagerOpen(true)}
              >
                缓存管理
              </Button>
              <Button
                variant="secondary"
                leadingIcon={<ArrowUp size={16} />}
                disabled={currentDirPath === "/" || isListBusy}
                onClick={() => goToDirectory(parentDirectoryPath(currentDirPath))}
              >
                返回上级
              </Button>
              <Button
                variant="primary"
                leadingIcon={<FolderPlus size={16} />}
                disabled={isListBusy}
                onClick={() => {
                  setCreateDirParentPath(currentDirPath);
                  setCreateDirOpen(true);
                }}
              >
                新建目录
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(240px,1fr)_145px_auto] lg:items-center xl:grid-cols-[minmax(280px,1fr)_145px_auto]">
            <Input
              placeholder="搜索文件名、备注"
              leadingIcon={<Search size={15} />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="文件类型过滤"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as FileTypeFilter)}
              className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
            >
              {FILE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              <Segmented<FileLayoutMode>
                value={fileLayoutMode}
                onChange={changeFileLayoutMode}
                ariaLabel="文件布局"
                className="h-10"
                options={[
                  { value: "list", label: "列表", icon: <List size={15} /> },
                  { value: "grid", label: "网格", icon: <LayoutGrid size={15} /> }
                ]}
              />
              <IconButton
                variant="default"
                label="刷新"
                disabled={isListBusy}
                onClick={() => void loadFiles()}
              >
                {isListBusy ? <Spinner size={16} /> : <RefreshCw size={16} />}
              </IconButton>
            </div>
          </div>

          {selectedCount > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2">
              <p className="text-sm font-medium text-danger">
                已选 {selectedCount} 项
                <span className="ml-2 text-xs font-normal text-muted">
                  {selectedDirectoryCount} 个目录 · {selectedFileCount} 个文件
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isListBusy}
                  loading={operationLabel === "正在移动项目..."}
                  leadingIcon={<FolderInput size={15} />}
                  onClick={() => openMoveDialog()}
                >
                  移动
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={isListBusy}
                  loading={operationLabel === "正在批量删除..."}
                  leadingIcon={<Trash2 size={15} />}
                  onClick={() => void onBulkDelete()}
                >
                  批量删除
                </Button>
              </div>
            </div>
          ) : null}

          <div className="relative min-h-52 overflow-visible" aria-busy={isListBusy}>
            <div
              className={
                isListBusy
                  ? "pointer-events-none flex select-none flex-col gap-3 overflow-visible opacity-45 transition-opacity duration-200"
                  : "flex flex-col gap-3 overflow-visible transition-opacity duration-200"
              }
            >
              <FileTable
                directories={sortedDirectories}
                files={sortedFiles}
                selectedFileIds={selectedFileIds}
                selectedDirectoryIds={selectedDirectoryIds}
                allPageSelected={allPageSelected}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={changeSort}
                onOpenDirectory={(directory) => goToDirectory(directory.path)}
                onRenameDirectory={openRenameDirectoryDialog}
                onMoveDirectory={openMoveDirectoryDialog}
                onDeleteDirectory={(directory) => void onDeleteDirectory(directory)}
                onUploadToDirectory={(directory) => onUploadToDirectory(directory.path)}
                onToggleFileSelected={toggleFileSelected}
                onToggleDirectorySelected={toggleDirectorySelected}
                onTogglePage={togglePage}
                onDetail={setDetailFile}
                onEdit={openEditDialog}
                onEditThumbnail={setThumbnailEditingFile}
                onMoveFile={openMoveDialog}
                onPreview={setPreviewFile}
                onThumbnailPreview={setThumbnailPreviewFile}
                onCopy={onCopy}
                onAcceleratedDownload={(file) => void onAcceleratedDownload(file)}
                cacheSummary={cacheSummary}
                onCacheFile={(file) => void onCacheFile(file)}
                onPauseFileCache={(file) => void onPauseFileCache(file)}
                onResumeFileCache={(file) => void onResumeFileCache(file)}
                onTerminateFileCache={(file) => void onTerminateFileCache(file)}
                onClearFileCache={(file) => void onClearFileCache(file)}
                onDelete={onDelete}
                layout={fileLayoutMode}
              />
            </div>
            {listBusyLabel ? <FileListBusyOverlay label={listBusyLabel} /> : null}
          </div>
        </div>
      </div>

      <PreviewDialog
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        onCopy={copyText}
        onAcceleratedDownload={(file) => void onAcceleratedDownload(file)}
        videoPreviewCacheBytes={session.video_preview_cache_bytes}
        videoPreviewConcurrency={session.upload_concurrency}
      />
      <ThumbnailPreviewDialog
        file={thumbnailPreviewFile}
        onClose={() => setThumbnailPreviewFile(null)}
      />
      <ThumbnailEditDialog
        file={thumbnailEditingFile}
        onClose={() => setThumbnailEditingFile(null)}
        onSaved={handleThumbnailSaved}
      />
      <FileDetailDialog
        file={detailFile}
        onClose={() => setDetailFile(null)}
        onCopy={copyText}
        onAcceleratedDownload={(file) => void onAcceleratedDownload(file)}
      />
      <AcceleratedDownloadDialog
        state={acceleratedDownload}
        onCancel={cancelAcceleratedDownload}
        onClose={() => setAcceleratedDownload(null)}
        onRetryChunk={retryAcceleratedChunk}
        onRetryFailed={retryFailedAcceleratedChunks}
      />
      <CacheManagerDialog
        open={cacheManagerOpen}
        summary={cacheSummary}
        operation={cacheOperation}
        cacheFileIndex={cacheFileIndex}
        onClose={() => setCacheManagerOpen(false)}
        onRefresh={() => void refreshCacheSummary()}
        onClearAutomatic={() => void onClearAutomaticCache()}
        onPauseFile={(entry) => {
          const file = files.find((item) => item.id === entry.fileId);
          if (file) {
            void onPauseFileCache(file);
            return;
          }
          setCacheOperation({ fileId: entry.fileId, kind: "pause" });
          pauseFileCache(entry.fileId)
            .then(setCacheSummary)
            .then(() => toast.success("缓存已暂停"))
            .catch((error) => toast.danger(errorMessage(error)))
            .finally(() => setCacheOperation(null));
        }}
        onResumeFile={(entry) => {
          const file = files.find((item) => item.id === entry.fileId);
          if (file) {
            void onResumeFileCache(file);
            return;
          }
          void resumeFileCacheById(entry.fileId);
        }}
        onTerminateFile={(entry) => {
          const file = files.find((item) => item.id === entry.fileId);
          if (file) {
            void onTerminateFileCache(file);
            return;
          }
          setCacheOperation({ fileId: entry.fileId, kind: "terminate" });
          terminateFileCache(entry.fileId)
            .then(setCacheSummary)
            .then(() => toast.success("缓存已终止"))
            .catch((error) => toast.danger(errorMessage(error)))
            .finally(() => setCacheOperation(null));
        }}
        onClearFile={(entry) => {
          const file = files.find((item) => item.id === entry.fileId);
          if (file) {
            void onClearFileCache(file);
            return;
          }
          setCacheOperation({ fileId: entry.fileId, kind: "clear" });
          clearFileCache(entry.fileId)
            .then(setCacheSummary)
            .then(() => toast.success("缓存已清除"))
            .catch((error) => toast.danger(errorMessage(error)))
            .finally(() => setCacheOperation(null));
        }}
      />

      <Modal
        open={Boolean(editingFile)}
        onClose={() => {
          if (!savingFile) setEditingFile(null);
        }}
        title="编辑文件信息"
        description="修改备注不会影响链接；修改文件名会生成新的后台链接，旧链接仍可继续访问。"
        footer={
          <>
            <Button variant="secondary" disabled={savingFile} onClick={() => setEditingFile(null)}>
              取消
            </Button>
            <Button type="submit" form="edit-file-form" variant="primary" loading={savingFile}>
              保存
            </Button>
          </>
        }
      >
        <form
          id="edit-file-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaveFileMetadata();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-file-name" className="text-xs font-medium text-muted">
              文件名
            </label>
            <Input
              id="edit-file-name"
              value={editFileName}
              maxLength={180}
              disabled={savingFile}
              onChange={(event) => setEditFileName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-file-remark" className="text-xs font-medium text-muted">
              备注
            </label>
            <Textarea
              id="edit-file-remark"
              value={editRemark}
              maxLength={1000}
              disabled={savingFile}
              placeholder="补充说明，留空则清除备注"
              onChange={(event) => setEditRemark(event.target.value)}
            />
          </div>
          {editingFile && editFileName.trim() && editFileName.trim() !== editingFile.file_name ? (
            <p className="rounded-xl border border-warning/25 bg-warning-soft px-3 py-2 text-xs leading-5 text-warning">
              保存后，列表里复制的新链接会使用新文件名；已经分享出去的旧链接不会失效。
            </p>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={createDirOpen}
        onClose={() => {
          if (!creatingDir) {
            setCreateDirOpen(false);
            setNewDirName("");
            setCreateDirParentPath("/");
          }
        }}
        title="新建目录"
        description="选择上级目录后创建新的虚拟子目录；默认创建在根目录。"
        size="lg"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={creatingDir}
              onClick={() => {
                setCreateDirOpen(false);
                setCreateDirParentPath("/");
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="create-directory-form"
              variant="primary"
              loading={creatingDir}
              leadingIcon={<FolderPlus size={16} />}
            >
              创建
            </Button>
          </>
        }
      >
        <form
          id="create-directory-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreateDirectory();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              上级目录
            </span>
            <DirectoryTree
              id="create-directory-parent"
              ariaLabel="新目录上级目录"
              value={createDirParentPath}
              directories={directoryOptions}
              disabled={creatingDir}
              onChange={setCreateDirParentPath}
              treeClassName="max-h-[min(30rem,64dvh)]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="directory-name" className="text-xs font-medium text-muted">
              目录名称
            </label>
            <Input
              id="directory-name"
              value={newDirName}
              placeholder="例如 photos"
              maxLength={80}
              disabled={creatingDir}
              onChange={(event) => setNewDirName(event.target.value)}
            />
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(movingDirectory)}
        onClose={() => {
          if (!movingDirectorySaving) setMovingDirectory(null);
        }}
        title="移动目录"
        description={
          movingDirectory
            ? `将 ${movingDirectory.path} 移动到目标目录下，目录名保持为 ${movingDirectory.name}`
            : undefined
        }
        size="lg"
        footer={
          <>
            <Button variant="secondary" disabled={movingDirectorySaving} onClick={() => setMovingDirectory(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form="move-directory-form"
              variant="primary"
              loading={movingDirectorySaving}
              leadingIcon={<FolderInput size={16} />}
            >
              移动目录
            </Button>
          </>
        }
      >
        <form
          id="move-directory-form"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onMoveDirectory();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              目标父目录
            </span>
            <DirectoryTree
              id="move-directory-target"
              ariaLabel="目标父目录"
              value={directoryMoveTargetPath}
              directories={directoryMoveTargets}
              disabled={movingDirectorySaving}
              onChange={setDirectoryMoveTargetPath}
              treeClassName="max-h-[min(30rem,64dvh)]"
            />
          </div>
          {movingDirectory ? (
            <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
              会递归更新该目录、所有子目录和其中所有文件索引的虚拟路径；文件公开链接不会变化。
            </p>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={Boolean(renamingDirectory)}
        onClose={() => {
          if (!renamingDirectorySaving) setRenamingDirectory(null);
        }}
        title="重命名目录"
        description={
          renamingDirectory
            ? `重命名 ${renamingDirectory.path}，会递归更新子目录和文件索引路径`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" disabled={renamingDirectorySaving} onClick={() => setRenamingDirectory(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form="rename-directory-form"
              variant="primary"
              loading={renamingDirectorySaving}
              leadingIcon={<Pencil size={16} />}
            >
              保存
            </Button>
          </>
        }
      >
        <form
          id="rename-directory-form"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onRenameDirectory();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="rename-directory-name" className="text-xs font-medium text-muted">
              新目录名称
            </label>
            <Input
              id="rename-directory-name"
              value={directoryRenameName}
              maxLength={80}
              disabled={renamingDirectorySaving}
              placeholder="例如 photos"
              onChange={(event) => setDirectoryRenameName(event.target.value)}
            />
          </div>
          <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
            文件公开链接不会变化；如果同级目录已存在相同名称，保存会被拒绝。
          </p>
        </form>
      </Modal>

      <Modal
        open={moveOpen}
        onClose={() => {
          if (!movingFiles) {
            setMoveOpen(false);
            setMoveFileIds([]);
            setMoveDirectoryIds([]);
          }
        }}
        title="移动项目"
        description={`将 ${moveDirectoryIds.length} 个目录、${moveFileIds.length} 个文件移动到其他目录`}
        size="lg"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={movingFiles}
              onClick={() => {
                setMoveOpen(false);
                setMoveFileIds([]);
                setMoveDirectoryIds([]);
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="move-files-form"
              variant="primary"
              loading={movingFiles}
              leadingIcon={<FolderInput size={16} />}
            >
              移动
            </Button>
          </>
        }
      >
        <form
          id="move-files-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onMoveSelected();
          }}
        >
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={moveCreateNew}
              disabled={movingFiles}
              onChange={(event) => setMoveCreateNew(event.target.checked)}
              className="size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring"
            />
            移动到新目录
          </label>

          {moveCreateNew ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="move-new-name" className="text-xs font-medium text-muted">
                  新目录名称
                </label>
                <Input
                  id="move-new-name"
                  value={moveNewDirName}
                  placeholder="例如 2026"
                  maxLength={80}
                  disabled={movingFiles}
                  onChange={(event) => setMoveNewDirName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">
                  父目录
                </span>
                <DirectoryTree
                  id="move-new-parent"
                  ariaLabel="父目录"
                  value={moveNewParentPath}
                  directories={bulkMoveTargets}
                  disabled={movingFiles}
                  onChange={setMoveNewParentPath}
                  treeClassName="max-h-[min(30rem,62dvh)]"
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">
                目标目录
              </span>
              <DirectoryTree
                id="move-target"
                ariaLabel="目标目录"
                value={moveTargetPath}
                directories={bulkMoveTargets}
                disabled={movingFiles}
                onChange={setMoveTargetPath}
                treeClassName="max-h-[min(30rem,64dvh)]"
              />
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}

export const DashboardPage = memo(DashboardPageComponent);
