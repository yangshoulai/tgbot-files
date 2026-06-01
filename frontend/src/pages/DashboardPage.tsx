import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronRight, FolderInput, FolderPlus, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  ApiError,
  DirectoryItem,
  FileItem,
  Pagination as PaginationType,
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
import { dateInputToIso, formatBytes, sumFileSize } from "../utils";
import { useToast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Textarea } from "../components/ui/Textarea";
import { Spinner } from "../components/ui/Spinner";
import { MetricsRow, Metric } from "../components/files/MetricsRow";
import { FileTable } from "../components/files/FileTable";
import { Pagination } from "../components/files/Pagination";
import { PreviewDialog } from "../components/files/PreviewDialog";
import { FileDetailDialog } from "../components/files/FileDetailDialog";
import { DirectoryTreeSelect } from "../components/files/DirectoryTreeSelect";
import {
  AcceleratedDownloadDialog,
  type AcceleratedChunkState,
  type AcceleratedDownloadState
} from "../components/files/AcceleratedDownloadDialog";
import {
  DEFAULT_ACCELERATED_DOWNLOAD_CONCURRENCY,
  type MultipartDownloadFile,
  type NativeFileWritableStream,
  canUseAcceleratedDownload,
  createWritableFile,
  downloadMultipartChunk,
  extractSignedFileToken,
  expectedMultipartChunkSize,
  isAbortError,
  supportsNativeFileSave
} from "../lib/accelerated-download";
import { hasDirectFileAccess } from "../lib/file-access";

type FileTypeFilter = "all" | "image" | "text" | "pdf" | "archive" | "other";

