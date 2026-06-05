import { ChangeEvent, FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, ClipboardPaste, FilePlus2, FolderOpen, FolderTree, ImageOff, ImagePlus, Layers3, Link2, Pencil, Trash2, UploadCloud, X } from "lucide-react";
import {
  ApiError,
  cancelHlsUpload,
  completeHlsSegment,
  completeHlsUpload,
  completeMultipartUpload,
  getHlsUploadStatus,
  getMultipartUploadStatus,
  importHlsSegment,
  importHlsSegmentChunk,
  initMultipartUpload,
  initHlsUpload,
  initUrlMultipartUpload,
  listDirectories,
  preflightUploads,
  probeHlsUpload,
  uploadMultipartChunk,
  uploadUrlMultipartChunk,
  type DirectoryItem,
  type FileNameConflictAction,
  type HlsAsset,
  type HlsProbeInfo,
  type HlsSegment,
  type MultipartUpload,
  type SourceRequestHeaders,
  type ThumbnailUploadPayload,
  type UploadPreflightResultEntry
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
import { parseCurlCommand } from "../../lib/curl";
import {
  canAutoGenerateThumbnail,
  generateThumbnailFromFile,
  generateThumbnailFromHlsPlaylist,
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

interface DroppedFileEntry {
  file: File;
  relativePath?: string;
}

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

interface HlsRetryState {
  assetId: string;
  fileName: string;
  segmentCount: number;
  previewPlaylistUrl: string;
  conflictAction: FileNameConflictAction;
  completedSegments: number[];
  failedSegments: number[];
}

interface HlsUrlState {
  probe?: HlsProbeInfo;
  variantId?: string;
  assetId?: string;
  segmentCount?: number;
  previewPlaylistUrl?: string;
  retry?: HlsRetryState;
}

interface FileNameConflictState {
  fileName: string;
  suggestedName: string;
  directoryPath: string;
  source?: "file" | "batch";
  message?: string;
}

interface QueueItem {
  id: string;
  file: File;
  relativePath?: string;
  relativeDirectoryPath?: string;
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
  chunksExpanded?: boolean;
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
  hls?: HlsUrlState;
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
const HLS_SEGMENT_UPLOAD_CONCURRENCY = 3;
const MULTIPART_UPLOAD_MAX_ATTEMPTS = 3;
const MULTIPART_UPLOAD_RETRY_DELAY_MS = 800;
const LOCAL_CHUNK_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const URL_CHUNK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const HLS_SEGMENT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
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

class HlsSegmentUploadError extends Error {
  constructor(
    message: string,
    public readonly retry: HlsRetryState,
    public readonly stopped = false
  ) {
    super(message);
    this.name = "HlsSegmentUploadError";
  }
}

function makeItem(file: File, options: { relativePath?: string } = {}): QueueItem {
  counter += 1;
  const relativePath = normalizeRelativePath(options.relativePath);
  const relativeDirectoryPath = relativeDirectoryPathFor(relativePath);

  return {
    id: `${Date.now()}-${counter}`,
    file,
    ...(relativePath ? { relativePath } : {}),
    ...(relativeDirectoryPath ? { relativeDirectoryPath } : {}),
    status: "pending",
    thumbnail: canAutoGenerateThumbnail(file) ? { status: "idle" } : undefined
  };
}

function isLocalItemAwaitingDecision(item: QueueItem): boolean {
  return item.status === "pending" || item.status === "error";
}

function isUploadableLocalItem(item: QueueItem): boolean {
  return isLocalItemAwaitingDecision(item) && !item.conflict;
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
  const [sourceHeadersText, setSourceHeadersText] = useState("");
  const [curlImportOpen, setCurlImportOpen] = useState(false);
  const [curlImportText, setCurlImportText] = useState("");
  const [curlImportError, setCurlImportError] = useState<string>();
  const [urlUpload, setUrlUpload] = useState<UrlUploadState>({ status: "pending" });
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadDirectoryPath, setUploadDirectoryPath] = useState(directoryPath);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [directoriesLoading, setDirectoriesLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const onErrorRef = useRef(onError);
  const activeUploadRef = useRef<UploadAbortContext | null>(null);
  const urlUploadRef = useRef(urlUpload);
  const hlsThumbnailPromiseRef = useRef<Promise<GeneratedThumbnail | undefined> | null>(null);
  const hlsThumbnailGeneratingRef = useRef(false);
  const [activeUploadKind, setActiveUploadKind] = useState<"local" | "url" | null>(null);
  const [activeUploadItemId, setActiveUploadItemId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, [mode, open]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    urlUploadRef.current = urlUpload;
  }, [urlUpload]);

  useEffect(() => {
    if (!open) {
      abortUploadTask(activeUploadRef.current);
      activeUploadRef.current = null;
      hlsThumbnailGeneratingRef.current = false;
      hlsThumbnailPromiseRef.current = null;
      setActiveUploadKind(null);
      setActiveUploadItemId(null);
      setStopRequested(false);
      setItems((current) => {
        current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
        return [];
      });
      setUrlUpload((current) => {
        cleanupTemporaryHlsUpload(current);
        revokeThumbnail(current.thumbnail?.generated);
        return { status: "pending" };
      });
      setMode("file");
      setSourceUrl("");
      setSourceHeadersText("");
      setCurlImportOpen(false);
      setCurlImportText("");
      setCurlImportError(undefined);
      setRemark("");
      setSubmitting(false);
      setCheckingConflicts(false);
      setDragOver(false);
      setUploadDirectoryPath(directoryPath);
      return;
    }
    setMode("file");
    setUploadDirectoryPath(directoryPath);
    setItems((current) => {
      current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
      return initialFiles.map((file) => makeItem(file));
    });
    setSourceUrl("");
    setSourceHeadersText("");
    setCurlImportOpen(false);
    setCurlImportText("");
    setCurlImportError(undefined);
    setUrlUpload((current) => {
      cleanupTemporaryHlsUpload(current);
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
    setItems((current) => [...current, ...files.map((file) => makeItem(file))]);
  }, []);

  const addFolderFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setMode("file");
    setItems((current) => [
      ...current,
      ...files.map((file) => makeItem(file, { relativePath: browserRelativePath(file) }))
    ]);
  }, []);

  const addDroppedFiles = useCallback((entries: DroppedFileEntry[]) => {
    if (entries.length === 0) return;
    setMode("file");
    setItems((current) => [
      ...current,
      ...entries.map((entry) => makeItem(entry.file, { relativePath: entry.relativePath }))
    ]);
  }, []);

  const handlePick = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    addFiles(Array.from(list));
    event.target.value = "";
  };

  const handlePickFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    addFolderFiles(Array.from(list));
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

  const uploadBusy = submitting || checkingConflicts;
  const filePendingCount = items.filter(isUploadableLocalItem).length;
  const folderItemCount = items.filter((item) => item.relativePath).length;
  const conflictItemCount = items.filter((item) =>
    isLocalItemAwaitingDecision(item) && Boolean(item.conflict)
  ).length;
  const normalizedSourceUrl = sourceUrl.trim();
  const urlPendingCount = normalizedSourceUrl && urlUpload.status !== "uploading" && urlUpload.status !== "done" ? 1 : 0;
  const pendingCount = mode === "url" ? urlPendingCount : filePendingCount;
  const hasUnresolvedConflict = mode === "url"
    ? Boolean(urlUpload.conflict)
    : items.some((item) => isLocalItemAwaitingDecision(item) && Boolean(item.conflict));
  const hasInvalidFileName = mode === "url"
    ? Boolean(
        normalizedSourceUrl &&
        (urlUpload.editingFileName || urlUpload.conflict) &&
        urlUpload.fileNameOverride !== undefined &&
        urlUpload.fileNameOverride.trim().length === 0
      )
    : items.some((item) =>
        isLocalItemAwaitingDecision(item) &&
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
    if (uploadBusy || mode === nextMode) return;
    setMode(nextMode);
  }

  function handleSourceUrlChange(value: string) {
    setSourceUrl(value);
    setUrlUpload((current) => {
      cleanupTemporaryHlsUpload(current);
      revokeThumbnail(current.thumbnail?.generated);
      hlsThumbnailGeneratingRef.current = false;
      hlsThumbnailPromiseRef.current = null;
      return { status: "pending" };
    });
  }

  function handleSourceHeadersChange(value: string) {
    setSourceHeadersText(value);
    setUrlUpload((current) => {
      if (current.status === "uploading" || current.status === "done") {
        return current;
      }

      const shouldResetRemoteState = current.retry || current.hls || current.thumbnail;
      if (!shouldResetRemoteState) {
        return current;
      }

      cleanupTemporaryHlsUpload(current);
      revokeThumbnail(current.thumbnail?.generated);
      hlsThumbnailGeneratingRef.current = false;
      hlsThumbnailPromiseRef.current = null;

      return {
        ...current,
        message: undefined,
        progress: undefined,
        chunks: undefined,
        retry: undefined,
        conflict: undefined,
        thumbnail: undefined,
        hls: undefined
      };
    });
  }

  function openCurlImport() {
    setCurlImportError(undefined);
    setCurlImportOpen(true);
  }

  function closeCurlImport() {
    setCurlImportOpen(false);
    setCurlImportError(undefined);
  }

  function applyCurlImport() {
    try {
      const parsed = parseCurlCommand(curlImportText);
      const headerResult = sourceHeadersTextFromCurlHeaders(parsed.headers);

      if (headerResult.text) {
        parseSourceHeadersText(headerResult.text);
      }

      handleSourceUrlChange(parsed.url);
      handleSourceHeadersChange(headerResult.text);
      setMode("url");
      setCurlImportOpen(false);
      setCurlImportError(undefined);

      const warnings = [...parsed.warnings];
      if (headerResult.skippedHeaders.length > 0) {
        warnings.push(`已忽略 ${headerResult.skippedHeaders.length} 个不支持的请求头：${headerResult.skippedHeaders.join("、")}`);
      }

      setUrlUpload((current) => ({
        ...current,
        status: current.status === "error" ? "pending" : current.status,
        message: curlImportSummary(headerResult.headerCount, warnings),
        progress: undefined
      }));
    } catch (error) {
      setCurlImportError(errorMessage(error));
    }
  }

  function handleUploadDirectoryPathChange(path: string) {
    setUploadDirectoryPath(path);
    setItems((current) =>
      current.map((item) => {
        if (!item.conflict) return item;

        const usingSuggestedName = item.fileNameOverride === item.conflict.suggestedName;
        return {
          ...item,
          status: "pending",
          message: undefined,
          progress: undefined,
          conflict: undefined,
          conflictAction: "error",
          editingFileName: false,
          fileNameOverride: usingSuggestedName ? undefined : item.fileNameOverride
        };
      })
    );
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
          message: undefined,
          progress: undefined,
          retry: undefined,
          fileNameOverride: fileName === item.file.name ? undefined : fileName,
          editingFileName: false,
          conflict: undefined,
          conflictAction: action
        };
      })
    );
  }

  function skipItemConflict(id: string) {
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      revokeThumbnail(target?.thumbnail?.generated);
      return current.filter((item) => item.id !== id);
    });
  }

  function resolveAllItemConflicts(action: "overwrite" | "skip") {
    setItems((current) => {
      if (action === "skip") {
        current.forEach((item) => {
          if (item.conflict && isLocalItemAwaitingDecision(item)) {
            revokeThumbnail(item.thumbnail?.generated);
          }
        });
        return current.filter((item) => !item.conflict || !isLocalItemAwaitingDecision(item));
      }

      return current.map((item) => {
        if (!item.conflict || !isLocalItemAwaitingDecision(item)) {
          return item;
        }

        return {
          ...item,
          status: "pending",
          message: undefined,
          progress: undefined,
          retry: undefined,
          fileNameOverride: item.conflict.fileName === item.file.name ? undefined : item.conflict.fileName,
          editingFileName: false,
          conflict: undefined,
          conflictAction: "overwrite"
        };
      });
    });
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

  function selectHlsVariant(variantId: string) {
    setUrlUpload((current) => ({
      ...current,
      status: "pending",
      message: "已选择 HLS variant，点击上传开始导入",
      progress: undefined,
      chunks: undefined,
      hls: {
        ...(current.hls?.probe ? { probe: current.hls.probe } : {}),
        variantId
      }
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

  function readSourceHeadersForUpload(): { ok: true; headers?: SourceRequestHeaders } | { ok: false } {
    try {
      const headers = parseSourceHeadersText(sourceHeadersText);
      return headers ? { ok: true, headers } : { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message,
        progress: undefined
      }));
      onError(message);
      return { ok: false };
    }
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

  async function preflightLocalItems(targets: QueueItem[]): Promise<boolean> {
    const entries = targets
      .filter((item) => !item.retry && (item.conflictAction ?? "error") === "error")
      .map((item) => ({
        client_id: item.id,
        directory_path: effectiveDirectoryPath(item, uploadDirectoryPath),
        file_name: effectiveFileName(item),
        ...(item.relativePath ? { relative_path: item.relativePath } : {}),
        size: item.file.size
      }));

    if (entries.length === 0) {
      return true;
    }

    setCheckingConflicts(true);
    try {
      const response = await preflightUploads(entries);
      const conflicts = response.entries.filter((entry) => entry.status === "conflict");

      if (conflicts.length === 0) {
        return true;
      }

      const conflictById = new Map(conflicts.map((entry) => [entry.client_id, entry]));
      setItems((current) =>
        current.map((item) => {
          const conflict = conflictById.get(item.id);
          if (!conflict) return item;

          return {
            ...item,
            status: "error",
            message: undefined,
            progress: undefined,
            retry: undefined,
            conflict: fileNameConflictFromPreflight(conflict),
            fileNameOverride: conflict.file_name === item.file.name ? undefined : conflict.file_name,
            conflictAction: "error",
            editingFileName: false
          };
        })
      );
      onError(`发现 ${conflicts.length} 个同名文件，请选择覆盖、忽略或单项改名`);
      return false;
    } catch (error) {
      onError(`重复检测失败：${errorMessage(error)}`);
      return false;
    } finally {
      setCheckingConflicts(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (uploadBusy) return;
    if (mode === "url") {
      await submitUrlUpload();
      return;
    }
    if (items.length === 0) {
      onError("请选择要上传的文件");
      return;
    }
    const targets = items.filter(isUploadableLocalItem);
    if (targets.length === 0) {
      onClose();
      return;
    }

    if (!(await preflightLocalItems(targets))) {
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
                  fileNameOverride: conflict
                    ? conflict.fileName === item.file.name ? undefined : conflict.fileName
                    : item.fileNameOverride,
                  conflictAction: "error",
                  editingFileName: conflict ? false : item.editingFileName,
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
      directory_path: effectiveDirectoryPath(target, uploadDirectoryPath),
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

  function updateUrlChunkFromHlsSegment(segment: HlsSegment, missingChunks: number[]) {
    updateUrlChunk(segment.segment_index, {
      size: segment.size ?? 0,
      status: hlsSegmentChunkStatus(segment),
      attempts: segment.attempts,
      errorMessage: hlsSegmentChunkMessage(segment, missingChunks)
    });
  }

  function toggleItemChunks(id: string) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, chunksExpanded: !item.chunksExpanded } : item))
    );
  }

  async function submitUrlUpload() {
    if (urlUpload.hls?.retry) {
      await retryHlsUpload(urlUpload.hls.retry);
      return;
    }

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

    const sourceHeadersResult = readSourceHeadersForUpload();
    if (!sourceHeadersResult.ok) {
      return;
    }
    const sourceHeaders = sourceHeadersResult.headers;

    if (isLikelyHlsUrl(normalizedSourceUrl) || urlUpload.hls?.probe) {
      await submitHlsUpload(sourceHeaders);
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
        sourceHeaders,
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

  async function submitHlsUpload(sourceHeaders?: SourceRequestHeaders) {
    const error = validateSourceUrl(sourceUrl);
    if (error) {
      setUrlUpload({ status: "error", message: error });
      onError(error);
      return;
    }

    const task = startUploadTask("url");
    let completionRetry: HlsRetryState | undefined;

    setSubmitting(true);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: undefined,
      retry: undefined,
      conflict: undefined,
      progress: { completed: 0, total: 1, label: "探测 HLS 播放列表" }
    }));

    try {
      let probe = urlUpload.hls?.probe;
      let variantId = urlUpload.hls?.variantId;

      if (!probe || (probe.kind === "master" && variantId && probe.selected_variant_id !== variantId)) {
        probe = (await probeHlsUpload(normalizedSourceUrl, variantId, sourceHeaders, task.abortController.signal)).hls;
      }

      if (probe.kind === "master" && !probe.media) {
        if (probe.variants.length === 1) {
          variantId = probe.variants[0]?.id;
          probe = (await probeHlsUpload(normalizedSourceUrl, variantId, sourceHeaders, task.abortController.signal)).hls;
        } else if (!variantId) {
          setUrlUpload((current) => ({
            ...current,
            status: "pending",
            message: "检测到多码率 HLS，请先选择一个 variant",
            progress: undefined,
            chunks: undefined,
            hls: { probe }
          }));
          return;
        } else {
          probe = (await probeHlsUpload(normalizedSourceUrl, variantId, sourceHeaders, task.abortController.signal)).hls;
        }
      }

      if (probe.kind === "master" && !probe.media) {
        throw new Error("请选择一个可导入的 HLS variant");
      }

      const selectedVariantId = probe.kind === "master"
        ? probe.selected_variant_id ?? variantId
        : undefined;
      const fileName = normalizedFileNameOverride(urlUpload.fileNameOverride) ?? probe.file_name;
      const conflictAction = urlUpload.conflictAction ?? "error";

      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        message: hlsProbeSummary(probe),
        progress: { completed: 0, total: probe.media?.segment_count ?? 1, label: "创建 HLS 上传任务" },
        hls: {
          probe,
          ...(selectedVariantId ? { variantId: selectedVariantId } : {})
        }
      }));

      const init = await initHlsUpload({
        url: normalizedSourceUrl,
        ...(selectedVariantId ? { variant_id: selectedVariantId } : {}),
        file_name: fileName,
        directory_path: uploadDirectoryPath,
        ...(sourceHeaders ? { headers: sourceHeaders } : {}),
        ...(remark.trim() ? { remark: remark.trim() } : {}),
        ...(conflictAction !== "error" ? { on_conflict: conflictAction } : {})
      }, task.abortController.signal);
      const asset = init.hls.asset;
      const segments = init.hls.segments;
      const previewPlaylistUrl = sameOriginAdminUrl(asset.preview_playlist_url);

      completionRetry = hlsRetryFromStatus(asset, segments, conflictAction);
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        message: `HLS 视频 · ${asset.segment_count} 个片段`,
        chunks: createHlsSegmentStates(segments),
        progress: { completed: 0, total: asset.segment_count, label: `开始导入 HLS 片段（${HLS_SEGMENT_UPLOAD_CONCURRENCY} 并发）` },
        hls: {
          probe,
          assetId: asset.id,
          segmentCount: asset.segment_count,
          previewPlaylistUrl,
          ...(selectedVariantId ? { variantId: selectedVariantId } : {})
        }
      }));

      const result = await runConcurrentChunks({
        total: asset.segment_count,
        taskLabel: "导入 HLS 片段",
        doneLabel: "已导入 HLS 片段",
        concurrency: HLS_SEGMENT_UPLOAD_CONCURRENCY,
        task,
        requestTimeoutMs: HLS_SEGMENT_REQUEST_TIMEOUT_MS,
        onProgress: (progress) => {
          setUrlUpload((current) => ({
            ...current,
            status: "uploading",
            progress
          }));
        },
        onChunkState: updateUrlChunk,
        onChunk: async (index, signal) => {
          await uploadHlsSegmentFully(asset.id, index, previewPlaylistUrl, asset.file_name, signal);
        }
      });

      if (result.failedChunks.length > 0 || result.cancelled) {
        const retry = await refreshHlsRetryState({
          ...completionRetry,
          completedSegments: result.completedChunks,
          failedSegments: result.failedChunks
        });
        throw new HlsSegmentUploadError(
          result.cancelled ? "已停止，可重试未完成 HLS 片段" : `有 ${result.failedChunks.length} 个 HLS 片段导入失败，可手动重试`,
          retry,
          result.cancelled
        );
      }

      completionRetry = await refreshHlsRetryState({
        ...completionRetry,
        completedSegments: chunkRange(asset.segment_count),
        failedSegments: []
      });
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: { completed: asset.segment_count, total: asset.segment_count, label: "正在生成 HLS 文件索引" }
      }));
      const thumbnail = await resolveHlsThumbnailForUpload(previewPlaylistUrl, asset.file_name);
      await runAbortableUploadRequest(task, HLS_SEGMENT_REQUEST_TIMEOUT_MS, (signal) =>
        completeHlsUpload(asset.id, thumbnail, signal, conflictAction)
      );
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "已导入 HLS 视频",
        progress: undefined,
        retry: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false,
        hls: current.hls ? withoutHlsRetry(current.hls) : current.hls
      }));
      onUploaded(1);
    } catch (uploadError) {
      const retry = uploadError instanceof HlsSegmentUploadError ? uploadError.retry : completionRetry;
      const stopped = (uploadError instanceof HlsSegmentUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
      const conflict = fileNameConflictFromError(uploadError);
      const message = stopped
        ? "已停止"
        : uploadError instanceof ApiError
          ? uploadError.message
          : uploadError instanceof Error
            ? uploadError.message
            : "HLS 上传失败";

      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message: conflict ? undefined : message,
        retry: undefined,
        conflict,
        fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
        conflictAction: "error",
        editingFileName: conflict ? true : current.editingFileName,
        progress: retry && !conflict
          ? hlsRetryFailureProgress(retry, stopped ? "已停止，可重试未完成 HLS 片段" : "HLS 片段导入失败，可手动重试")
          : undefined,
        hls: retry
          ? {
              ...(current.hls ?? {}),
              assetId: retry.assetId,
              segmentCount: retry.segmentCount,
              previewPlaylistUrl: retry.previewPlaylistUrl,
              retry
            }
          : current.hls
      }));
      if (!stopped) {
        onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  async function retryHlsUpload(retry: HlsRetryState) {
    const task = startUploadTask("url");
    const conflictAction = urlUpload.conflictAction ?? retry.conflictAction;
    let syncedRetry = await refreshHlsRetryState({ ...retry, conflictAction });

    setSubmitting(true);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: "准备重试 HLS 片段",
      retry: undefined,
      conflict: undefined,
      progress: hlsRetryFailureProgress(syncedRetry, "准备重试失败 HLS 片段"),
      chunks: prepareHlsRetryChunks(current.chunks, syncedRetry),
      hls: {
        ...(current.hls ?? {}),
        assetId: syncedRetry.assetId,
        segmentCount: syncedRetry.segmentCount,
        previewPlaylistUrl: syncedRetry.previewPlaylistUrl,
        retry: syncedRetry
      }
    }));

    try {
      if (syncedRetry.failedSegments.length > 0) {
        const result = await runConcurrentChunks({
          total: syncedRetry.segmentCount,
          chunkIndexes: syncedRetry.failedSegments,
          completedChunks: syncedRetry.completedSegments,
          taskLabel: "重试 HLS 片段",
          doneLabel: "已导入 HLS 片段",
          concurrency: HLS_SEGMENT_UPLOAD_CONCURRENCY,
          task,
          requestTimeoutMs: HLS_SEGMENT_REQUEST_TIMEOUT_MS,
          onProgress: (progress) => {
            setUrlUpload((current) => ({
              ...current,
              status: "uploading",
              progress
            }));
          },
          onChunkState: updateUrlChunk,
          onChunk: async (index, signal) => {
            await uploadHlsSegmentFully(syncedRetry.assetId, index, syncedRetry.previewPlaylistUrl, syncedRetry.fileName, signal);
          }
        });

        if (result.failedChunks.length > 0 || result.cancelled) {
          const nextRetry = await refreshHlsRetryState({
            ...syncedRetry,
            completedSegments: result.completedChunks,
            failedSegments: result.failedChunks
          });
          throw new HlsSegmentUploadError(
            result.cancelled ? "已停止，可重试未完成 HLS 片段" : `仍有 ${result.failedChunks.length} 个 HLS 片段导入失败，可继续手动重试`,
            nextRetry,
            result.cancelled
          );
        }

        syncedRetry = await refreshHlsRetryState({
          ...syncedRetry,
          completedSegments: result.completedChunks,
          failedSegments: []
        });
      }

      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: { completed: syncedRetry.segmentCount, total: syncedRetry.segmentCount, label: "正在生成 HLS 文件索引" }
      }));
      const thumbnail = await resolveHlsThumbnailForUpload(syncedRetry.previewPlaylistUrl, syncedRetry.fileName);
      await runAbortableUploadRequest(task, HLS_SEGMENT_REQUEST_TIMEOUT_MS, (signal) =>
        completeHlsUpload(syncedRetry.assetId, thumbnail, signal, conflictAction)
      );
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "已导入 HLS 视频",
        progress: undefined,
        retry: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false,
        hls: current.hls ? withoutHlsRetry(current.hls) : current.hls
      }));
      onUploaded(1);
    } catch (uploadError) {
      const nextRetry = uploadError instanceof HlsSegmentUploadError ? uploadError.retry : syncedRetry;
      const stopped = (uploadError instanceof HlsSegmentUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
      const conflict = fileNameConflictFromError(uploadError);
      const message = stopped ? "已停止" : uploadError instanceof Error ? uploadError.message : "HLS 片段重试失败";
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message: conflict ? undefined : message,
        retry: undefined,
        conflict,
        fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
        conflictAction: "error",
        editingFileName: conflict ? true : current.editingFileName,
        progress: nextRetry && !conflict
          ? hlsRetryFailureProgress(nextRetry, stopped ? "已停止，可重试未完成 HLS 片段" : "HLS 片段导入失败，可手动重试")
          : undefined,
        hls: {
          ...(current.hls ?? {}),
          assetId: nextRetry.assetId,
          segmentCount: nextRetry.segmentCount,
          previewPlaylistUrl: nextRetry.previewPlaylistUrl,
          retry: nextRetry
        }
      }));
      if (!stopped) {
        onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  async function uploadHlsSegmentFully(
    assetId: string,
    segmentIndex: number,
    previewPlaylistUrl: string,
    fileName: string,
    signal: AbortSignal
  ) {
    let response = await importHlsSegment(assetId, segmentIndex, signal);
    updateUrlChunkFromHlsSegment(response.segment, response.missing_chunks);

    if (response.segment.storage_backend === "telegram_multipart") {
      response = await importHlsSegmentMultipartChunks(assetId, segmentIndex, response, signal);
    }

    if (response.segment.status !== "done") {
      throw new Error(response.segment.error_message || `HLS 片段 ${segmentIndex + 1} 未完成`);
    }

    updateUrlChunkFromHlsSegment(response.segment, []);

    if (segmentIndex === 0) {
      void maybeGenerateHlsThumbnail(previewPlaylistUrl, fileName);
    }
  }

  async function importHlsSegmentMultipartChunks(
    assetId: string,
    segmentIndex: number,
    initialResponse: Awaited<ReturnType<typeof importHlsSegment>>,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<typeof importHlsSegment>>> {
    let response = initialResponse;
    let segment = response.segment;
    const chunkCount = segment.chunk_count ?? Math.max(response.uploaded_chunks.length + response.missing_chunks.length, 1);

    if (!segment.chunk_count || segment.chunk_count <= 0) {
      throw new Error(`HLS 片段 ${segmentIndex + 1} 缺少内部 chunk 信息`);
    }

    for (const chunkIndex of response.missing_chunks) {
      response = await importHlsSegmentChunkWithRetry(assetId, segmentIndex, chunkIndex, chunkCount, response.uploaded_chunks.length, signal);
      segment = response.segment;
      updateUrlChunkFromHlsSegment(segment, response.missing_chunks);
    }

    if (response.missing_chunks.length > 0) {
      throw new Error(`HLS 片段 ${segmentIndex + 1} 仍有 ${response.missing_chunks.length} 个内部 chunk 未完成`);
    }

    updateUrlChunk(segmentIndex, {
      status: "uploading",
      errorMessage: "正在合成大 HLS 片段"
    });
    return completeHlsSegment(assetId, segmentIndex, signal);
  }

  async function importHlsSegmentChunkWithRetry(
    assetId: string,
    segmentIndex: number,
    chunkIndex: number,
    chunkCount: number,
    completedBefore: number,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<typeof importHlsSegmentChunk>>> {
    for (let attempt = 1; attempt <= MULTIPART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      updateUrlChunk(segmentIndex, {
        status: "uploading",
        attempts: attempt,
        errorMessage: `大 HLS 片段内部分片 ${completedBefore + 1}/${chunkCount}（#${chunkIndex + 1}，第 ${attempt}/${MULTIPART_UPLOAD_MAX_ATTEMPTS} 次）`
      });

      try {
        return await importHlsSegmentChunk(assetId, segmentIndex, chunkIndex, signal);
      } catch (error) {
        const canRetry = attempt < MULTIPART_UPLOAD_MAX_ATTEMPTS && isRetryableChunkUploadError(error);
        if (!canRetry) {
          throw new Error(`HLS 片段 ${segmentIndex + 1} 的内部分片 ${chunkIndex + 1} 导入失败：${errorMessage(error)}`);
        }
        await delay(retryDelayMs(attempt, error), signal);
      }
    }

    throw new Error(`HLS 片段 ${segmentIndex + 1} 的内部分片 ${chunkIndex + 1} 导入失败`);
  }

  async function refreshHlsRetryState(retry: HlsRetryState): Promise<HlsRetryState> {
    try {
      const status = await getHlsUploadStatus(retry.assetId);
      return hlsRetryFromStatus(status.hls.asset, status.hls.segments, retry.conflictAction);
    } catch {
      return retry;
    }
  }

  async function maybeGenerateHlsThumbnail(previewPlaylistUrl: string, fileName: string) {
    await startHlsThumbnailGeneration(previewPlaylistUrl, fileName, "正在从首个 HLS 片段生成缩略图");
  }

  async function resolveHlsThumbnailForUpload(previewPlaylistUrl: string, fileName: string): Promise<ThumbnailUploadPayload | undefined> {
    const latest = urlUploadRef.current.thumbnail;

    if (latest?.status === "ready" && latest.generated) {
      return thumbnailPayload(latest.generated);
    }

    if (latest?.status === "removed") {
      return undefined;
    }

    if (hlsThumbnailPromiseRef.current) {
      const generated = await hlsThumbnailPromiseRef.current;
      if (urlUploadRef.current.thumbnail?.status === "removed") {
        return undefined;
      }
      if (generated) {
        return thumbnailPayload(generated);
      }
    }

    const generated = await startHlsThumbnailGeneration(previewPlaylistUrl, fileName, "正在生成 HLS 缩略图");
    if (urlUploadRef.current.thumbnail?.status === "removed") {
      return undefined;
    }
    return generated ? thumbnailPayload(generated) : undefined;
  }

  function startHlsThumbnailGeneration(
    previewPlaylistUrl: string,
    fileName: string,
    message: string
  ): Promise<GeneratedThumbnail | undefined> {
    const latest = urlUploadRef.current.thumbnail;

    if (latest?.status === "ready" && latest.generated) {
      return Promise.resolve(latest.generated);
    }

    if (latest?.status === "removed") {
      return Promise.resolve(undefined);
    }

    if (hlsThumbnailPromiseRef.current) {
      return hlsThumbnailPromiseRef.current;
    }

    hlsThumbnailGeneratingRef.current = true;
    setUrlUpload((current) => {
      if (current.thumbnail?.status === "ready" || current.thumbnail?.status === "removed") {
        return current;
      }
      revokeThumbnail(current.thumbnail?.generated);
      return {
        ...current,
        thumbnail: { status: "generating", message }
      };
    });

    const promise = generateThumbnailFromHlsPlaylist(sameOriginAdminUrl(previewPlaylistUrl), fileName)
      .then((generated) => {
        setUrlUpload((current) => {
          if (current.thumbnail?.status === "removed") {
            revokeThumbnail(generated);
            return current;
          }
          revokeThumbnail(current.thumbnail?.generated);
          return {
            ...current,
            thumbnail: { status: "ready", generated }
          };
        });
        return generated;
      })
      .catch((error) => {
        hlsThumbnailPromiseRef.current = null;
        setUrlUpload((current) => {
          if (current.thumbnail?.status === "removed") {
            return current;
          }
          return {
            ...current,
            thumbnail: {
              status: "failed",
              message: error instanceof Error ? error.message : "HLS 缩略图生成失败"
            }
          };
        });
        return undefined;
      })
      .finally(() => {
        hlsThumbnailGeneratingRef.current = false;
      });

    hlsThumbnailPromiseRef.current = promise;
    return promise;
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
    if (uploadBusy) return;

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

  async function handleDropFiles(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragOver(false);
    try {
      const dropped = await collectDroppedFiles(event.dataTransfer);
      if (dropped.length > 0) {
        addDroppedFiles(dropped);
        return;
      }
    } catch (error) {
      onError(`读取拖拽文件失败：${errorMessage(error)}`);
      return;
    }

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    addFiles(files);
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="上传文件"
        description={`上传到 ${uploadDirectoryPath}；所有文件统一按 ${formatBytes(multipartChunkBytes)} 分片上传，单文件上限 ${formatBytes(maxMultipartBytes)}，最多 ${MULTIPART_UPLOAD_CONCURRENCY} 分片并发`}
        size="lg"
        closeOnBackdrop={!uploadBusy && !curlImportOpen}
        closeOnEscape={!uploadBusy && !curlImportOpen}
        trapFocus={!curlImportOpen}
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
            <Button variant="secondary" disabled={uploadBusy} onClick={onClose}>
              {hasDone ? "关闭" : "取消"}
            </Button>
            <Button
              type="submit"
              form="upload-form"
              variant="primary"
              loading={uploadBusy}
              leadingIcon={mode === "url" ? <Link2 size={16} /> : <FilePlus2 size={16} />}
              disabled={pendingCount === 0 || hasInvalidFileName || hasUnresolvedConflict}
            >
              {checkingConflicts
                ? "检测重复项"
                : submitting
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
            disabled={uploadBusy}
            onChange={handleUploadDirectoryPathChange}
          />
          <p className="text-xs leading-5 text-muted">
            默认使用当前文件列表目录；这里只影响本次上传，不会切换控制台当前目录。
          </p>
        </div>

        {mode === "file" ? (
          <>
            <label
              onDragEnter={(event) => {
                if (uploadBusy) return;
                event.preventDefault();
                setDragOver(true);
              }}
              onDragOver={(event) => {
                if (uploadBusy) return;
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
              <p className="text-sm font-medium text-foreground">点击选择文件，或拖拽文件/文件夹到这里</p>
              <p className="text-xs text-muted">
                统一按 {formatBytes(multipartChunkBytes)} 分片，最多 {MULTIPART_UPLOAD_CONCURRENCY} 并发，每片最多 {MULTIPART_UPLOAD_MAX_ATTEMPTS} 次
              </p>
              <input
                ref={fileInput}
                type="file"
                multiple
                disabled={uploadBusy}
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={handlePick}
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2.5">
              <div className="min-w-0 text-xs leading-5 text-muted">
                <span className="font-medium text-foreground">{items.length}</span> 个文件
                {folderItemCount > 0 ? <span> · {folderItemCount} 个来自文件夹</span> : null}
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={uploadBusy}
                leadingIcon={<FolderOpen size={15} />}
                onClick={() => folderInput.current?.click()}
              >
                选择文件夹
              </Button>
              <input
                ref={folderInput}
                type="file"
                multiple
                disabled={uploadBusy}
                className="hidden"
                onChange={handlePickFolder}
              />
            </div>

            {conflictItemCount > 0 ? (
              <ConflictSummary
                count={conflictItemCount}
                disabled={uploadBusy}
                onOverwriteAll={() => resolveAllItemConflicts("overwrite")}
                onSkipAll={() => resolveAllItemConflicts("skip")}
              />
            ) : null}

            {folderItemCount > 0 ? (
              <FolderUploadTree items={items} baseDirectoryPath={uploadDirectoryPath} />
            ) : null}

            {items.length > 0 ? (
              <div className="flex max-h-[32rem] flex-col gap-2 overflow-auto scroll-thin">
                {items.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    targetDirectoryPath={effectiveDirectoryPath(item, uploadDirectoryPath)}
                    onRemove={() => removeItem(item.id)}
                    onRetry={item.retry ? () => void retryItemFailedChunks(item.id) : undefined}
                    onStop={activeUploadKind === "local" && activeUploadItemId === item.id ? stopCurrentUpload : undefined}
                    stopping={stopRequested && activeUploadKind === "local" && activeUploadItemId === item.id}
                    onFileNameChange={(value) => updateItemFileName(item.id, value)}
                    onFileNameEditingChange={(editing) => setItemFileNameEditing(item.id, editing)}
                    onRenameConflict={item.conflict ? () => resolveItemConflict(item.id, "error") : undefined}
                    onOverwriteConflict={item.conflict ? () => resolveItemConflict(item.id, "overwrite") : undefined}
                    onSkipConflict={item.conflict ? () => skipItemConflict(item.id) : undefined}
                    onThumbnailChange={(file) => void handleManualItemThumbnail(item.id, file)}
                    onThumbnailRemove={() => removeItemThumbnail(item.id)}
                    onToggleChunks={() => toggleItemChunks(item.id)}
                    disabled={uploadBusy}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="upload-source-url" className="text-xs font-medium text-muted">
                  粘贴文件 URL
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<ClipboardPaste size={14} />}
                  disabled={uploadBusy}
                  onClick={openCurlImport}
                >
                  从 cURL 解析
                </Button>
              </div>
              <Input
                id="upload-source-url"
                type="url"
                placeholder="https://example.com/report.pdf"
                value={sourceUrl}
                disabled={uploadBusy}
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

            <div className="flex flex-col gap-1.5">
              <label htmlFor="upload-source-headers" className="text-xs font-medium text-muted">
                请求头（可选）
              </label>
              <Textarea
                id="upload-source-headers"
                rows={3}
                placeholder={"Referer: https://example.com/\nCookie: session=...\nAuthorization: Bearer ..."}
                value={sourceHeadersText}
                disabled={uploadBusy}
                onChange={(event) => handleSourceHeadersChange(event.target.value)}
              />
              <p className="text-xs leading-5 text-muted">
                每行一个 <span className="font-mono">Header-Name: value</span>。Worker 会自动设置 Range；不要填写 Range、Host、Content-Length 等连接控制头。
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
                hls={urlUpload.hls}
                onClear={() => handleSourceUrlChange("")}
                onRetry={
                  urlUpload.hls?.retry
                    ? () => void retryHlsUpload(urlUpload.hls!.retry!)
                    : urlUpload.retry
                      ? () => void retryUrlMultipart(urlUpload.retry!)
                      : undefined
                }
                onStop={activeUploadKind === "url" ? stopCurrentUpload : undefined}
                stopping={stopRequested && activeUploadKind === "url"}
                onFileNameChange={updateUrlFileName}
                onFileNameEditingChange={setUrlFileNameEditing}
                onHlsVariantChange={selectHlsVariant}
                onRenameConflict={urlUpload.conflict ? () => resolveUrlConflict("error") : undefined}
                onOverwriteConflict={urlUpload.conflict ? () => resolveUrlConflict("overwrite") : undefined}
                thumbnail={urlUpload.thumbnail}
                onThumbnailChange={(file) => void handleManualUrlThumbnail(file)}
                onThumbnailRemove={removeUrlThumbnail}
                disabled={uploadBusy}
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
            disabled={uploadBusy}
            onChange={(event) => setRemark(event.target.value)}
          />
        </div>
      </form>
      </Modal>

      <Modal
        open={curlImportOpen}
        onClose={closeCurlImport}
        title="从 cURL 解析"
        description="粘贴浏览器 DevTools 复制的 cURL，请求 URL 和可用请求头会自动填入 URL 上传表单。"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeCurlImport}>
              取消
            </Button>
            <Button
              variant="primary"
              leadingIcon={<Check size={15} />}
              disabled={!curlImportText.trim()}
              onClick={applyCurlImport}
            >
              解析并填入
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-curl-import" className="text-xs font-medium text-muted">
              cURL 命令
            </label>
            <Textarea
              id="upload-curl-import"
              rows={9}
              placeholder={"curl 'https://example.com/video.m3u8' \\\n  -H 'Referer: https://example.com/' \\\n  -H 'Cookie: session=...' \\\n  -H 'Authorization: Bearer ...' \\\n  --compressed"}
              value={curlImportText}
              invalid={Boolean(curlImportError)}
              onChange={(event) => {
                setCurlImportText(event.target.value);
                setCurlImportError(undefined);
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && curlImportText.trim()) {
                  event.preventDefault();
                  applyCurlImport();
                }
              }}
            />
          </div>

          {curlImportError ? (
            <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm leading-6 text-danger">
              {curlImportError}
            </div>
          ) : null}

          <div className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs leading-5 text-muted">
            支持 <span className="font-mono">-H/--header</span>、<span className="font-mono">-A/--user-agent</span>、
            <span className="font-mono">-e/--referer</span>、<span className="font-mono">-b/--cookie</span>、
            <span className="font-mono">-u/--user</span>。解析结果会覆盖当前 URL 和请求头；POST/body 参数不会转发，URL 上传仍要求源站支持 GET/HEAD/Range。
          </div>
        </div>
      </Modal>
    </>
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

function sourceHeadersTextFromCurlHeaders(headers: Record<string, string>): {
  text: string;
  headerCount: number;
  skippedHeaders: string[];
} {
  const lines: string[] = [];
  const skippedHeaders: string[] = [];
  const skipped = new Set<string>();

  const addSkipped = (name: string) => {
    const label = name || "空名称";
    const lowerName = label.toLowerCase();
    if (!skipped.has(lowerName)) {
      skipped.add(lowerName);
      skippedHeaders.push(label);
    }
  };

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = rawValue.trim();

    if (!value) {
      continue;
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n]/.test(value) || isBlockedSourceHeaderName(name)) {
      addSkipped(name);
      continue;
    }

    lines.push(`${name}: ${value}`);
  }

  return {
    text: lines.join("\n"),
    headerCount: lines.length,
    skippedHeaders
  };
}

function curlImportSummary(headerCount: number, warnings: string[]): string {
  const base = headerCount > 0
    ? `已从 cURL 填入 URL 和 ${headerCount} 个请求头`
    : "已从 cURL 填入 URL";
  const visibleWarnings = warnings.slice(0, 2);
  const warningText = visibleWarnings.length > 0 ? `；${visibleWarnings.join("；")}` : "";
  const overflowText = warnings.length > visibleWarnings.length
    ? `；另有 ${warnings.length - visibleWarnings.length} 条提示`
    : "";

  return `${base}${warningText}${overflowText}`;
}

function parseSourceHeadersText(value: string): SourceRequestHeaders | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (lines.length === 0) {
    return undefined;
  }

  const headers: SourceRequestHeaders = {};

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("请求头必须按 Header-Name: value 格式填写");
    }

    const name = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`请求头名称无效：${name || line}`);
    }

    if (isBlockedSourceHeaderName(name)) {
      throw new Error(`不允许自定义请求头：${name}`);
    }

    if (!headerValue) {
      continue;
    }

    headers[name] = headerValue;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function isBlockedSourceHeaderName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName === "host" ||
    lowerName === "range" ||
    lowerName === "content-length" ||
    lowerName === "connection" ||
    lowerName === "keep-alive" ||
    lowerName === "proxy-authenticate" ||
    lowerName === "proxy-authorization" ||
    lowerName === "te" ||
    lowerName === "trailer" ||
    lowerName === "transfer-encoding" ||
    lowerName === "upgrade" ||
    lowerName === "accept-encoding" ||
    lowerName === "cf-connecting-ip" ||
    lowerName === "cf-ipcountry" ||
    lowerName === "cf-ray" ||
    lowerName === "cf-visitor" ||
    lowerName === "true-client-ip" ||
    lowerName === "x-forwarded-for" ||
    lowerName === "x-forwarded-host" ||
    lowerName === "x-forwarded-proto" ||
    lowerName === "x-real-ip";
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

function effectiveDirectoryPath(item: QueueItem, baseDirectoryPath: string): string {
  return joinDirectoryPath(baseDirectoryPath, item.relativeDirectoryPath);
}

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

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFileEntry[]> {
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

async function readDroppedEntry(entry: WebkitFileSystemEntryLike, parentPath: string): Promise<DroppedFileEntry[]> {
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

function readDroppedFile(entry: WebkitFileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function readDroppedDirectoryEntries(directory: WebkitFileSystemDirectoryEntryLike): Promise<WebkitFileSystemEntryLike[]> {
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

function browserRelativePath(file: File): string | undefined {
  const value = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeRelativePath(value);
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");

  return segments.length > 0 ? segments.join("/") : undefined;
}

function relativeDirectoryPathFor(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length <= 1) return undefined;
  return segments.slice(0, -1).join("/");
}

function joinDirectoryPath(baseDirectoryPath: string, relativeDirectoryPath: string | undefined): string {
  const base = baseDirectoryPath === "/" ? "" : baseDirectoryPath.replace(/\/+$/g, "");
  const relative = relativeDirectoryPath?.replace(/^\/+|\/+$/g, "");

  if (!relative) {
    return base || "/";
  }

  return `${base}/${relative}`.replace(/\/+/g, "/") || "/";
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
    directoryPath: stringDetail(error.details, "directory_path") || "/",
    source: stringDetail(error.details, "source") === "file" ? "file" : undefined
  };
}

function fileNameConflictFromPreflight(entry: UploadPreflightResultEntry): FileNameConflictState {
  return {
    fileName: entry.file_name,
    suggestedName: entry.suggested_name || suggestAlternativeFileName(entry.file_name),
    directoryPath: entry.directory_path,
    source: entry.source,
    message: entry.message
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

function cleanupTemporaryHlsUpload(state: UrlUploadState): void {
  if (state.status === "done") {
    return;
  }

  const assetId = state.hls?.assetId ?? state.hls?.retry?.assetId;
  if (!assetId) {
    return;
  }

  void getHlsUploadStatus(assetId)
    .then((response) => {
      if (response.hls.asset.status === "done" || response.hls.asset.final_file_id) {
        return undefined;
      }
      return cancelHlsUpload(assetId);
    })
    .catch(() => undefined);
}

function withoutHlsRetry(state: HlsUrlState): HlsUrlState {
  const { retry: _retry, ...rest } = state;
  return rest;
}

function isLikelyHlsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\.m3u8$/i.test(url.pathname) || url.pathname.toLowerCase().includes(".m3u8");
  } catch {
    return /\.m3u8(?:[?#]|$)/i.test(value);
  }
}

function hlsRetryFromStatus(
  asset: HlsAsset,
  segments: HlsSegment[],
  conflictAction: FileNameConflictAction
): HlsRetryState {
  const completedSegments = segments
    .filter((segment) => segment.status === "done")
    .map((segment) => segment.segment_index)
    .sort((left, right) => left - right);
  const completedSet = new Set(completedSegments);
  const failedSegments = chunkRange(asset.segment_count)
    .filter((index) => !completedSet.has(index));

  return {
    assetId: asset.id,
    fileName: asset.file_name,
    segmentCount: asset.segment_count,
    previewPlaylistUrl: asset.preview_playlist_url,
    conflictAction,
    completedSegments,
    failedSegments
  };
}

function hlsRetryFailureProgress(retry: HlsRetryState, label: string): ChunkProgress {
  return {
    completed: retry.completedSegments.length,
    total: retry.segmentCount,
    failed: retry.failedSegments.length,
    label: retry.failedSegments.length > 0
      ? `${label}（失败 ${retry.failedSegments.length} 个片段）`
      : label
  };
}

function createHlsSegmentStates(segments: HlsSegment[]): UploadChunkState[] {
  return segments.map((segment) => ({
    index: segment.segment_index,
    size: segment.size ?? 0,
    status: hlsSegmentChunkStatus(segment),
    attempts: segment.attempts,
    ...(hlsSegmentChunkMessage(segment, segment.missing_chunks) ? { errorMessage: hlsSegmentChunkMessage(segment, segment.missing_chunks) } : {})
  }));
}

function prepareHlsRetryChunks(chunks: UploadChunkState[] | undefined, retry: HlsRetryState): UploadChunkState[] {
  const completed = new Set(retry.completedSegments);
  const failed = new Set(retry.failedSegments);
  const source = chunks ?? Array.from({ length: retry.segmentCount }, (_, index) => ({
    index,
    size: 0,
    status: "queued" as UploadChunkStatus,
    attempts: 0
  }));

  return source.map((chunk) => {
    if (completed.has(chunk.index)) {
      return { ...chunk, status: "completed", errorMessage: undefined };
    }
    if (failed.has(chunk.index)) {
      return { ...chunk, status: "queued", errorMessage: undefined };
    }
    return { ...chunk, status: "queued", errorMessage: undefined };
  });
}

function hlsSegmentChunkStatus(segment: HlsSegment): UploadChunkStatus {
  switch (segment.status) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "importing":
      return "uploading";
    default:
      return "queued";
  }
}

function hlsSegmentChunkMessage(segment: HlsSegment, missingChunks: number[]): string | undefined {
  if (segment.status === "done") {
    return undefined;
  }

  if (segment.status === "failed") {
    return segment.error_message || "HLS 片段导入失败";
  }

  if (segment.storage_backend === "telegram_multipart" && segment.chunk_count) {
    const uploaded = segment.uploaded_chunks.length;
    return missingChunks.length > 0
      ? `大 HLS 片段 · 内部分片 ${uploaded}/${segment.chunk_count}`
      : "大 HLS 片段 · 等待合成";
  }

  return segment.error_message ?? undefined;
}

function hlsProbeSummary(probe: HlsProbeInfo): string {
  if (probe.media) {
    return `HLS VOD · ${probe.media.segment_count} 个片段 · ${formatHlsDuration(probe.media.duration)}`;
  }

  if (probe.kind === "master") {
    return `HLS master · ${probe.variants.length} 个 variant`;
  }

  return "HLS 播放列表";
}

function formatHlsDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "未知时长";
  }

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) {
    return `${hours}小时${minutes.toString().padStart(2, "0")}分`;
  }

  return `${minutes}分${rest.toString().padStart(2, "0")}秒`;
}

function hlsVariantLabel(variant: HlsProbeInfo["variants"][number]): string {
  const parts = [
    variant.resolution,
    variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)}kbps` : undefined,
    variant.codecs
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : variant.id;
}

function sameOriginAdminUrl(value: string): string {
  if (typeof window === "undefined") {
    return value;
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.pathname.startsWith("/api/admin/")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    return value;
  }

  return value;
}

function buildFolderTree(items: QueueItem[]): FolderTreeNode {
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

function sortFolderTree(node: FolderTreeNode): void {
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

function countFolderTreeDirectories(node: FolderTreeNode): number {
  let count = node.kind === "directory" && node.path !== "/" ? 1 : 0;
  for (const child of node.children.values()) {
    count += countFolderTreeDirectories(child);
  }
  return count;
}

function folderNodeStatusClass(node: FolderTreeNode, isFile: boolean): string {
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

function folderNodeStatusLabel(node: FolderTreeNode): string {
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

function ConflictSummary({
  count,
  disabled,
  onOverwriteAll,
  onSkipAll
}: {
  count: number;
  disabled: boolean;
  onOverwriteAll: () => void;
  onSkipAll: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warning/35 bg-warning-soft/45 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2 text-sm text-warning">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">发现 {count} 个同名文件</p>
          <p className="text-xs leading-5 text-warning/85">可以批量处理，也可以在下方逐项选择。</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onOverwriteAll}
        >
          全部覆盖
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onSkipAll}
        >
          全部忽略
        </Button>
      </div>
    </div>
  );
}

interface FolderTreeNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  status?: ItemStatus;
  conflict?: boolean;
  conflictAction?: FileNameConflictAction;
  renamed?: boolean;
  children: Map<string, FolderTreeNode>;
}

function FolderUploadTree({ items, baseDirectoryPath }: { items: QueueItem[]; baseDirectoryPath: string }) {
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

interface QueueRowProps {
  item: QueueItem;
  targetDirectoryPath: string;
  onRemove: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onSkipConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailRemove: () => void;
  onToggleChunks: () => void;
  disabled: boolean;
}

function QueueRow({
  item,
  targetDirectoryPath,
  onRemove,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict,
  onSkipConflict,
  onThumbnailChange,
  onThumbnailRemove,
  onToggleChunks,
  disabled
}: QueueRowProps) {
  const status = item.status;
  const fileName = item.fileNameOverride ?? item.file.name;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="self-center">
          <UploadThumbnailVisual
            thumbnail={item.thumbnail}
            fallback={<FileTypeIcon mimeType={item.file.type || "application/octet-stream"} fileName={item.file.name} size="sm" />}
          />
        </span>
        <div className="min-w-0 flex-1">
          <EditableFileName
            value={fileName}
            originalValue={item.file.name}
            editing={Boolean(item.editingFileName)}
            conflict={item.conflict}
            disabled={disabled || status === "uploading" || status === "done" || status === "skipped"}
            onChange={onFileNameChange}
            onEditingChange={onFileNameEditingChange}
          />
          <p className="truncate text-xs text-muted">
            {formatBytes(item.file.size)} · 上传到 {targetDirectoryPath} · 分片上传
            {item.conflict ? <span className="text-warning"> · 目标已有同名文件</span> : null}
            {!item.conflict && item.conflictAction === "overwrite" ? <span className="text-warning"> · 将覆盖同名文件</span> : null}
            {thumbnailHint(item.thumbnail) ? <span> · {thumbnailHint(item.thumbnail)}</span> : null}
            {item.message ? <span className={status === "error" ? "text-danger" : "text-muted"}> · {item.message}</span> : null}
          </p>
          {item.relativePath ? (
            <p className="truncate text-[11px] text-subtle" title={item.relativePath}>
              本地路径：{item.relativePath}
            </p>
          ) : null}
          {item.progress ? <ProgressBar progress={item.progress} /> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5 self-center">
          <QueueStateBadge item={item} multipart={Boolean(item.progress)} />
          <CompactConflictActions
            conflict={item.conflict}
            disabled={disabled}
            onRename={onRenameConflict}
            onOverwrite={onOverwriteConflict}
            onSkip={onSkipConflict}
          />
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
              className="h-6 shrink-0 rounded-md border border-primary/30 px-2 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
            >
              {item.retry?.failedChunks.length === 0 ? "继续完成上传" : "重试失败分片"}
            </button>
          ) : null}
          {onStop && status === "uploading" ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="h-6 shrink-0 rounded-md border border-danger/30 px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-40"
            >
              {stopping ? "正在停止" : "停止上传"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="移除"
            onClick={onRemove}
            disabled={disabled || status === "uploading"}
            className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          >
            {status === "done" ? <CheckCircle2 size={13} className="text-success" /> : <X size={13} />}
          </button>
        </div>
      </div>
      {item.chunks ? (
        <UploadChunkPanel chunks={item.chunks} expanded={Boolean(item.chunksExpanded)} onToggle={onToggleChunks} />
      ) : null}
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
  hls?: HlsUrlState;
  thumbnail?: UploadThumbnailState;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onHlsVariantChange: (variantId: string) => void;
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
  hls,
  thumbnail,
  onClear,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onHlsVariantChange,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailRemove,
  disabled
}: UrlUploadRowProps) {
  const fileName = fileNameOverride ?? remoteFileLabel(url);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="self-center">
          <UploadThumbnailVisual
            thumbnail={thumbnail}
            fallback={
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
                <Link2 size={16} />
              </span>
            }
          />
        </span>
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
          {hls?.probe ? (
            <HlsUploadDetails
              hls={hls}
              disabled={disabled || status === "uploading" || status === "done"}
              onVariantChange={onHlsVariantChange}
            />
          ) : null}
          {progress ? <ProgressBar progress={progress} /> : null}
          <ConflictResolutionActions
            conflict={conflict}
            disabled={disabled}
            onRename={onRenameConflict}
            onOverwrite={onOverwriteConflict}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5 self-center">
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
              className="h-6 shrink-0 rounded-md border border-primary/30 px-2 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
            >
              {hls?.retry
                ? hls.retry.failedSegments.length === 0 ? "继续完成上传" : "重试 HLS 片段"
                : progress && progress.failed === 0 ? "继续完成上传" : "重试失败分片"}
            </button>
          ) : null}
          {onStop && status === "uploading" ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="h-6 shrink-0 rounded-md border border-danger/30 px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-40"
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
            className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          >
            {status === "done" ? <CheckCircle2 size={13} className="text-success" /> : <X size={13} />}
          </button>
        </div>
      </div>
      {chunks ? <UploadChunkList chunks={chunks} title={hls ? "HLS 片段明细" : "分片明细"} /> : null}
    </div>
  );
}

function HlsUploadDetails({
  hls,
  disabled,
  onVariantChange
}: {
  hls: HlsUrlState;
  disabled: boolean;
  onVariantChange: (variantId: string) => void;
}) {
  const probe = hls.probe;
  if (!probe) {
    return null;
  }

  const selectedVariant = probe.variants.find((variant) => variant.id === hls.variantId || variant.id === probe.selected_variant_id);
  const media = probe.media;

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted">
      <HlsMetaPill tone="strong">HLS</HlsMetaPill>
      <HlsMetaPill>{probe.kind === "master" ? "master playlist" : "media playlist"}</HlsMetaPill>
      {media ? (
        <>
          <HlsMetaPill>{media.segment_count} 个片段</HlsMetaPill>
          <HlsMetaPill>{formatHlsDuration(media.duration)}</HlsMetaPill>
          <HlsMetaPill>target {media.target_duration}s</HlsMetaPill>
        </>
      ) : (
        <HlsMetaPill>{probe.variants.length} 个 variant</HlsMetaPill>
      )}
      {hls.previewPlaylistUrl ? (
        <HlsMetaPill tone="success">临时预览已就绪</HlsMetaPill>
      ) : null}
      {selectedVariant ? (
        <HlsMetaPill title={selectedVariant.uri}>{hlsVariantLabel(selectedVariant)}</HlsMetaPill>
      ) : null}
      {probe.kind === "master" ? (
        <select
          value={hls.variantId ?? probe.selected_variant_id ?? ""}
          disabled={disabled}
          className="h-7 max-w-full shrink-0 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-ring)] disabled:opacity-60"
          onChange={(event) => onVariantChange(event.target.value)}
        >
          <option value="">选择 variant</option>
          {probe.variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {hlsVariantLabel(variant)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function HlsMetaPill({
  children,
  title,
  tone = "neutral"
}: {
  children: ReactNode;
  title?: string;
  tone?: "neutral" | "strong" | "success";
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center rounded-full px-1.5 font-medium",
        tone === "neutral" && "bg-background text-muted ring-1 ring-border",
        tone === "strong" && "bg-primary-soft text-primary-strong",
        tone === "success" && "bg-success-soft text-success"
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function QueueStateBadge({ item, multipart }: { item: QueueItem; multipart?: boolean }) {
  if (item.conflict) {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-warning-soft px-1.5 text-[11px] font-medium text-warning"
        title={conflictTitle(item.conflict)}
      >
        <AlertTriangle size={11} />
        冲突
      </span>
    );
  }

  if (item.conflictAction === "overwrite") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-warning-soft px-1.5 text-[11px] font-medium text-warning">
        将覆盖
      </span>
    );
  }

  if (item.fileNameOverride && item.status !== "done" && item.status !== "uploading") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-primary-soft px-1.5 text-[11px] font-medium text-primary-strong">
        已改名
      </span>
    );
  }

  return <StatusBadge status={item.status} multipart={multipart} />;
}

function CompactConflictActions({
  conflict,
  disabled,
  onRename,
  onOverwrite,
  onSkip
}: {
  conflict?: FileNameConflictState;
  disabled: boolean;
  onRename?: () => void;
  onOverwrite?: () => void;
  onSkip?: () => void;
}) {
  if (!conflict) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={onOverwrite}
        title={`覆盖 ${conflict.fileName}`}
        disabled={disabled || !onOverwrite}
        className="h-6 rounded px-1.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-40"
      >
        覆盖
      </button>
      <button
        type="button"
        onClick={onRename}
        title={`改名为 ${conflict.suggestedName}`}
        disabled={disabled || !onRename}
        className="h-6 rounded px-1.5 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
      >
        改名
      </button>
      <button
        type="button"
        onClick={onSkip}
        disabled={disabled || !onSkip}
        className="h-6 rounded px-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        忽略
      </button>
    </span>
  );
}

function conflictTitle(conflict: FileNameConflictState): string {
  const separator = conflict.directoryPath.endsWith("/") ? "" : "/";
  return `${conflict.source === "batch" ? "本次队列重复" : "目标目录已存在"}：${conflict.directoryPath}${separator}${conflict.fileName}`;
}

function ConflictResolutionActions({
  conflict,
  disabled,
  onRename,
  onOverwrite,
  onSkip
}: {
  conflict?: FileNameConflictState;
  disabled: boolean;
  onRename?: () => void;
  onOverwrite?: () => void;
  onSkip?: () => void;
}) {
  if (!conflict) {
    return null;
  }

  const title = conflict.source === "batch" ? "本次队列已有相同目标路径" : "目标目录已存在同名文件";

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2 rounded-lg border border-warning/35 bg-warning-soft/50 px-2.5 py-2 text-xs leading-5 text-warning">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="break-all text-warning/90">
          <span className="font-semibold">{conflict.directoryPath}</span>
          {conflict.directoryPath.endsWith("/") ? "" : "/"}
          <span className="font-semibold">{conflict.fileName}</span>
        </p>
        {conflict.message ? <p className="text-warning/80">{conflict.message}</p> : null}
      </div>
      <span className="flex min-w-0 flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onRename}
          onPointerDown={(event) => event.preventDefault()}
          title={`重命名为 ${conflict.suggestedName}`}
          disabled={disabled || !onRename}
          className="min-w-0 max-w-full rounded-md border border-warning/35 bg-surface px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="block max-w-full truncate">重命名为 {conflict.suggestedName}</span>
        </button>
        <button
          type="button"
          onClick={onOverwrite}
          onPointerDown={(event) => event.preventDefault()}
          title={`覆盖 ${conflict.fileName}`}
          disabled={disabled || !onOverwrite}
          className="rounded-md border border-danger/30 px-2.5 py-1 font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-50"
        >
          覆盖原文件
        </button>
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            onPointerDown={(event) => event.preventDefault()}
            disabled={disabled}
            className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-muted transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            忽略此文件
          </button>
        ) : null}
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
    <span className="hidden shrink-0 items-center gap-0.5 sm:inline-flex">
      <label
        className={cn(
          "grid size-6 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong",
          disabled && "pointer-events-none opacity-40"
        )}
        title={hasThumbnail ? "更换缩略图" : "选择缩略图"}
      >
        <ImagePlus size={13} />
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
          className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          disabled={disabled}
          title="移除缩略图"
          onClick={onRemove}
        >
          <ImageOff size={13} />
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

function UploadChunkPanel({
  chunks,
  expanded,
  onToggle
}: {
  chunks: UploadChunkState[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const completed = chunks.filter((chunk) => chunk.status === "completed").length;
  const failed = chunks.filter((chunk) => chunk.status === "failed").length;
  const uploading = chunks.filter((chunk) => chunk.status === "uploading").length;

  return (
    <div className="rounded-lg border border-border bg-background/70 p-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 text-left text-[11px] text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Layers3 size={13} className="shrink-0 text-primary-strong" />
          <span className="truncate">
            分片：{completed}/{chunks.length} 完成
            {uploading > 0 ? ` · ${uploading} 上传中` : ""}
            {failed > 0 ? ` · ${failed} 失败` : ""}
          </span>
        </span>
        <span className="shrink-0 font-medium text-primary-strong">
          {expanded ? "收起详情" : "分片详情"}
        </span>
      </button>
      {expanded ? <UploadChunkList chunks={chunks} /> : null}
    </div>
  );
}

function UploadChunkList({ chunks, title = "分片明细" }: { chunks: UploadChunkState[]; title?: string }) {
  const completed = chunks.filter((chunk) => chunk.status === "completed").length;
  const failed = chunks.filter((chunk) => chunk.status === "failed").length;
  const uploading = chunks.filter((chunk) => chunk.status === "uploading").length;

  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>
          {title}：{completed}/{chunks.length} 完成
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
            {chunk.size > 0 ? <span className="shrink-0 opacity-70">{formatBytes(chunk.size)}</span> : null}
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
      return <span className="text-[11px] text-muted">跳过</span>;
    default:
      return <span className="text-[11px] text-muted">待传</span>;
  }
}
