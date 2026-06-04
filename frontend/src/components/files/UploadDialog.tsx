import { ChangeEvent, FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, ClipboardPaste, FilePlus2, ImageOff, ImagePlus, Layers3, Link2, Pencil, Trash2, UploadCloud, X } from "lucide-react";
import {
  ApiError,
  completeMultipartUpload,
  getMultipartUploadStatus,
  initMultipartUpload,
  initUrlMultipartUpload,
  listDirectories,
  uploadMultipartChunk,
  uploadUrlMultipartChunk,
  type DirectoryItem,
  type FileNameConflictAction,
  type MultipartUpload,
  type ThumbnailUploadPayload
} from "../../api";
import { formatBytes, formatCompactBytes } from "../../utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Textarea";
import { Spinner } from "../ui/Spinner";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { Segmented } from "../ui/Segmented";
import { Input } from "../ui/Input";
import { DirectoryTreeSelect } from "./DirectoryTreeSelect";
import { cn } from "../../lib/cn";
import {
  canAutoGenerateThumbnail,
  generateThumbnailFromFile,
  generateThumbnailFromRemoteSource,
  revokeThumbnail,
  type GeneratedThumbnail
} from "../../lib/thumbnail";

interface UploadDialogProps {
  open: boolean;
  initialFiles: File[];
  maxBytes: number;
  multipartChunkBytes: number;
  maxMultipartBytes: number;
  directoryPath: string;
  onClose: () => void;
  onUploaded: (uploadedCount: number) => void;
  onError: (message: string) => void;
}

type ItemStatus = "pending" | "uploading" | "done" | "error" | "skipped";
type UploadMode = "file" | "url";
type UploadChunkStatus = "queued" | "uploading" | "completed" | "failed";

interface ChunkProgress {
  completed: number;
  total: number;
  label: string;
  failed?: number;
}

interface UploadChunkState {
  index: number;
  size: number;
  status: UploadChunkStatus;
  attempts: number;
  errorMessage?: string;
}

interface MultipartRetryState {
  kind: "local" | "url";
  uploadId: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  directAccess: boolean;
  conflictAction: FileNameConflictAction;
  completedChunks: number[];
  failedChunks: number[];
}

interface FileNameConflictState {
  fileName: string;
  suggestedName: string;
  directoryPath: string;
}

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  chunks?: UploadChunkState[];
  retry?: MultipartRetryState;
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  conflictAction?: FileNameConflictAction;
  thumbnail?: UploadThumbnailState;
}

interface UrlUploadState {
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  chunks?: UploadChunkState[];
  retry?: MultipartRetryState;
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  conflictAction?: FileNameConflictAction;
  thumbnail?: UploadThumbnailState;
}

type UploadThumbnailStatus = "idle" | "generating" | "ready" | "failed" | "removed";

interface UploadThumbnailState {
  status: UploadThumbnailStatus;
  generated?: GeneratedThumbnail;
  message?: string;
}

interface ChunkQueueResult {
  completedChunks: number[];
  failedChunks: number[];
  cancelled: boolean;
}

interface UploadAbortContext {
  kind: "local" | "url";
  itemId?: string;
  abortController: AbortController;
  controllers: Set<AbortController>;
  cancelled: boolean;
}

let counter = 0;
const MULTIPART_UPLOAD_CONCURRENCY = 5;
const URL_MULTIPART_UPLOAD_CONCURRENCY = 5;
const MULTIPART_UPLOAD_MAX_ATTEMPTS = 3;
const MULTIPART_UPLOAD_RETRY_DELAY_MS = 800;
const LOCAL_CHUNK_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const URL_CHUNK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const FILE_NAME_CONFLICT_TOAST_MESSAGE = "上传目录已存在同名文件，请选择覆盖或改名上传";

class MultipartChunkUploadError extends Error {
  constructor(
    message: string,
    public readonly retry: MultipartRetryState,
    public readonly stopped = false
  ) {
    super(message);
    this.name = "MultipartChunkUploadError";
  }
}

function makeItem(file: File): QueueItem {
  counter += 1;
  return {
    id: `${Date.now()}-${counter}`,
    file,
    status: "pending",
    thumbnail: canAutoGenerateThumbnail(file) ? { status: "idle" } : undefined
  };
}