interface DashboardPageProps {
  session: SessionResponse;
  uploadVersion: number;
  copyText: (value: string) => void;
  onDirectoryChange: (path: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

const INITIAL_LIMIT = 20;
const INITIAL_PAGINATION: PaginationType = { page: 1, limit: INITIAL_LIMIT, total: 0, total_pages: 1 };
const FILE_TYPE_OPTIONS: Array<{ value: FileTypeFilter; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "text", label: "文本" },
  { value: "pdf", label: "PDF" },
  { value: "archive", label: "压缩包" },
  { value: "other", label: "其他" }
];

interface AcceleratedDownloadTask {
  file: MultipartDownloadFile;
  token: string;
  writable: NativeFileWritableStream;
  concurrency: number;
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

export function DashboardPage({ session, uploadVersion, copyText, onDirectoryChange }: DashboardPageProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const acceleratedDownloadTaskRef = useRef<AcceleratedDownloadTask | null>(null);

  const [files, setFiles] = useState<FileItem[]>([]);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [globalStats, setGlobalStats] = useState({ file_count: 0, total_size: 0 });
  const [currentDirPath, setCurrentDirPath] = useState("/");
  const [pagination, setPagination] = useState<PaginationType>(INITIAL_PAGINATION);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [uploadedFrom, setUploadedFrom] = useState("");
  const [uploadedTo, setUploadedTo] = useState("");
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [loading, setLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
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
  const [acceleratedDownload, setAcceleratedDownload] = useState<AcceleratedDownloadState | null>(null);

  const loadFiles = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      try {
        const response = await listFiles({
          q: query,
          page: nextPage,
          limit,
          dir: currentDirPath,
          type: typeFilter,
          created_from: dateInputToIso(uploadedFrom, "start"),
          created_to: dateInputToIso(uploadedTo, "end")
        });
        setDirectories(response.directories);
        setFiles(response.files);
        setPagination(response.pagination);
        setGlobalStats(response.global_stats);
      } catch (error) {
        toast.danger(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [currentDirPath, limit, query, toast, typeFilter, uploadedFrom, uploadedTo]
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
    void loadFiles(1);
  }, [loadFiles]);

  useEffect(() => {
    void loadDirectoryOptions();
  }, [loadDirectoryOptions]);

  useEffect(() => {
    onDirectoryChange(currentDirPath);
  }, [currentDirPath, onDirectoryChange]);

  useEffect(() => {
    if (uploadVersion > 0) {
      void loadFiles(1);
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
        value: String(pagination.total),
        hint: `${currentDirPath} · ${pagination.page} / ${pagination.total_pages} 页`
      },
      {
        label: "当前页占用",
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
      }
    ];
  }, [currentDirPath, directories.length, files, globalStats, pagination.page, pagination.total, pagination.total_pages, session.config]);

  async function onDelete(file: FileItem) {
    const ok = await confirm({
      title: "删除该文件索引？",
      description: (
        <>
          将从控制台移除 <span className="font-mono text-foreground">{file.file_name}</span>。
          Telegram 中的原始消息和已分发的签名链接不会被影响。
        </>
      ),
      tone: "danger",
      confirmText: "删除"
    });
    if (!ok) return;

    try {
      await deleteFile(file.id);
      toast.success("索引已删除");
      if (previewFile?.id === file.id) setPreviewFile(null);
      if (detailFile?.id === file.id) setDetailFile(null);
      setSelectedFileIds((current) => {
        const next = new Set(current);
        next.delete(file.id);
        return next;
      });
      const targetPage = files.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      await loadFiles(targetPage);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }

  async function onBulkDelete() {
    const targetFiles = files.filter((file) => selectedFileIds.has(file.id));
    const targetDirectories = directories.filter((directory) => selectedDirectoryIds.has(directory.id));
    const totalTargets = targetFiles.length + targetDirectories.length;
    if (totalTargets === 0) return;

    const ok = await confirm({
      title: `删除选中的 ${totalTargets} 个项目？`,
      description: (
        <>
          将删除 {targetDirectories.length} 个目录及其子项、{targetFiles.length} 个文件索引。
          Telegram 中的原始消息和已分发的签名链接不会被影响。
        </>
      ),
      tone: "danger",
      confirmText: "批量删除"
    });
    if (!ok) return;

    try {
      const result = await deleteEntries({
        file_ids: targetFiles.map((file) => file.id),
        directory_ids: targetDirectories.map((directory) => directory.id)
      });
      toast.success(`已删除 ${result.deleted_directories} 个目录、${result.deleted_files} 个文件索引`);
      if (previewFile && targetFiles.some((file) => file.id === previewFile.id)) setPreviewFile(null);
      if (detailFile && targetFiles.some((file) => file.id === detailFile.id)) setDetailFile(null);
      setSelectedFileIds(new Set());
      setSelectedDirectoryIds(new Set());
      const allVisibleSelected = targetFiles.length === files.length && targetDirectories.length === directories.length;
      const targetPage = allVisibleSelected && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      await loadFiles(targetPage);
    } catch (error) {
      toast.danger(errorMessage(error));
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
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
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
          将递归删除 <span className="font-mono text-foreground">{directory.path}</span>{" "}
          下的所有子目录和文件索引。Telegram 中的原始消息和已分发的签名链接不会被影响。
        </>
      ),
      tone: "danger",
      confirmText: "递归删除"
    });
    if (!ok) return;

    try {
      const result = await deleteDirectory(directory.id);
      toast.success(`已删除 ${result.deleted_directories} 个目录、${result.deleted_files} 个文件索引`);
      setSelectedDirectoryIds((current) => {
        const next = new Set(current);
        next.delete(directory.id);
        return next;
      });
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
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
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
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
    try {
      const result = await moveDirectory(movingDirectory.id, directoryMoveTargetPath);
      toast.success(`已移动 ${result.moved_directories} 个目录、${result.moved_files} 个文件索引到 ${result.directory.path}`);
      setMovingDirectory(null);
      setSelectedDirectoryIds((current) => {
        const next = new Set(current);
        next.delete(result.directory.id);
        return next;
      });
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMovingDirectorySaving(false);
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
      if (detailFile?.id === updated.id) setDetailFile(updated);
      setEditingFile(null);
      toast.success(updated.file_path !== editingFile.file_path ? "文件信息已保存，链接已更新" : "文件信息已保存");
      await loadFiles(pagination.page);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSavingFile(false);
    }
  }

  async function onMoveSelected() {
    if (moveFileIds.length + moveDirectoryIds.length === 0) return;

    const newName = moveNewDirName.trim();
    if (moveCreateNew && !newName) {
      toast.danger("请输入新目录名称");
      return;
    }

    setMovingFiles(true);
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
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMovingFiles(false);
    }
  }

