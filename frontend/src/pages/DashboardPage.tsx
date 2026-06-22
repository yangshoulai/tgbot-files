import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, ChevronRight, Database, FolderInput, FolderPlus, LayoutGrid, List, Maximize2, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Trash2, X } from "lucide-react";
import {
  ApiError,
  DirectoryItem,
  FileItem,
  SessionResponse,
  createDirectory,
  deleteEntries,
  deleteDirectory,
  deleteFile,
  listDirectories,
  listFiles,
  moveDirectory,
  moveEntries,
  renameDirectory,
  updateFileMetadata
} from "../api";
import { formatBytes, sumFileSize } from "../utils";
import { useToast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import {
  clearFileCache,
  clearFilesCache,
  pauseFileCache,
  terminateFileCache
} from "../lib/file-cache";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
import { Button } from "../components/ui/Button";
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
import { CacheManagerDialog } from "../components/files/cache/CacheManagerDialog";
import { AcceleratedDownloadDialog } from "../components/files/AcceleratedDownloadDialog";
import { EditFileDialog } from "../components/files/EditFileDialog";
import { CreateDirectoryDialog } from "../components/files/CreateDirectoryDialog";
import { DirectoryMoveDialog } from "../components/files/DirectoryMoveDialog";
import { DirectoryRenameDialog } from "../components/files/DirectoryRenameDialog";
import { MoveEntriesDialog } from "../components/files/MoveEntriesDialog";
import { hasFileLinkAccess } from "../lib/file-access";
import {
  compareDirectoryItems,
  compareFileItems,
  directoryBreadcrumbs,
  initialFileLayoutMode,
  parentDirectoryPath,
  type FileLayoutMode,
  type FileSortKey,
  type FileTypeFilter,
  type SortDirection
} from "../lib/file-list";
import { useAcceleratedDownload } from "./dashboard/use-accelerated-download";
import { useFileCacheManager } from "./dashboard/use-file-cache-manager";

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


function DashboardPageComponent({ session, uploadVersion, copyText, onDirectoryChange, onUploadToDirectory }: DashboardPageProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [files, setFiles] = useState<FileItem[]>([]);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [globalStats, setGlobalStats] = useState({ file_count: 0, total_size: 0 });
  const [currentDirPath, setCurrentDirPath] = useState("/");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [sortKey, setSortKey] = useState<FileSortKey>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [fileLayoutMode, setFileLayoutMode] = useState<FileLayoutMode>(() => initialFileLayoutMode(FILE_LAYOUT_STORAGE_KEY));
  const [loading, setLoading] = useState(false);
  const [operationLabel, setOperationLabel] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [previewMinimized, setPreviewMinimized] = useState(false);
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
  const {
    acceleratedDownload,
    setAcceleratedDownload,
    onAcceleratedDownload,
    retryAcceleratedChunk,
    retryFailedAcceleratedChunks,
    cancelAcceleratedDownload
  } = useAcceleratedDownload({ session, toast });
  const {
    cacheSummary,
    setCacheSummary,
    cacheManagerOpen,
    setCacheManagerOpen,
    cacheOperation,
    setCacheOperation,
    cacheFileIndex,
    refreshCacheSummary,
    onCacheFile,
    onPauseFileCache,
    onResumeFileCache,
    onTerminateFileCache,
    resumeFileCacheById,
    onClearFileCache,
    onClearAutomaticCache
  } = useFileCacheManager({ files, session, toast });
  const listBusyLabel = operationLabel ?? (loading ? "正在加载目录内容..." : undefined);
  const isListBusy = Boolean(listBusyLabel);

  const openPreview = useCallback((file: FileItem) => {
    setPreviewFile(file);
    setPreviewMinimized(false);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewMinimized(false);
  }, []);

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

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    void loadDirectoryOptions();
  }, [loadDirectoryOptions]);

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
      if (previewFile?.id === file.id) closePreview();
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
      if (previewFile && targetFiles.some((file) => file.id === previewFile.id)) closePreview();
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
                onPreview={openPreview}
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

      {previewFile && previewMinimized ? (
        <div className="fixed bottom-5 right-5 z-40 flex max-w-[min(26rem,calc(100vw-2.5rem))] items-center gap-2 rounded-xl border border-border bg-background/95 px-3 py-2 shadow-dialog backdrop-blur-md">
          <FileVisual
            mimeType={previewFile.mime_type}
            fileName={previewFile.file_name}
            url={hasFileLinkAccess(previewFile) ? previewFile.file_path : undefined}
            thumbnailUrl={previewFile.thumbnail_url}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground" title={previewFile.file_name}>
              {previewFile.file_name}
            </p>
            <p className="truncate text-xs text-muted">预览已最小化</p>
          </div>
          <IconButton
            size="sm"
            variant="ghost"
            label="打开预览"
            onClick={() => setPreviewMinimized(false)}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            label="关闭预览"
            onClick={closePreview}
          >
            <X size={15} />
          </IconButton>
        </div>
      ) : null}

      <PreviewDialog
        file={previewFile}
        minimized={previewMinimized}
        onClose={closePreview}
        onMinimize={() => setPreviewMinimized(true)}
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

      <EditFileDialog
        editingFile={editingFile}
        editFileName={editFileName}
        editRemark={editRemark}
        savingFile={savingFile}
        onClose={() => setEditingFile(null)}
        onChangeFileName={setEditFileName}
        onChangeRemark={setEditRemark}
        onSubmit={() => void onSaveFileMetadata()}
      />

      <CreateDirectoryDialog
        open={createDirOpen}
        creatingDir={creatingDir}
        createDirParentPath={createDirParentPath}
        newDirName={newDirName}
        directoryOptions={directoryOptions}
        onClose={() => {
          setCreateDirOpen(false);
          setNewDirName("");
          setCreateDirParentPath("/");
        }}
        onCancel={() => {
          setCreateDirOpen(false);
          setCreateDirParentPath("/");
        }}
        onChangeParentPath={setCreateDirParentPath}
        onChangeName={setNewDirName}
        onSubmit={() => void onCreateDirectory()}
      />

      <DirectoryMoveDialog
        movingDirectory={movingDirectory}
        movingDirectorySaving={movingDirectorySaving}
        directoryMoveTargetPath={directoryMoveTargetPath}
        directoryMoveTargets={directoryMoveTargets}
        onClose={() => setMovingDirectory(null)}
        onChangeTargetPath={setDirectoryMoveTargetPath}
        onSubmit={() => void onMoveDirectory()}
      />

      <DirectoryRenameDialog
        renamingDirectory={renamingDirectory}
        renamingDirectorySaving={renamingDirectorySaving}
        directoryRenameName={directoryRenameName}
        onClose={() => setRenamingDirectory(null)}
        onChangeName={setDirectoryRenameName}
        onSubmit={() => void onRenameDirectory()}
      />

      <MoveEntriesDialog
        open={moveOpen}
        movingFiles={movingFiles}
        moveFileIds={moveFileIds}
        moveDirectoryIds={moveDirectoryIds}
        moveCreateNew={moveCreateNew}
        moveNewDirName={moveNewDirName}
        moveNewParentPath={moveNewParentPath}
        moveTargetPath={moveTargetPath}
        bulkMoveTargets={bulkMoveTargets}
        onClose={() => {
          setMoveOpen(false);
          setMoveFileIds([]);
          setMoveDirectoryIds([]);
        }}
        onChangeCreateNew={setMoveCreateNew}
        onChangeNewDirName={setMoveNewDirName}
        onChangeNewParentPath={setMoveNewParentPath}
        onChangeTargetPath={setMoveTargetPath}
        onSubmit={() => void onMoveSelected()}
      />
    </div>
  );
}

export const DashboardPage = memo(DashboardPageComponent);