export function UploadDialog({
  open,
  initialFiles,
  maxBytes,
  multipartChunkBytes,
  maxMultipartBytes,
  directoryPath,
  onClose,
  onUploaded,
  onError
}: UploadDialogProps) {
  const [mode, setMode] = useState<UploadMode>("file");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [urlUpload, setUrlUpload] = useState<UrlUploadState>({ status: "pending" });
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadDirectoryPath, setUploadDirectoryPath] = useState(directoryPath);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [directoriesLoading, setDirectoriesLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const onErrorRef = useRef(onError);
  const activeUploadRef = useRef<UploadAbortContext | null>(null);
  const [activeUploadKind, setActiveUploadKind] = useState<"local" | "url" | null>(null);
  const [activeUploadItemId, setActiveUploadItemId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!open) {
      abortUploadTask(activeUploadRef.current);
      activeUploadRef.current = null;
      setActiveUploadKind(null);
      setActiveUploadItemId(null);
      setStopRequested(false);
      setItems((current) => {
        current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
        return [];
      });
      setUrlUpload((current) => {
        revokeThumbnail(current.thumbnail?.generated);
        return { status: "pending" };
      });
      setMode("file");
      setSourceUrl("");
      setRemark("");
      setSubmitting(false);
      setDragOver(false);
      setUploadDirectoryPath(directoryPath);
      return;
    }
    setMode("file");
    setUploadDirectoryPath(directoryPath);
    setItems((current) => {
      current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
      return initialFiles.map(makeItem);
    });
    setSourceUrl("");
    setUrlUpload((current) => {
      revokeThumbnail(current.thumbnail?.generated);
      return { status: "pending" };
    });
  }, [directoryPath, open, initialFiles]);

  useEffect(() => {
    if (!open) return;

    let disposed = false;
    setDirectoriesLoading(true);

    listDirectories(true)
      .then((response) => {
        if (!disposed) {
          setDirectoryOptions(response.directories);
        }
      })
      .catch((error) => {
        if (!disposed) {
          onErrorRef.current(`目录列表加载失败：${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (!disposed) {
          setDirectoriesLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [open]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setMode("file");
    setItems((current) => [...current, ...files.map(makeItem)]);
  }, []);

  const handlePick = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    addFiles(Array.from(list));
    event.target.value = "";
  };

  const removeItem = (id: string) => {
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      revokeThumbnail(target?.thumbnail?.generated);
      return current.filter((item) => item.id !== id);
    });
  };

  const updateItemThumbnail = (id: string, thumbnail: UploadThumbnailState | undefined) => {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        revokeThumbnail(item.thumbnail?.generated);
        return { ...item, thumbnail };
      })
    );
  };

  const handleManualItemThumbnail = async (id: string, file: File) => {
    updateItemThumbnail(id, { status: "generating", message: "正在处理手动缩略图" });
    try {
      const thumbnail = await generateThumbnailFromFile(file, "manual");
      updateItemThumbnail(id, { status: "ready", generated: thumbnail });
    } catch (error) {
      updateItemThumbnail(id, {
        status: "failed",
        message: error instanceof Error ? error.message : "手动缩略图处理失败"
      });
    }
  };

  const removeItemThumbnail = (id: string) => {
    updateItemThumbnail(id, { status: "removed", message: "已移除缩略图" });
  };

  const updateUrlThumbnail = (thumbnail: UploadThumbnailState | undefined) => {
    setUrlUpload((current) => {
      revokeThumbnail(current.thumbnail?.generated);
      return { ...current, thumbnail };
    });
  };

  const handleManualUrlThumbnail = async (file: File) => {
    updateUrlThumbnail({ status: "generating", message: "正在处理手动缩略图" });
    try {
      const thumbnail = await generateThumbnailFromFile(file, "manual");
      updateUrlThumbnail({ status: "ready", generated: thumbnail });
    } catch (error) {
      updateUrlThumbnail({
        status: "failed",
        message: error instanceof Error ? error.message : "手动缩略图处理失败"
      });
    }
  };

  const removeUrlThumbnail = () => {
    updateUrlThumbnail({ status: "removed", message: "已移除缩略图" });
  };

  const filePendingCount = items.filter((item) => item.status === "pending" || item.status === "error").length;
  const normalizedSourceUrl = sourceUrl.trim();
  const urlPendingCount = normalizedSourceUrl && urlUpload.status !== "uploading" && urlUpload.status !== "done" ? 1 : 0;
  const pendingCount = mode === "url" ? urlPendingCount : filePendingCount;
  const hasUnresolvedConflict = mode === "url"
    ? Boolean(urlUpload.conflict)
    : items.some((item) => (item.status === "pending" || item.status === "error") && Boolean(item.conflict));
  const hasInvalidFileName = mode === "url"
    ? Boolean(
        normalizedSourceUrl &&
        (urlUpload.editingFileName || urlUpload.conflict) &&
        urlUpload.fileNameOverride !== undefined &&
        urlUpload.fileNameOverride.trim().length === 0
      )
    : items.some((item) =>
        (item.status === "pending" || item.status === "error") &&
        (item.editingFileName || item.conflict) &&
        item.fileNameOverride !== undefined &&
        item.fileNameOverride.trim().length === 0
      );
  const hasDone = urlUpload.status === "done" || items.some((item) => item.status === "done");

  useEffect(() => {
    if (!open) return;

    const target = items.find((item) => item.thumbnail?.status === "idle");
    if (!target) return;

    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? { ...item, thumbnail: { status: "generating", message: "正在生成缩略图" } }
          : item
      )
    );

    void generateThumbnailFromFile(target.file)
      .then((thumbnail) => {
        setItems((current) =>
          current.map((item) => {
            if (item.id !== target.id) return item;
            revokeThumbnail(item.thumbnail?.generated);
            return { ...item, thumbnail: { status: "ready", generated: thumbnail } };
          })
        );
      })
      .catch((error) => {
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  thumbnail: {
                    status: "failed",
                    message: error instanceof Error ? error.message : "缩略图生成失败"
                  }
                }
              : item
          )
        );
      });
  }, [items, open]);

  function handleModeChange(nextMode: UploadMode) {
    if (submitting || mode === nextMode) return;
    setMode(nextMode);
  }

  function handleSourceUrlChange(value: string) {
    setSourceUrl(value);
    setUrlUpload((current) => {
      revokeThumbnail(current.thumbnail?.generated);
      return { status: "pending" };
    });
  }

  function updateItemFileName(id: string, value: string) {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              fileNameOverride: value,
              status: item.conflict ? "pending" : item.status,
              message: item.conflict ? undefined : item.message,
              progress: item.conflict ? undefined : item.progress,
              conflict: undefined,
              conflictAction: "error"
            }
          : item
      )
    );
  }

  function setItemFileNameEditing(id: string, editing: boolean) {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              editingFileName: editing,
              fileNameOverride: editing && item.fileNameOverride === undefined ? item.file.name : item.fileNameOverride
            }
          : item
      )
    );
  }

  function updateUrlFileName(value: string) {
    setUrlUpload((current) => ({
      ...current,
      fileNameOverride: value,
      status: current.conflict ? "pending" : current.status,
      message: current.conflict ? undefined : current.message,
      progress: current.conflict ? undefined : current.progress,
      conflict: undefined,
      conflictAction: "error"
    }));
  }

  function resolveItemConflict(id: string, action: FileNameConflictAction) {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id || !item.conflict) return item;

        const fileName = action === "overwrite" ? item.conflict.fileName : item.conflict.suggestedName;
        return {
          ...item,
          status: "pending",
          message: action === "overwrite" ? "将覆盖当前目录中的同名文件索引" : undefined,
          progress: undefined,
          retry: undefined,
          fileNameOverride: fileName,
          editingFileName: false,
          conflict: undefined,
          conflictAction: action
        };
      })
    );
  }

  function resolveUrlConflict(action: FileNameConflictAction) {
    setUrlUpload((current) => {
      if (!current.conflict) return current;

      const fileName = action === "overwrite" ? current.conflict.fileName : current.conflict.suggestedName;
      return {
        ...current,
        status: "pending",
        message: action === "overwrite" ? "将覆盖当前目录中的同名文件索引" : undefined,
        progress: undefined,
        retry: undefined,
        fileNameOverride: fileName,
        editingFileName: false,
        conflict: undefined,
        conflictAction: action
      };
    });
  }

  function setUrlFileNameEditing(editing: boolean) {
    setUrlUpload((current) => ({
      ...current,
      editingFileName: editing,
      fileNameOverride: editing && current.fileNameOverride === undefined && normalizedSourceUrl
        ? remoteFileLabel(normalizedSourceUrl)
        : current.fileNameOverride
    }));
  }

  function extractFirstUrl(value: string): string | undefined {
    const match = value.match(/https?:\/\/[^\s<>"']+/i);
    return match?.[0];
  }

  function validateSourceUrl(value: string): string | undefined {
    const normalized = value.trim();

    if (!normalized) {
      return "请粘贴要上传的 URL";
    }

    try {
      const url = new URL(normalized);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "仅支持 http/https URL";
      }
    } catch {
      return "请输入完整的 URL，例如 https://example.com/file.pdf";
    }

    return undefined;
  }

  function startUploadTask(kind: "local" | "url", itemId?: string): UploadAbortContext {
    abortUploadTask(activeUploadRef.current);

    const task: UploadAbortContext = {
      kind,
      ...(itemId ? { itemId } : {}),
      abortController: new AbortController(),
      controllers: new Set(),
      cancelled: false
    };

    activeUploadRef.current = task;
    setActiveUploadKind(kind);
    setActiveUploadItemId(itemId ?? null);
    setStopRequested(false);
    return task;
  }

  function finishUploadTask(task: UploadAbortContext) {
    if (activeUploadRef.current !== task) {
      return;
    }

    activeUploadRef.current = null;
    setActiveUploadKind(null);
    setActiveUploadItemId(null);
    setStopRequested(false);
  }

  function stopCurrentUpload() {
    const task = activeUploadRef.current;
    if (!task || task.cancelled) {
      return;
    }

    task.cancelled = true;
    setStopRequested(true);
    abortUploadTask(task);

    if (task.kind === "local" && task.itemId) {
      updateItemProgress(task.itemId, {
        completed: currentItemCompletedChunks(task.itemId),
        total: currentItemChunkCount(task.itemId),
        label: "正在停止上传，保留已完成分片"
      });
    } else if (task.kind === "url") {
      setUrlUpload((current) => ({
        ...current,
        progress: current.progress
          ? { ...current.progress, label: "正在停止导入，保留已完成分片" }
          : { completed: 0, total: 1, label: "正在停止导入" }
      }));
    }
  }

  function currentItemCompletedChunks(id: string): number {
    return items.find((item) => item.id === id)?.chunks?.filter((chunk) => chunk.status === "completed").length ?? 0;
  }

  function currentItemChunkCount(id: string): number {
    return items.find((item) => item.id === id)?.chunks?.length ?? 1;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (mode === "url") {
      await submitUrlUpload();
      return;
    }
    if (items.length === 0) {
      onError("请选择要上传的文件");
      return;
    }
    const targets = items.filter((item) => item.status === "pending" || item.status === "error");
    if (targets.length === 0) {
      onClose();
      return;
    }

    setSubmitting(true);
    let successCount = 0;

    for (const target of targets) {
      if (target.file.size > maxMultipartBytes) {
        const message = `文件大小不能超过 ${formatCompactBytes(maxMultipartBytes)}（当前 ${formatCompactBytes(target.file.size)}）`;
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? { ...item, status: "error", message }
              : item
          )
        );
        onError(message);
        continue;
      }

      setItems((current) =>
        current.map((item) =>
          item.id === target.id
            ? { ...item, status: "uploading", message: undefined, progress: undefined, conflict: undefined }
            : item
        )
      );

      const task = startUploadTask("local", target.id);
      try {
        const fileName = effectiveFileName(target);
        const thumbnail = await resolveLocalThumbnailForUpload(target);
        await uploadLocalMultipart(target, fileName, thumbnail, task);
        successCount += 1;
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: "done",
                  message: undefined,
                  progress: undefined,
                  retry: undefined,
                  conflict: undefined,
                  conflictAction: "error",
                  editingFileName: false
                }
              : item
          )
        );
      } catch (error) {
        const retry = error instanceof MultipartChunkUploadError ? error.retry : undefined;
        const stopped = (error instanceof MultipartChunkUploadError && error.stopped) || task.cancelled || isAbortError(error);
        const conflict = fileNameConflictFromError(error);
        const message = stopped ? "已停止" : error instanceof ApiError ? error.message : error instanceof Error ? error.message : "上传失败";
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: "error",
                  message: conflict ? undefined : message,
                  retry: conflict ? undefined : retry,
                  conflict,
                  fileNameOverride: conflict?.suggestedName ?? item.fileNameOverride,
                  conflictAction: "error",
                  editingFileName: conflict ? true : item.editingFileName,
                  progress: retry && !conflict
                    ? retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片上传失败，可手动重试")
                    : undefined
                }
              : item
          )
        );
        if (!stopped) {
          onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
        }
        if (stopped) {
          break;
        }
      } finally {
        finishUploadTask(task);
      }
    }

    setSubmitting(false);
    if (successCount > 0) {
      onUploaded(successCount);
    }
  }

  async function uploadLocalMultipart(
    target: QueueItem,
    fileName: string,
    thumbnail: ThumbnailUploadPayload | undefined,
    task: UploadAbortContext
  ) {
    if (target.retry?.kind === "local") {
      await retryLocalMultipart(target, target.retry, thumbnail, task);
      return;
    }

    const conflictAction = target.conflictAction ?? "error";
    const init = await initMultipartUpload({
      file_name: fileName,
      mime_type: target.file.type || "application/octet-stream",
      size: target.file.size,
      directory_path: uploadDirectoryPath,
      ...(conflictAction !== "error" ? { on_conflict: conflictAction } : {}),
      ...(remark.trim() ? { remark: remark.trim() } : {})
    }, task.abortController.signal);
    const upload = init.upload;

    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? { ...item, chunks: createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count) }
          : item
      )
    );

    const result = await runConcurrentChunks({
      total: upload.chunk_count,
      taskLabel: "上传分片",
      doneLabel: "已上传",
      task,
      requestTimeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS,
      onProgress: (progress) => updateItemProgress(target.id, progress),
      onChunkState: (index, patch) => updateItemChunk(target.id, index, patch),
      onChunk: async (index, signal) => {
        const start = index * upload.chunk_size;
        const end = Math.min(target.file.size, start + upload.chunk_size);
        await uploadMultipartChunk(upload.id, index, target.file.slice(start, end), signal);
      }
    });

    if (result.failedChunks.length > 0 || result.cancelled) {
      const retry = await refreshMultipartRetryState({
        kind: "local",
        uploadId: upload.id,
        size: upload.size,
        chunkSize: upload.chunk_size,
        chunkCount: upload.chunk_count,
        directAccess: upload.direct_access !== false,
        conflictAction,
        completedChunks: result.completedChunks,
        failedChunks: result.failedChunks
      });
      throw new MultipartChunkUploadError(
        result.cancelled ? "已停止，可重试未完成分片" : `有 ${result.failedChunks.length} 个分片上传失败，可手动重试`,
        retry,
        result.cancelled
      );
    }

    updateItemProgress(target.id, {
      completed: upload.chunk_count,
      total: upload.chunk_count,
      label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
    });
    await completeUploadOrRetryLater({
      kind: "local",
      uploadId: upload.id,
      size: upload.size,
      chunkSize: upload.chunk_size,
      chunkCount: upload.chunk_count,
      directAccess: upload.direct_access !== false,
      conflictAction,
      thumbnail,
      task,
      timeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS
    });
  }

  async function resolveLocalThumbnailForUpload(target: QueueItem): Promise<ThumbnailUploadPayload | undefined> {
    if (target.thumbnail?.status === "ready" && target.thumbnail.generated) {
      return thumbnailPayload(target.thumbnail.generated);
    }

    if (target.thumbnail?.status === "removed" || !canAutoGenerateThumbnail(target.file)) {
      return undefined;
    }

    try {
      updateItemThumbnail(target.id, { status: "generating", message: "正在生成缩略图" });
      const generated = await generateThumbnailFromFile(target.file);
      updateItemThumbnail(target.id, { status: "ready", generated });
      return thumbnailPayload(generated);
    } catch (error) {
      updateItemThumbnail(target.id, {
        status: "failed",
        message: error instanceof Error ? error.message : "缩略图生成失败"
      });
      return undefined;
    }
  }

  async function resolveUrlThumbnailForUpload(source: MultipartUpload["thumbnail_source"] | undefined): Promise<ThumbnailUploadPayload | undefined> {
    if (urlUpload.thumbnail?.status === "ready" && urlUpload.thumbnail.generated) {
      return thumbnailPayload(urlUpload.thumbnail.generated);
    }

    if (urlUpload.thumbnail?.status === "removed" || !source?.available) {
      return undefined;
    }

    try {
      updateUrlThumbnail({ status: "generating", message: "正在生成 URL 缩略图" });
      const generated = await generateThumbnailFromRemoteSource({
        kind: source.kind,
        url: source.url,
        mime_type: source.mime_type
      }, remoteFileLabel(normalizedSourceUrl));
      updateUrlThumbnail({ status: "ready", generated });
      return thumbnailPayload(generated);
    } catch (error) {
      updateUrlThumbnail({
        status: "failed",
        message: error instanceof Error ? error.message : "URL 缩略图生成失败"
      });
      return undefined;
    }
  }

  async function retryLocalMultipart(
    target: QueueItem,
    retry: MultipartRetryState,
    thumbnail: ThumbnailUploadPayload | undefined,
    task: UploadAbortContext
  ) {
    const syncedRetry = await refreshMultipartRetryState(retry);
    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? { ...item, chunks: prepareRetryChunks(item.chunks, syncedRetry), retry: syncedRetry }
          : item
      )
    );

    const result = await runConcurrentChunks({
      total: syncedRetry.chunkCount,
      chunkIndexes: syncedRetry.failedChunks,
      completedChunks: syncedRetry.completedChunks,
      taskLabel: "重试上传分片",
      doneLabel: "已上传",
      task,
      requestTimeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS,
      onProgress: (progress) => updateItemProgress(target.id, progress),
      onChunkState: (index, patch) => updateItemChunk(target.id, index, patch),
      onChunk: async (index, signal) => {
        const start = index * syncedRetry.chunkSize;
        const end = Math.min(target.file.size, start + syncedRetry.chunkSize);
        await uploadMultipartChunk(syncedRetry.uploadId, index, target.file.slice(start, end), signal);
      }
    });

    if (result.failedChunks.length > 0 || result.cancelled) {
      const nextRetry = await refreshMultipartRetryState({
        ...syncedRetry,
        completedChunks: result.completedChunks,
        failedChunks: result.failedChunks
      });
      throw new MultipartChunkUploadError(
        result.cancelled ? "已停止，可重试未完成分片" : `仍有 ${result.failedChunks.length} 个分片上传失败，可继续手动重试`,
        nextRetry,
        result.cancelled
      );
    }

    updateItemProgress(target.id, {
      completed: syncedRetry.chunkCount,
      total: syncedRetry.chunkCount,
      label: syncedRetry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
    });
    await completeUploadOrRetryLater({
      ...syncedRetry,
      thumbnail,
      task,
      timeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS
    });
  }

  async function runConcurrentChunks(params: {
    total: number;
    chunkIndexes?: number[];
    completedChunks?: number[];
    taskLabel: string;
    doneLabel: string;
    concurrency?: number;
    task: UploadAbortContext;
    requestTimeoutMs: number;
    onChunk: (index: number, signal: AbortSignal) => Promise<void>;
    onProgress: (progress: ChunkProgress) => void;
    onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void;
  }): Promise<ChunkQueueResult> {
    const chunkIndexes = params.chunkIndexes ?? chunkRange(params.total);
    const completedSet = new Set(params.completedChunks ?? []);
    const failedChunks: number[] = [];
    const concurrency = Math.min(params.concurrency ?? MULTIPART_UPLOAD_CONCURRENCY, Math.max(1, chunkIndexes.length));
    let nextIndex = 0;

    const suffix = concurrency > 1 ? `（${concurrency} 并发）` : "";
    params.onProgress({
      completed: completedSet.size,
      total: params.total,
      label: `${params.taskLabel} ${completedSet.size}/${params.total}${suffix}`
    });

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        if (params.task.cancelled) {
          break;
        }

        const queueIndex = nextIndex;
        nextIndex += 1;

        if (queueIndex >= chunkIndexes.length) {
          break;
        }

        const index = chunkIndexes[queueIndex];

        try {
          await uploadChunkWithRetry({
            ...params,
            index,
            suffix,
            completed: () => completedSet.size
          });
          completedSet.add(index);
        } catch (error) {
          failedChunks.push(index);
        }

        params.onProgress({
          completed: completedSet.size,
          total: params.total,
          failed: failedChunks.length,
          label: failedChunks.length > 0
            ? `${params.doneLabel} ${completedSet.size}/${params.total}，失败 ${failedChunks.length} 个${suffix}`
            : `${params.doneLabel} ${completedSet.size}/${params.total}${suffix}`
        });
      }
    });

    await Promise.all(workers);

    if (params.task.cancelled) {
      for (const index of chunkIndexes) {
        if (!completedSet.has(index)) {
          failedChunks.push(index);
          params.onChunkState?.(index, {
            status: "failed",
            errorMessage: "已停止"
          });
        }
      }
    }

    return {
      completedChunks: Array.from(completedSet).sort((left, right) => left - right),
      failedChunks: Array.from(new Set(failedChunks)).sort((left, right) => left - right),
      cancelled: params.task.cancelled
    };
  }

  async function uploadChunkWithRetry(params: {
    index: number;
    total: number;
    taskLabel: string;
    task: UploadAbortContext;
    requestTimeoutMs: number;
    onChunk: (index: number, signal: AbortSignal) => Promise<void>;
    onProgress: (progress: ChunkProgress) => void;
    onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void;
    suffix: string;
    completed: () => number;
  }) {
    for (let attempt = 1; attempt <= MULTIPART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (params.task.cancelled) {
        params.onChunkState?.(params.index, {
          status: "failed",
          attempts: Math.max(1, attempt - 1),
          errorMessage: "已停止"
        });
        throw new Error("已停止");
      }

      params.onChunkState?.(params.index, {
        status: "uploading",
        attempts: attempt,
        errorMessage: undefined
      });
      params.onProgress({
        completed: params.completed(),
        total: params.total,
        label: attempt === 1
          ? `${params.taskLabel} ${params.index + 1}/${params.total}${params.suffix}`
          : `重试分片 ${params.index + 1}/${params.total}（第 ${attempt}/${MULTIPART_UPLOAD_MAX_ATTEMPTS} 次）${params.suffix}`
      });

      try {
        await runAbortableUploadRequest(params.task, params.requestTimeoutMs, (signal) => params.onChunk(params.index, signal));
        params.onChunkState?.(params.index, {
          status: "completed",
          attempts: attempt,
          errorMessage: undefined
        });
        return;
      } catch (error) {
        if (params.task.cancelled) {
          params.onChunkState?.(params.index, {
            status: "failed",
            attempts: attempt,
            errorMessage: "已停止"
          });
          throw new Error("已停止");
        }

        const canRetry = attempt < MULTIPART_UPLOAD_MAX_ATTEMPTS && isRetryableChunkUploadError(error);
        if (!canRetry) {
          params.onChunkState?.(params.index, {
            status: "failed",
            attempts: attempt,
            errorMessage: errorMessage(error)
          });
          throw new Error(`分片 ${params.index + 1} 处理失败：${errorMessage(error)}`);
        }

        await delay(retryDelayMs(attempt, error), params.task.abortController.signal);
      }
    }
  }

  async function runAbortableUploadRequest<T>(
    task: UploadAbortContext,
    timeoutMs: number,
    request: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromTask = () => controller.abort();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    task.controllers.add(controller);
    task.abortController.signal.addEventListener("abort", abortFromTask, { once: true });

    try {
      if (task.cancelled || task.abortController.signal.aborted) {
        controller.abort();
      }

      return await request(controller.signal);
    } finally {
      window.clearTimeout(timeoutId);
      task.controllers.delete(controller);
      task.abortController.signal.removeEventListener("abort", abortFromTask);
    }
  }

  async function completeUploadOrRetryLater(params: Omit<MultipartRetryState, "completedChunks" | "failedChunks"> & {
    thumbnail?: ThumbnailUploadPayload;
    task: UploadAbortContext;
    timeoutMs: number;
  }) {
    const retry: MultipartRetryState = {
      kind: params.kind,
      uploadId: params.uploadId,
      size: params.size,
      chunkSize: params.chunkSize,
      chunkCount: params.chunkCount,
      directAccess: params.directAccess,
      conflictAction: params.conflictAction,
      completedChunks: chunkRange(params.chunkCount),
      failedChunks: []
    };

    try {
      await runAbortableUploadRequest(params.task, params.timeoutMs, (signal) =>
        completeMultipartUpload(params.uploadId, params.thumbnail, signal, params.conflictAction)
      );
    } catch (error) {
      if (params.task.cancelled || isAbortError(error)) {
        throw new MultipartChunkUploadError(
          params.task.cancelled ? "已停止，可继续完成上传" : "生成文件索引超时，可继续完成上传",
          retry,
          params.task.cancelled
        );
      }
      throw error;
    }
  }

  async function refreshMultipartRetryState(retry: MultipartRetryState): Promise<MultipartRetryState> {
    try {
      const status = await getMultipartUploadStatus(retry.uploadId);
      if (status.upload.source_kind !== retry.kind) {
        return retry;
      }

      return {
        ...retry,
        size: status.upload.size,
        chunkSize: status.upload.chunk_size,
        chunkCount: status.upload.chunk_count,
        directAccess: status.upload.direct_access !== false,
        completedChunks: status.uploaded_chunks,
        failedChunks: status.missing_chunks
      };
    } catch {
      return retry;
    }
  }

  function updateItemProgress(id: string, progress: ChunkProgress) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, progress } : item)));
  }

  function updateItemChunk(id: string, chunkIndex: number, patch: Partial<UploadChunkState>) {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              chunks: updateChunkStates(item.chunks, chunkIndex, patch)
            }
          : item
      )
    );
  }

  function updateUrlChunk(chunkIndex: number, patch: Partial<UploadChunkState>) {
    setUrlUpload((current) => ({
      ...current,
      chunks: updateChunkStates(current.chunks, chunkIndex, patch)
    }));
  }

  async function submitUrlUpload() {
    if (urlUpload.retry?.kind === "url") {
      await retryUrlMultipart(urlUpload.retry);
      return;
    }

    const error = validateSourceUrl(sourceUrl);
    if (error) {
      setUrlUpload({ status: "error", message: error });
      onError(error);
      return;
    }

    const task = startUploadTask("url");
    setSubmitting(true);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: undefined,
      conflict: undefined,
      progress: { completed: 0, total: 1, label: "探测远程文件" }
    }));

    try {
      const fileNameOverride = normalizedFileNameOverride(urlUpload.fileNameOverride);
      const conflictAction = urlUpload.conflictAction ?? "error";
      const init = await initUrlMultipartUpload(
        normalizedSourceUrl,
        remark.trim() || undefined,
        uploadDirectoryPath,
        true,
        fileNameOverride,
        conflictAction,
        task.abortController.signal
      );
      if (init.mode === "multipart" && init.upload) {
        const upload = init.upload;
        const thumbnail = await resolveUrlThumbnailForUpload(upload.thumbnail_source);
        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          chunks: createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count)
        }));
        const result = await runConcurrentChunks({
          total: upload.chunk_count,
          taskLabel: "导入分片",
          doneLabel: "已导入",
          concurrency: URL_MULTIPART_UPLOAD_CONCURRENCY,
          task,
          requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
          onProgress: (progress) => {
            setUrlUpload((current) => ({
              ...current,
              status: "uploading",
              progress
            }));
          },
          onChunkState: updateUrlChunk,
          onChunk: async (index, signal) => {
            await uploadUrlMultipartChunk(upload.id, index, signal);
          }
        });

        if (result.failedChunks.length > 0 || result.cancelled) {
          const retry = await refreshMultipartRetryState({
            kind: "url",
            uploadId: upload.id,
            size: upload.size,
            chunkSize: upload.chunk_size,
            chunkCount: upload.chunk_count,
            directAccess: upload.direct_access !== false,
            conflictAction,
            completedChunks: result.completedChunks,
            failedChunks: result.failedChunks
          });
          throw new MultipartChunkUploadError(
            result.cancelled ? "已停止，可重试未完成分片" : `有 ${result.failedChunks.length} 个分片导入失败，可手动重试`,
            retry,
            result.cancelled
          );
        }

        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          progress: {
            completed: upload.chunk_count,
            total: upload.chunk_count,
            label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
          }
        }));
        await completeUploadOrRetryLater({
          kind: "url",
          uploadId: upload.id,
          size: upload.size,
          chunkSize: upload.chunk_size,
          chunkCount: upload.chunk_count,
          directAccess: upload.direct_access !== false,
          conflictAction,
          thumbnail,
          task,
          timeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS
        });
      } else {
        throw new ApiError(500, "URL 上传初始化未返回分片会话", "InvalidUploadMode");
      }
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "已从 URL 上传",
        progress: undefined,
        retry: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false
      }));
      onUploaded(1);
    } catch (uploadError) {
      const retry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : undefined;
      const stopped = (uploadError instanceof MultipartChunkUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
      const conflict = fileNameConflictFromError(uploadError);
      const message = stopped
        ? "已停止"
        : uploadError instanceof ApiError
          ? uploadError.message
          : uploadError instanceof Error
            ? uploadError.message
            : "URL 上传失败";
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message: conflict ? undefined : message,
        retry: conflict ? undefined : retry,
        conflict,
        fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
        conflictAction: "error",
        editingFileName: conflict ? true : current.editingFileName,
        progress: retry && !conflict
          ? retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片导入失败，可手动重试")
          : undefined
      }));
      if (!stopped) {
        onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  async function retryUrlMultipart(retry: MultipartRetryState) {
    const task = startUploadTask("url");
    const syncedRetry = await refreshMultipartRetryState(retry);
    setSubmitting(true);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      progress: retryFailureProgress(syncedRetry, "准备重试失败分片"),
      chunks: prepareRetryChunks(current.chunks, syncedRetry),
      retry: syncedRetry
    }));

    try {
      const result = await runConcurrentChunks({
        total: syncedRetry.chunkCount,
        chunkIndexes: syncedRetry.failedChunks,
        completedChunks: syncedRetry.completedChunks,
        taskLabel: "重试导入分片",
        doneLabel: "已导入",
        concurrency: URL_MULTIPART_UPLOAD_CONCURRENCY,
        task,
        requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
        onProgress: (progress) => {
          setUrlUpload((current) => ({
            ...current,
            status: "uploading",
            progress,
            retry: syncedRetry
          }));
        },
        onChunkState: updateUrlChunk,
        onChunk: async (index, signal) => {
          await uploadUrlMultipartChunk(syncedRetry.uploadId, index, signal);
        }
      });

      if (result.failedChunks.length > 0 || result.cancelled) {
        const nextRetry = await refreshMultipartRetryState({
          ...syncedRetry,
          completedChunks: result.completedChunks,
          failedChunks: result.failedChunks
        });
        throw new MultipartChunkUploadError(
          result.cancelled ? "已停止，可重试未完成分片" : `仍有 ${result.failedChunks.length} 个分片导入失败，可继续手动重试`,
          nextRetry,
          result.cancelled
        );
      }

      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: {
          completed: syncedRetry.chunkCount,
          total: syncedRetry.chunkCount,
          label: syncedRetry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
        }
      }));
      const thumbnail = urlUpload.thumbnail?.status === "ready" && urlUpload.thumbnail.generated
        ? thumbnailPayload(urlUpload.thumbnail.generated)
        : undefined;
      await completeUploadOrRetryLater({
        ...syncedRetry,
        thumbnail,
        task,
        timeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS
      });
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "已从 URL 上传",
        progress: undefined,
        retry: undefined,
        conflictAction: "error",
        editingFileName: false
      }));
      onUploaded(1);
    } catch (uploadError) {
      const nextRetry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : syncedRetry;
      const stopped = (uploadError instanceof MultipartChunkUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
      const message = stopped ? "已停止" : uploadError instanceof Error ? uploadError.message : "URL 分片重试失败";
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message,
        retry: nextRetry,
        progress: retryFailureProgress(nextRetry, stopped ? "已停止，可重试未完成分片" : "分片导入失败，可手动重试")
      }));
      if (!stopped) {
        onError(message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  async function retryItemFailedChunks(id: string) {
    if (submitting) return;

    const target = items.find((item) => item.id === id);
    if (!target?.retry || target.retry.kind !== "local") {
      return;
    }

    const task = startUploadTask("local", id);
    setSubmitting(true);
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? { ...item, status: "uploading", message: undefined, progress: retryFailureProgress(target.retry!, "准备重试失败分片") }
          : item
      )
    );

    try {
      const thumbnail = await resolveLocalThumbnailForUpload(target);
      await retryLocalMultipart(target, target.retry, thumbnail, task);
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "done",
                message: undefined,
                progress: undefined,
                retry: undefined,
                conflictAction: "error",
                editingFileName: false
              }
            : item
        )
      );
      onUploaded(1);
    } catch (error) {
      const retry = error instanceof MultipartChunkUploadError ? error.retry : target.retry;
      const stopped = (error instanceof MultipartChunkUploadError && error.stopped) || task.cancelled || isAbortError(error);
      const message = stopped ? "已停止" : error instanceof Error ? error.message : "分片重试失败";
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "error",
                message,
                retry,
                progress: retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片上传失败，可手动重试")
              }
            : item
        )
      );
      if (!stopped) {
        onError(message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  function handleDropFiles(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    addFiles(files);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="上传文件"
      description={`上传到 ${uploadDirectoryPath}；所有文件统一按 ${formatBytes(multipartChunkBytes)} 分片上传，单文件上限 ${formatBytes(maxMultipartBytes)}，最多 ${MULTIPART_UPLOAD_CONCURRENCY} 分片并发`}
      size="lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          {activeUploadKind ? (
            <Button
              variant="danger-ghost"
              disabled={stopRequested}
              leadingIcon={<X size={15} />}
              onClick={stopCurrentUpload}
            >
              {stopRequested
                ? "正在停止"
                : activeUploadKind === "url"
                  ? "停止导入"
                  : "停止上传"}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            {hasDone ? "关闭" : "取消"}
          </Button>
          <Button
            type="submit"
            form="upload-form"
            variant="primary"
            loading={submitting}
            leadingIcon={mode === "url" ? <Link2 size={16} /> : <FilePlus2 size={16} />}
            disabled={pendingCount === 0 || hasInvalidFileName || hasUnresolvedConflict}
          >
            {submitting
              ? mode === "url" ? "导入中" : "上传中"
              : hasInvalidFileName
                ? "文件名不能为空"
                : hasUnresolvedConflict
                  ? "请选择处理方式"
                : pendingCount > 0
                  ? mode === "url" ? "上传 URL" : `开始上传 ${pendingCount} 个`
                  : "无待传文件"}
          </Button>
        </>
      }
    >
      <form id="upload-form" className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex items-center justify-between gap-3">
          <Segmented<UploadMode>
            value={mode}
            onChange={handleModeChange}
            ariaLabel="上传方式"
            options={[
              { value: "file", label: "本地文件", icon: <UploadCloud size={15} /> },
              { value: "url", label: "URL 链接", icon: <Link2 size={15} /> }
            ]}
          />
          <span className="hidden text-xs text-muted sm:inline">统一分片上传</span>
        </div>
        <div className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs leading-5 text-muted">
          本地文件和 URL 导入都会先创建上传会话，再上传或导入分片，最后统一生成文件索引。图片/视频会尝试生成缩略图；失败时不影响文件上传。
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted">
              上传目录
            </label>
            {directoriesLoading ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <Spinner size={12} />
                加载目录
              </span>
            ) : null}
          </div>
          <DirectoryTreeSelect
            ariaLabel="选择上传目录"
            value={uploadDirectoryPath}
            directories={directoryOptions}
            disabled={submitting}
            onChange={setUploadDirectoryPath}
          />
          <p className="text-xs leading-5 text-muted">
            默认使用当前文件列表目录；这里只影响本次上传，不会切换控制台当前目录。
          </p>
        </div>

        {mode === "file" ? (
          <>
            <label
              onDragEnter={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDropFiles}
              className={cn(
                "relative grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed bg-background px-6 py-8 text-center transition-colors duration-150",
                dragOver
                  ? "border-primary bg-primary-soft text-primary-strong"
                  : "border-border hover:border-primary/60 hover:bg-primary-soft/40"
              )}
            >
              <span className="grid size-12 place-items-center rounded-2xl bg-primary-soft text-primary-strong">
                <UploadCloud size={22} />
              </span>
              <p className="text-sm font-medium text-foreground">点击选择文件，或拖拽到这里</p>
              <p className="text-xs text-muted">
                统一按 {formatBytes(multipartChunkBytes)} 分片，最多 {MULTIPART_UPLOAD_CONCURRENCY} 并发，每片最多 {MULTIPART_UPLOAD_MAX_ATTEMPTS} 次
              </p>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={handlePick}
              />
            </label>

            {items.length > 0 ? (
              <div className="flex max-h-[32rem] flex-col gap-2 overflow-auto scroll-thin">
                {items.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    onRemove={() => removeItem(item.id)}
                    onRetry={item.retry ? () => void retryItemFailedChunks(item.id) : undefined}
                    onStop={activeUploadKind === "local" && activeUploadItemId === item.id ? stopCurrentUpload : undefined}
                    stopping={stopRequested && activeUploadKind === "local" && activeUploadItemId === item.id}
                    onFileNameChange={(value) => updateItemFileName(item.id, value)}
                    onFileNameEditingChange={(editing) => setItemFileNameEditing(item.id, editing)}
                    onRenameConflict={item.conflict ? () => resolveItemConflict(item.id, "error") : undefined}
                    onOverwriteConflict={item.conflict ? () => resolveItemConflict(item.id, "overwrite") : undefined}
                    onThumbnailChange={(file) => void handleManualItemThumbnail(item.id, file)}
                    onThumbnailRemove={() => removeItemThumbnail(item.id)}
                    disabled={submitting}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="upload-source-url" className="text-xs font-medium text-muted">
                粘贴文件 URL
              </label>
              <Input
                id="upload-source-url"
                type="url"
                placeholder="https://example.com/report.pdf"
                value={sourceUrl}
                disabled={submitting}
                invalid={urlUpload.status === "error"}
                leadingIcon={<ClipboardPaste size={15} />}
                onChange={(event) => handleSourceUrlChange(event.target.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  const pastedUrl = extractFirstUrl(pasted);
                  if (pastedUrl) {
                    event.preventDefault();
                    handleSourceUrlChange(pastedUrl);
                  }
                }}
              />
              <p className="text-xs leading-5 text-muted">
                URL 导入统一要求远端支持 Range，并按 {formatBytes(multipartChunkBytes)} 分片导入；图片/视频 URL 会尝试通过同源代理生成缩略图。
              </p>
            </div>

            {normalizedSourceUrl ? (
              <UrlUploadRow
                url={normalizedSourceUrl}
                status={urlUpload.status}
                message={urlUpload.message}
                progress={urlUpload.progress}
                chunks={urlUpload.chunks}
                fileNameOverride={urlUpload.fileNameOverride}
                editingFileName={urlUpload.editingFileName}
                conflict={urlUpload.conflict}
                onClear={() => handleSourceUrlChange("")}
                onRetry={urlUpload.retry ? () => void retryUrlMultipart(urlUpload.retry!) : undefined}
                onStop={activeUploadKind === "url" ? stopCurrentUpload : undefined}
                stopping={stopRequested && activeUploadKind === "url"}
                onFileNameChange={updateUrlFileName}
                onFileNameEditingChange={setUrlFileNameEditing}
                onRenameConflict={urlUpload.conflict ? () => resolveUrlConflict("error") : undefined}
                onOverwriteConflict={urlUpload.conflict ? () => resolveUrlConflict("overwrite") : undefined}
                thumbnail={urlUpload.thumbnail}
                onThumbnailChange={(file) => void handleManualUrlThumbnail(file)}
                onThumbnailRemove={removeUrlThumbnail}
                disabled={submitting}
              />
            ) : null}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="upload-remark" className="text-xs font-medium text-muted">
            备注（可选 · 应用于本次所有文件）
          </label>
          <Textarea
            id="upload-remark"
            placeholder="补充说明，便于后续检索"
            value={remark}
            maxLength={1000}
            onChange={(event) => setRemark(event.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}

function abortUploadTask(task: UploadAbortContext | null) {
  if (!task) {
    return;
  }

  task.cancelled = true;
  task.abortController.abort();
  for (const controller of task.controllers) {
    controller.abort();
  }
  task.controllers.clear();
}

function isRetryableChunkUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }

  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (isAbortError(error)) {
    return "请求已中止或超时";
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "上传失败";
}

function retryDelayMs(failedAttempt: number, error: unknown): number {
  const retryAfterSeconds = error instanceof ApiError
    ? Number(error.details?.telegram_retry_after_seconds)
    : Number.NaN;

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5 * 60 * 1000);
  }

  return MULTIPART_UPLOAD_RETRY_DELAY_MS * failedAttempt;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function effectiveFileName(item: QueueItem): string {
  return normalizedFileNameOverride(item.fileNameOverride) ?? item.file.name;
}

function normalizedFileNameOverride(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function thumbnailPayload(thumbnail: GeneratedThumbnail): ThumbnailUploadPayload {
  return {
    blob: thumbnail.blob,
    fileName: thumbnail.fileName,
    ...(thumbnail.width ? { width: thumbnail.width } : {}),
    ...(thumbnail.height ? { height: thumbnail.height } : {})
  };
}

function fileNameConflictFromError(error: unknown): FileNameConflictState | undefined {
  if (!(error instanceof ApiError) || error.status !== 409 || error.error !== "FileNameConflict") {
    return undefined;
  }

  const fileName = stringDetail(error.details, "file_name") || "同名文件";
  return {
    fileName,
    suggestedName: stringDetail(error.details, "suggested_name") || suggestAlternativeFileName(fileName),
    directoryPath: stringDetail(error.details, "directory_path") || "/"
  };
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function suggestAlternativeFileName(fileName: string): string {
  const match = /^(.*?)(\.[^./\\]{1,12})$/.exec(fileName);
  const base = match?.[1] || fileName;
  const extension = match?.[2] || "";

  return `${base} (1)${extension}`;
}

function chunkRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function retryFailureProgress(retry: MultipartRetryState, label: string): ChunkProgress {
  return {
    completed: retry.completedChunks.length,
    total: retry.chunkCount,
    failed: retry.failedChunks.length,
    label: `${label}（失败 ${retry.failedChunks.length} 个）`
  };
}

function createUploadChunkStates(size: number, chunkSize: number, chunkCount: number): UploadChunkState[] {
  return Array.from({ length: chunkCount }, (_, index) => ({
    index,
    size: expectedUploadChunkSize(size, chunkSize, chunkCount, index),
    status: "queued",
    attempts: 0
  }));
}

function prepareRetryChunks(chunks: UploadChunkState[] | undefined, retry: MultipartRetryState): UploadChunkState[] {
  const failed = new Set(retry.failedChunks);
  const completed = new Set(retry.completedChunks);
  const source = chunks ?? createUploadChunkStates(retry.size, retry.chunkSize, retry.chunkCount);

  return source.map((chunk) => {
    if (completed.has(chunk.index)) {
      return { ...chunk, status: "completed", errorMessage: undefined };
    }
    if (failed.has(chunk.index)) {
      return { ...chunk, status: "queued", errorMessage: undefined };
    }
    return chunk;
  });
}

function updateChunkStates(
  chunks: UploadChunkState[] | undefined,
  chunkIndex: number,
  patch: Partial<UploadChunkState>
): UploadChunkState[] | undefined {
  if (!chunks) {
    return chunks;
  }

  return chunks.map((chunk) => (chunk.index === chunkIndex ? { ...chunk, ...patch } : chunk));
}

function expectedUploadChunkSize(size: number, chunkSize: number, chunkCount: number, chunkIndex: number): number {
  return chunkIndex === chunkCount - 1 ? size - chunkSize * chunkIndex : chunkSize;
}

interface QueueRowProps {
  item: QueueItem;
  onRemove: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailRemove: () => void;
  disabled: boolean;
}

function QueueRow({
  item,
  onRemove,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailRemove,
  disabled
}: QueueRowProps) {
  const status = item.status;
  const fileName = item.fileNameOverride ?? item.file.name;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <UploadThumbnailVisual
          thumbnail={item.thumbnail}
          fallback={<FileTypeIcon mimeType={item.file.type || "application/octet-stream"} fileName={item.file.name} size="sm" />}
        />
        <div className="min-w-0 flex-1">
          <EditableFileName
            value={fileName}
            originalValue={item.file.name}
            editing={Boolean(item.editingFileName)}
            conflict={item.conflict}
            disabled={disabled || status === "uploading" || status === "done"}
            onChange={onFileNameChange}
            onEditingChange={onFileNameEditingChange}
          />
          <p className="truncate text-xs text-muted">
            {formatBytes(item.file.size)} · 分片上传
            {thumbnailHint(item.thumbnail) ? <span> · {thumbnailHint(item.thumbnail)}</span> : null}
            {item.message ? <span className="text-danger"> · {item.message}</span> : null}
          </p>
          {item.progress ? <ProgressBar progress={item.progress} /> : null}
          <ConflictResolutionActions
            conflict={item.conflict}
            disabled={disabled}
            onRename={onRenameConflict}
            onOverwrite={onOverwriteConflict}
          />
        </div>
        <ThumbnailPicker
          disabled={disabled || status === "uploading"}
          onChange={onThumbnailChange}
          onRemove={onThumbnailRemove}
          hasThumbnail={item.thumbnail?.status === "ready"}
        />
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="shrink-0 rounded-md border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {item.retry?.failedChunks.length === 0 ? "继续完成上传" : "重试失败分片"}
          </button>
        ) : null}
        {onStop && status === "uploading" ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="shrink-0 rounded-md border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {stopping ? "正在停止" : "停止上传"}
          </button>
        ) : null}
        <StatusBadge status={status} multipart={Boolean(item.progress)} />
        <button
          type="button"
          aria-label="移除"
          onClick={onRemove}
          disabled={disabled || status === "uploading"}
          className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {status === "done" ? <CheckCircle2 size={14} className="text-success" /> : <X size={14} />}
        </button>
      </div>
      {item.chunks ? <UploadChunkList chunks={item.chunks} /> : null}
    </div>
  );
}

interface UrlUploadRowProps {
  url: string;
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  onClear: () => void;
  chunks?: UploadChunkState[];
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  thumbnail?: UploadThumbnailState;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailRemove: () => void;
  disabled: boolean;
}

function UrlUploadRow({
  url,
  status,
  message,
  progress,
  chunks,
  fileNameOverride,
  editingFileName,
  conflict,
  thumbnail,
  onClear,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailRemove,
  disabled
}: UrlUploadRowProps) {
  const fileName = fileNameOverride ?? remoteFileLabel(url);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <UploadThumbnailVisual
          thumbnail={thumbnail}
          fallback={
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
              <Link2 size={16} />
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <EditableFileName
            value={fileName}
            originalValue={remoteFileLabel(url)}
            editing={Boolean(editingFileName)}
            conflict={conflict}
            disabled={disabled || status === "uploading" || status === "done"}
            onChange={onFileNameChange}
            onEditingChange={onFileNameEditingChange}
          />
          <p className="truncate text-xs text-muted">
            {url}
            {thumbnailHint(thumbnail) ? <span> · {thumbnailHint(thumbnail)}</span> : null}
            {message ? <span className={status === "error" ? "text-danger" : "text-success"}> · {message}</span> : null}
          </p>
          {progress ? <ProgressBar progress={progress} /> : null}
          <ConflictResolutionActions
            conflict={conflict}
            disabled={disabled}
            onRename={onRenameConflict}
            onOverwrite={onOverwriteConflict}
          />
        </div>
        <ThumbnailPicker
          disabled={disabled || status === "uploading"}
          onChange={onThumbnailChange}
          onRemove={onThumbnailRemove}
          hasThumbnail={thumbnail?.status === "ready"}
        />
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="shrink-0 rounded-md border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {progress && progress.failed === 0 ? "继续完成上传" : "重试失败分片"}
          </button>
        ) : null}
        {onStop && status === "uploading" ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="shrink-0 rounded-md border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {stopping ? "正在停止" : "停止导入"}
          </button>
        ) : null}
        <StatusBadge status={status} multipart={Boolean(progress)} />
        <button
          type="button"
          aria-label="清空 URL"
          onClick={onClear}
          disabled={disabled || status === "uploading"}
          className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {status === "done" ? <CheckCircle2 size={14} className="text-success" /> : <X size={14} />}
        </button>
      </div>
      {chunks ? <UploadChunkList chunks={chunks} /> : null}
    </div>
  );
}

function ConflictResolutionActions({
  conflict,
  disabled,
  onRename,
  onOverwrite
}: {
  conflict?: FileNameConflictState;
  disabled: boolean;
  onRename?: () => void;
  onOverwrite?: () => void;
}) {
  if (!conflict) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-warning/35 bg-warning-soft/50 px-2.5 py-2 text-xs leading-5 text-warning sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0">
        当前目录 <span className="font-semibold">{conflict.directoryPath}</span> 已存在{" "}
        <span className="font-semibold">{conflict.fileName}</span>
      </span>
      <span className="flex shrink-0 flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onRename}
          disabled={disabled || !onRename}
          className="rounded-md border border-warning/35 bg-surface px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-50"
        >
          重命名为 {conflict.suggestedName}
        </button>
        <button
          type="button"
          onClick={onOverwrite}
          disabled={disabled || !onOverwrite}
          className="rounded-md border border-danger/30 px-2.5 py-1 font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-50"
        >
          覆盖原文件
        </button>
      </span>
    </div>
  );
}

function UploadThumbnailVisual({
  thumbnail,
  fallback
}: {
  thumbnail?: UploadThumbnailState;
  fallback: ReactNode;
}) {
  if (thumbnail?.status === "ready" && thumbnail.generated) {
    return (
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-background ring-1 ring-border">
        <img
          src={thumbnail.generated.objectUrl}
          alt="缩略图"
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  if (thumbnail?.status === "generating") {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong ring-1 ring-primary/15">
        <Spinner size={16} />
      </span>
    );
  }

  return <>{fallback}</>;
}

function ThumbnailPicker({
  disabled,
  onChange,
  onRemove,
  hasThumbnail
}: {
  disabled: boolean;
  onChange: (file: File) => void;
  onRemove: () => void;
  hasThumbnail: boolean;
}) {
  return (
    <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
      <label
        className={cn(
          "grid size-7 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong",
          disabled && "pointer-events-none opacity-40"
        )}
        title={hasThumbnail ? "更换缩略图" : "选择缩略图"}
      >
        <ImagePlus size={14} />
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChange(file);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {hasThumbnail ? (
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          disabled={disabled}
          title="移除缩略图"
          onClick={onRemove}
        >
          <ImageOff size={14} />
        </button>
      ) : null}
    </span>
  );
}

function thumbnailHint(thumbnail: UploadThumbnailState | undefined): string | undefined {
  if (!thumbnail) return undefined;

  switch (thumbnail.status) {
    case "generating":
      return thumbnail.message || "正在生成缩略图";
    case "ready":
      return thumbnail.generated?.source === "manual" ? "手动缩略图" : "已生成缩略图";
    case "failed":
      return thumbnail.message || "缩略图失败";
    case "removed":
      return "不使用缩略图";
    default:
      return undefined;
  }
}

function EditableFileName({
  value,
  originalValue,
  editing,
  conflict,
  disabled,
  onChange,
  onEditingChange
}: {
  value: string;
  originalValue: string;
  editing: boolean;
  conflict?: FileNameConflictState;
  disabled: boolean;
  onChange: (value: string) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const isEditing = editing;
  const isEmpty = value.trim().length === 0;
  const displayValue = normalizedFileNameOverride(value) ?? originalValue;
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cancelValue = useRef(value);
  const wasEditing = useRef(isEditing);

  useEffect(() => {
    if (isEditing && !wasEditing.current) {
      cancelValue.current = value;
    }
    if (!isEditing) {
      cancelValue.current = value;
    }
    wasEditing.current = isEditing;
  }, [isEditing, value]);

  useEffect(() => {
    if (!isEditing || disabled) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [disabled, isEditing]);

  function startEditing() {
    if (disabled) return;
    cancelValue.current = value;
    onEditingChange(true);
  }

  function saveEditing() {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (normalized !== value || conflict) {
      onChange(normalized);
    }
    onEditingChange(false);
  }

  function cancelEditing() {
    if (conflict) {
      closeOnBlur();
      return;
    }
    onChange(cancelValue.current);
    onEditingChange(false);
  }

  function closeOnBlur() {
    const normalized = value.trim();

    if (normalized) {
      if (normalized !== value || conflict) {
        onChange(normalized);
      }
      onEditingChange(false);
      return;
    }

    onChange(conflict?.suggestedName || originalValue);
    onEditingChange(false);
  }

  if (!isEditing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          title={displayValue === originalValue ? displayValue : `${displayValue}（默认：${originalValue}）`}
        >
          {displayValue}
        </span>
        {!disabled ? (
          <button
            type="button"
            aria-label="编辑文件名"
            title="编辑文件名"
            onClick={startEditing}
            className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong focus-visible:outline-none focus-visible:focus-ring"
          >
            <Pencil size={13} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={editorRef}
      className="flex min-w-0 flex-col gap-1"
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) {
          return;
        }
        closeOnBlur();
      }}
    >
      <div
        className={cn(
          "flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg border bg-background px-2 transition-[border-color,box-shadow] duration-150",
          "focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--color-primary-ring)]",
          isEmpty ? "border-danger" : conflict ? "border-warning/45" : "border-border hover:border-border-strong"
        )}
      >
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={conflict?.suggestedName || originalValue}
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-subtle disabled:opacity-60"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveEditing();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
        />
        <button
          type="button"
          aria-label="确认文件名"
          title="确认文件名"
          disabled={disabled || isEmpty}
          onClick={saveEditing}
          className="grid size-6 shrink-0 place-items-center rounded-md text-success transition-colors hover:bg-success-soft disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:focus-ring"
        >
          <Check size={13} />
        </button>
        {!conflict ? (
          <button
            type="button"
            aria-label="取消编辑文件名"
            title="取消编辑"
            disabled={disabled}
            onClick={cancelEditing}
            className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:focus-ring"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      {isEmpty ? <p className="text-xs leading-5 text-danger">文件名不能为空。</p> : null}
    </div>
  );
}

function UploadChunkList({ chunks }: { chunks: UploadChunkState[] }) {
  const completed = chunks.filter((chunk) => chunk.status === "completed").length;
  const failed = chunks.filter((chunk) => chunk.status === "failed").length;
  const uploading = chunks.filter((chunk) => chunk.status === "uploading").length;

  return (
    <div className="rounded-lg border border-border bg-background/70 p-2">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>
          分片明细：{completed}/{chunks.length} 完成
          {uploading > 0 ? ` · ${uploading} 上传中` : ""}
          {failed > 0 ? ` · ${failed} 失败` : ""}
        </span>
        <span>每片状态实时更新</span>
      </div>
      <div className="grid max-h-40 gap-1 overflow-auto pr-1 scroll-thin sm:grid-cols-2">
        {chunks.map((chunk) => (
          <div
            key={chunk.index}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
              chunk.status === "completed" && "border-success/25 bg-success-soft text-success",
              chunk.status === "failed" && "border-danger/25 bg-danger-soft text-danger",
              chunk.status === "uploading" && "border-primary/25 bg-primary-soft text-primary-strong",
              chunk.status === "queued" && "border-border bg-surface text-muted"
            )}
            title={chunk.errorMessage}
          >
            <ChunkStatusIcon status={chunk.status} />
            <span className="shrink-0 font-medium">#{chunk.index + 1}</span>
            <span className="min-w-0 flex-1 truncate">
              {chunkStatusLabel(chunk.status)}
              {chunk.attempts > 0 ? ` · 第 ${chunk.attempts} 次` : ""}
              {chunk.errorMessage ? ` · ${chunk.errorMessage}` : ""}
            </span>
            <span className="shrink-0 opacity-70">{formatBytes(chunk.size)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChunkStatusIcon({ status }: { status: UploadChunkStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={13} className="shrink-0" />;
    case "failed":
      return <Trash2 size={13} className="shrink-0" />;
    case "uploading":
      return <Spinner size={12} className="shrink-0" />;
    default:
      return <span className="size-2 shrink-0 rounded-full bg-current opacity-35" />;
  }
}

function chunkStatusLabel(status: UploadChunkStatus): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "uploading":
      return "上传中";
    default:
      return "等待中";
  }
}

function ProgressBar({ progress }: { progress: ChunkProgress }) {
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{progress.label}</span>
        <span>{percent}%{progress.failed ? ` · 失败 ${progress.failed}` : ""}</span>
      </div>
    </div>
  );
}

function remoteFileLabel(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : url.hostname;
  } catch {
    return "远程文件";
  }
}

function StatusBadge({ status, multipart }: { status: ItemStatus; multipart?: boolean }) {
  switch (status) {
    case "uploading":
      return multipart ? <Layers3 size={15} className="text-primary-strong" /> : <Spinner size={14} className="text-primary-strong" />;
    case "done":
      return <CheckCircle2 size={16} className="text-success" />;
    case "error":
      return <Trash2 size={14} className="text-danger" />;
    case "skipped":
      return <span className="text-xs text-muted">跳过</span>;
    default:
      return <span className="text-xs text-muted">待上传</span>;
  }
}