  function goToDirectory(path: string) {
    setCurrentDirPath(path);
    setSelectedFileIds(new Set());
    setSelectedDirectoryIds(new Set());
  }

  function onCopy(file: FileItem) {
    if (!hasDirectFileAccess(file)) {
      toast.info("该文件仅支持加速下载，不提供完整文件链接");
      return;
    }

    copyText(file.url);
  }

  async function onAcceleratedDownload(file: FileItem) {
    if (acceleratedDownloadTaskRef.current) {
      toast.info("已有加速下载任务进行中，请先完成或取消当前任务");
      return;
    }

    if (!canUseAcceleratedDownload(file)) {
      toast.info("该文件不是 Telegram 分片文件，已保留普通下载入口");
      return;
    }

    if (!supportsNativeFileSave()) {
      if (!hasDirectFileAccess(file)) {
        toast.info("当前浏览器不支持加速下载，该文件也不提供普通下载链接");
        return;
      }
      toast.info("当前浏览器不支持加速下载，已切换为普通下载");
      triggerFallbackDownload(file);
      return;
    }

    const token = extractSignedFileToken(file.file_path);
    if (!token) {
      if (!hasDirectFileAccess(file)) {
        toast.info("无法解析分片下载 token，该文件也不提供普通下载链接");
        return;
      }
      toast.info("无法解析分片下载 token，已切换为普通下载");
      triggerFallbackDownload(file);
      return;
    }

    setAcceleratedDownload({
      fileId: file.id,
      fileName: file.file_name,
      status: "preparing",
      concurrency: DEFAULT_ACCELERATED_DOWNLOAD_CONCURRENCY,
      totalBytes: file.size,
      chunks: createInitialAcceleratedChunks(file)
    });

    let writable: Awaited<ReturnType<typeof createWritableFile>>;
    try {
      writable = await createWritableFile(file.file_name);
    } catch (error) {
      setAcceleratedDownload(null);
      if (!isAbortError(error)) {
        toast.danger(errorMessage(error));
      }
      return;
    }

    const task: AcceleratedDownloadTask = {
      file,
      token,
      writable,
      concurrency: DEFAULT_ACCELERATED_DOWNLOAD_CONCURRENCY,
      queue: Array.from({ length: file.chunk_count }, (_, index) => index),
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
      current?.fileId === file.id
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
    const controller = new AbortController();
    task.controllers.set(chunkIndex, controller);
    updateAcceleratedChunk(task.file.id, chunkIndex, (chunk) => ({
      ...chunk,
      status: "downloading",
      downloadedBytes: 0,
      attempts: chunk.attempts + 1,
      errorMessage: undefined
    }));

    try {
      const bytes = await downloadMultipartChunk({
        file: task.file,
        token: task.token,
        chunkIndex,
        signal: controller.signal,
        onProgress: (progress) => {
          updateAcceleratedChunk(task.file.id, chunkIndex, (chunk) => ({
            ...chunk,
            downloadedBytes: progress.downloadedBytes
          }));
        }
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
      updateAcceleratedChunk(task.file.id, chunkIndex, (chunk) => ({
        ...chunk,
        status: "completed",
        downloadedBytes: chunk.size,
        errorMessage: undefined
      }));
      await finalizeAcceleratedDownloadIfReady(task);
    } catch (error) {
      if (!task.cancelled) {
        task.failed.add(chunkIndex);
        updateAcceleratedChunk(task.file.id, chunkIndex, (chunk) => ({
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
    const writeOperation = task.writeChain.then(() =>
      task.writable.write({
        type: "write",
        position: chunkIndex * task.file.chunk_size,
        data: bytes
      })
    );

    task.writeChain = writeOperation.catch(() => undefined);
    return writeOperation;
  }

  async function finalizeAcceleratedDownloadIfReady(task: AcceleratedDownloadTask) {
    if (task.finalized || task.cancelled || task.completed.size !== task.file.chunk_count) {
      return;
    }

    task.finalized = true;
    setAcceleratedDownload((current) =>
      current?.fileId === task.file.id ? { ...current, status: "finalizing" } : current
    );

    try {
      await task.writeChain;
      await task.writable.close();
      if (acceleratedDownloadTaskRef.current === task) {
        acceleratedDownloadTaskRef.current = null;
      }
      setAcceleratedDownload((current) =>
        current?.fileId === task.file.id ? { ...current, status: "completed" } : current
      );
      toast.success("加速下载完成");
    } catch (error) {
      if (acceleratedDownloadTaskRef.current === task) {
        acceleratedDownloadTaskRef.current = null;
      }
      setAcceleratedDownload((current) =>
        current?.fileId === task.file.id
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
    updateAcceleratedChunk(task.file.id, chunkIndex, (chunk) => ({
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
      updateAcceleratedChunk(task.file.id, chunkIndex, (chunk) => ({
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
      current?.fileId === task.file.id ? { ...current, status: "cancelled" } : current
    );
    toast.info("下载已取消");
  }

  function triggerFallbackDownload(file: FileItem) {
    if (!hasDirectFileAccess(file)) {
      toast.info("该文件仅支持加速下载，不提供普通下载链接");
      return;
    }

    const link = document.createElement("a");
    link.href = file.download_url;
    link.download = file.file_name;
    document.body.appendChild(link);
    link.click();
    link.remove();
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

      return {
        ...current,
        chunks: current.chunks.map((chunk) => (chunk.index === chunkIndex ? updater(chunk) : chunk))
      };
    });
  }

  function updateAcceleratedOverallStatus(task: AcceleratedDownloadTask) {
    setAcceleratedDownload((current) => {
      if (!current || current.fileId !== task.file.id || task.finalized || task.cancelled) {
        return current;
      }

      if (task.running.size > 0 || task.queue.length > 0) {
        return { ...current, status: "downloading" };
      }

      if (task.failed.size > 0) {
        return { ...current, status: "partial_failed" };
      }

      return current;
    });
  }

  function createInitialAcceleratedChunks(file: MultipartDownloadFile): AcceleratedChunkState[] {
    return Array.from({ length: file.chunk_count }, (_, index) => ({
      index,
      size: expectedMultipartChunkSize(file, index),
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

  function togglePage(selected: boolean) {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      for (const file of files) {
        if (selected) next.add(file.id);
        else next.delete(file.id);
      }
      return next;
    });
    setSelectedDirectoryIds((current) => {
      const next = new Set(current);
      for (const directory of directories) {
        if (selected) next.add(directory.id);
        else next.delete(directory.id);
      }
      return next;
    });
  }

  const visibleEntryCount = files.length + directories.length;
  const selectedFileCount = files.filter((file) => selectedFileIds.has(file.id)).length;
  const selectedDirectoryCount = directories.filter((directory) => selectedDirectoryIds.has(directory.id)).length;
  const selectedCount = selectedFileCount + selectedDirectoryCount;
  const allPageSelected = visibleEntryCount > 0 &&
    files.every((file) => selectedFileIds.has(file.id)) &&
    directories.every((directory) => selectedDirectoryIds.has(directory.id));
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">控制台</p>
          <h1 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">文件管理</h1>
          <p className="mt-1 text-sm text-muted">上传、检索、预览与分发存储在 Telegram 中的文件。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            leadingIcon={<ArrowUp size={16} />}
            disabled={currentDirPath === "/"}
            onClick={() => goToDirectory(parentDirectoryPath(currentDirPath))}
          >
            返回上级
          </Button>
          <Button
            variant="primary"
            leadingIcon={<FolderPlus size={16} />}
            onClick={() => {
              setCreateDirParentPath("/");
              setCreateDirOpen(true);
            }}
          >
            新建目录
          </Button>
        </div>
      </div>

      <MetricsRow metrics={metrics} />

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-card sm:p-4">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-background/60 px-3 py-2">
          {directoryBreadcrumbs(currentDirPath).map((item, index, array) => (
            <div key={item.path} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => goToDirectory(item.path)}
                className="rounded-md px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-primary-soft hover:text-primary-strong focus-visible:outline-none focus-visible:focus-ring"
              >
                {item.label}
              </button>
              {index < array.length - 1 ? <ChevronRight size={14} className="text-subtle" /> : null}
            </div>
          ))}
          {query.trim() ? (
            <span className="ml-auto rounded-full bg-primary-soft px-2 py-1 text-xs font-medium text-primary-strong">
              当前目录内搜索
            </span>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(240px,1fr)_220px_145px_145px_145px_auto] xl:items-center">
          <Input
            placeholder="搜索文件名、备注"
            leadingIcon={<Search size={15} />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <DirectoryTreeSelect
            ariaLabel="目录过滤"
            value={currentDirPath}
            directories={directoryOptions}
            onChange={goToDirectory}
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
          <Input
            type="date"
            aria-label="上传开始时间"
            value={uploadedFrom}
            onChange={(event) => setUploadedFrom(event.target.value)}
          />
          <Input
            type="date"
            aria-label="上传结束时间"
            value={uploadedTo}
            onChange={(event) => setUploadedTo(event.target.value)}
          />
          <div className="flex items-center justify-end">
            <IconButton
              variant="default"
              label="刷新"
              onClick={() => void loadFiles(pagination.page)}
            >
              {loading ? <Spinner size={16} /> : <RefreshCw size={16} />}
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
              <button
                type="button"
                onClick={() => openMoveDialog()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground shadow-card transition-colors hover:border-border-strong hover:bg-background focus-visible:outline-none focus-visible:focus-ring"
              >
                <FolderInput size={15} />
                移动
              </button>
              <button
                type="button"
                onClick={() => void onBulkDelete()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-sm font-medium text-white shadow-card transition-colors hover:bg-danger-strong focus-visible:outline-none focus-visible:focus-ring"
              >
                <Trash2 size={15} />
                批量删除
              </button>
            </div>
          </div>
        ) : null}

        <FileTable
          directories={directories}
          files={files}
          selectedFileIds={selectedFileIds}
          selectedDirectoryIds={selectedDirectoryIds}
          allPageSelected={allPageSelected}
          onOpenDirectory={(directory) => goToDirectory(directory.path)}
          onRenameDirectory={openRenameDirectoryDialog}
          onMoveDirectory={openMoveDirectoryDialog}
          onDeleteDirectory={(directory) => void onDeleteDirectory(directory)}
          onToggleFileSelected={toggleFileSelected}
          onToggleDirectorySelected={toggleDirectorySelected}
          onTogglePage={togglePage}
          onDetail={setDetailFile}
          onEdit={openEditDialog}
          onMoveFile={openMoveDialog}
          onPreview={setPreviewFile}
          onCopy={onCopy}
          onAcceleratedDownload={(file) => void onAcceleratedDownload(file)}
          onDelete={onDelete}
        />

        <Pagination
          pagination={pagination}
          onPage={(page) => void loadFiles(page)}
          onLimitChange={(nextLimit) => setLimit(nextLimit)}
        />
      </div>

      <PreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} onCopy={copyText} />
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
            <label htmlFor="create-directory-parent" className="text-xs font-medium text-muted">
              上级目录
            </label>
            <DirectoryTreeSelect
              id="create-directory-parent"
              ariaLabel="新目录上级目录"
              value={createDirParentPath}
              directories={directoryOptions}
              disabled={creatingDir}
              onChange={setCreateDirParentPath}
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
            <label htmlFor="move-directory-target" className="text-xs font-medium text-muted">
              目标父目录
            </label>
            <DirectoryTreeSelect
              id="move-directory-target"
              ariaLabel="目标父目录"
              value={directoryMoveTargetPath}
              directories={directoryMoveTargets}
              disabled={movingDirectorySaving}
              onChange={setDirectoryMoveTargetPath}
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="move-new-parent" className="text-xs font-medium text-muted">
                  父目录
                </label>
                <DirectoryTreeSelect
                  id="move-new-parent"
                  ariaLabel="父目录"
                  value={moveNewParentPath}
                  directories={bulkMoveTargets}
                  disabled={movingFiles}
                  onChange={setMoveNewParentPath}
                />
              </div>
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
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="move-target" className="text-xs font-medium text-muted">
                目标目录
              </label>
              <DirectoryTreeSelect
                id="move-target"
                ariaLabel="目标目录"
                value={moveTargetPath}
                directories={bulkMoveTargets}
                disabled={movingFiles}
                onChange={setMoveTargetPath}
              />
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
