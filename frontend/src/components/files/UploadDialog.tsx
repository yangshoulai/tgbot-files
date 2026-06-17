import { ChangeEvent, FormEvent, forwardRef, memo, type ReactNode, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, CheckCircle2, ClipboardPaste, FilePlus2, FolderOpen, FolderTree, ImageOff, ImagePlus, Layers3, Link2, Pencil, Plus, Trash2, UploadCloud, X } from "lucide-react";
import {
  ApiError,
  cancelHlsUpload,
  cancelMagnetUpload,
  completeHlsSegment,
  completeHlsUpload,
  completeMagnetMultipartUpload,
  completeMultipartUpload,
  getHlsUploadStatus,
  getMagnetUploadStatus,
  getMultipartUploadStatus,
  importHlsSegment,
  importHlsSegmentChunk,
  initMagnetUpload,
  initMultipartUpload,
  initHlsUpload,
  initUrlMultipartUpload,
  listDirectories,
  magnetThumbnailSourceUrl,
  preflightUploads,
  probeMagnetUpload,
  probeHlsUpload,
  uploadMagnetMultipartChunk,
  uploadMultipartChunk,
  uploadUrlMultipartChunk,
  type DirectoryItem,
  type FileNameConflictAction,
  type HlsAsset,
  type HlsProbeInfo,
  type HlsSegment,
  type MagnetFileUploadOption,
  type MagnetImport,
  type MagnetImportFile,
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
  acquireUploadTaskLock,
  firstResumableUploadTask,
  makePersistedTaskId,
  releaseUploadTaskLock,
  removeUploadTask,
  readUploadTaskQueue,
  renewUploadTaskLock,
  sanitizeSourceHeadersForPersistence,
  upsertUploadTask,
  writeUploadTaskQueue,
  type HlsRetryState,
  type MagnetUploadEntry,
  type MultipartRetryState,
  type PersistedLocalUploadTask,
  type PersistedMagnetUploadTask,
  type PersistedUploadTask
} from "../../lib/upload-tasks";
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
  maxMultipartBytes: number;
  uploadConcurrency: number;
  directoryPath: string;
  onClose: () => void;
  onUploaded: (uploadedCount: number) => void;
  onError: (message: string) => void;
  onTaskSnapshotChange?: (snapshot: UploadTaskSnapshot | null) => void;
}

export type UploadTaskSnapshotStatus = "pending" | "uploading" | "done" | "error" | "skipped";

export interface UploadTaskSnapshotItem {
  id: string;
  kind: "local" | "url";
  title: string;
  description?: string;
  status: UploadTaskSnapshotStatus;
  progressPercent: number;
  progressLabel?: string;
  canStop: boolean;
  canDelete: boolean;
}

export interface UploadTaskSnapshot {
  items: UploadTaskSnapshotItem[];
  running: boolean;
  stopRequested: boolean;
  activeItemId: string | null;
  summary: {
    total: number;
    pending: number;
    uploading: number;
    done: number;
    error: number;
    skipped: number;
  };
}

export interface UploadDialogHandle {
  stopCurrentUpload: () => void;
  hasActiveUpload: () => boolean;
  clearSettledTasks: () => void;
  deleteTask: (id: string) => void;
  resumeLocalFile: (file: File) => void;
}

export type ItemStatus = "pending" | "uploading" | "done" | "error" | "skipped";
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

interface SourceHeaderRow {
  id: string;
  name: string;
  value: string;
}

interface HlsUrlState {
  probe?: HlsProbeInfo;
  variantId?: string;
  assetId?: string;
  segmentCount?: number;
  previewPlaylistUrl?: string;
  retry?: HlsRetryState;
}

interface MagnetFileDecision {
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  conflictAction?: FileNameConflictAction;
}

interface MagnetUrlState {
  import?: MagnetImport;
  selectedIndexes: number[];
  fileDecisions?: Record<number, MagnetFileDecision>;
  uploads?: MagnetUploadEntry[];
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
  recoveredLocalPlaceholder?: boolean;
  runtimeStore?: UploadRuntimeStore;
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
  magnet?: MagnetUrlState;
}

interface UploadRuntimeState {
  progress?: ChunkProgress;
  chunks?: UploadChunkState[];
}

interface UploadRuntimeStore {
  getSnapshot: () => UploadRuntimeState;
  subscribe: (listener: () => void) => () => void;
  setState: (updater: (current: UploadRuntimeState) => UploadRuntimeState) => UploadRuntimeState;
  reset: () => void;
}

interface QueuedUrlUploadTask {
  id: string;
  sourceUrl: string;
  directoryPath: string;
  remark: string;
}

type UploadThumbnailStatus = "idle" | "generating" | "ready" | "failed" | "removed";

interface UploadThumbnailState {
  status: UploadThumbnailStatus;
  generated?: GeneratedThumbnail;
  remote?: RemoteThumbnailInput;
  message?: string;
}

interface RemoteThumbnailInput {
  url: string;
  headers?: SourceRequestHeaders;
}

type ThumbnailUrlPickerTarget =
  | { kind: "item"; id: string }
  | { kind: "url" };

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
const DEFAULT_UPLOAD_CONCURRENCY = 5;
const MULTIPART_UPLOAD_MAX_ATTEMPTS = 3;
const MULTIPART_UPLOAD_RETRY_DELAY_MS = 800;
const LOCAL_CHUNK_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const URL_CHUNK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const HLS_SEGMENT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const MAGNET_STATUS_POLL_MS = 2_000;
const MAGNET_DOWNLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAGNET_STATUS_MAX_TRANSIENT_FAILURES = 5;
const MAGNET_STATUS_RETRY_DELAY_MS = 2_000;
const FILE_NAME_CONFLICT_TOAST_MESSAGE = "上传目录已存在同名文件，请选择覆盖或改名上传";
const CHUNK_UI_UPDATE_INTERVAL_MS = 160;
const TASK_SNAPSHOT_UPDATE_INTERVAL_MS = 500;

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
    runtimeStore: createUploadRuntimeStore(),
    ...(relativePath ? { relativePath } : {}),
    ...(relativeDirectoryPath ? { relativeDirectoryPath } : {}),
    status: "pending",
    thumbnail: canAutoGenerateThumbnail(file) ? { status: "idle" } : undefined
  };
}

function makeSourceHeaderRow(name = "", value = ""): SourceHeaderRow {
  counter += 1;
  return {
    id: `source-header-${Date.now()}-${counter}`,
    name: normalizeHeaderKeyInput(name),
    value
  };
}

function makeQueuedUrlUploadTask(sourceUrl: string, directoryPath: string, remark: string): QueuedUrlUploadTask {
  counter += 1;
  return {
    id: `queued-url-${Date.now()}-${counter}`,
    sourceUrl,
    directoryPath,
    remark
  };
}

function isLocalItemAwaitingDecision(item: QueueItem): boolean {
  return item.status === "pending" || item.status === "error";
}

function isUploadableLocalItem(item: QueueItem): boolean {
  return isLocalItemAwaitingDecision(item) && !item.conflict;
}

function normalizeUploadConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  return value;
}

function sourceHeaderRowsFromHeaders(headers?: SourceRequestHeaders): SourceHeaderRow[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => makeSourceHeaderRow(name, value));
}

function extractFirstUrl(value: string): string | undefined {
  const match = value.match(/(?:https?:\/\/|magnet:\?)[^\s<>"']+/i);
  return match?.[0];
}

function makePlaceholderLocalItem(task: PersistedLocalUploadTask): QueueItem {
  const file = new File([], task.fileName, {
    type: task.mimeType || "application/octet-stream",
    lastModified: task.lastModified
  });
  const item = makeItem(file, { relativePath: task.relativePath });
  const retryProgress = retryFailureProgress(task.retry, "等待重新选择本地文件");
  seedUploadRuntimeStore(item.runtimeStore!, retryProgress);
  return {
    ...item,
    status: "error",
    message: `刷新后需要重新选择同一个文件：${task.fileName}`,
    retry: task.retry,
    progress: retryProgress,
    thumbnail: undefined,
    recoveredLocalPlaceholder: true
  };
}

function createUploadRuntimeStore(initialState: UploadRuntimeState = {}): UploadRuntimeStore {
  let state = initialState;
  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (updater) => {
      const next = updater(state);
      if (uploadRuntimeStateEqual(state, next)) {
        return state;
      }
      state = next;
      notify();
      return state;
    },
    reset: () => {
      if (uploadRuntimeStateEqual(state, {})) {
        return;
      }
      state = {};
      notify();
    }
  };
}

function seedUploadRuntimeStore(
  store: UploadRuntimeStore,
  progress?: ChunkProgress | null,
  chunks?: UploadChunkState[] | null
): void {
  store.setState((current) => ({
    ...(progress === undefined && current.progress ? { progress: current.progress } : {}),
    ...(progress ? { progress } : {}),
    ...(chunks === undefined && current.chunks ? { chunks: current.chunks } : {}),
    ...(chunks ? { chunks } : {})
  }));
}

function resetUploadRuntimeStore(store: UploadRuntimeStore | undefined): void {
  store?.reset();
}

function localRuntimeSnapshot(items: QueueItem[]): Map<string, UploadRuntimeState> {
  return new Map(items.map((item) => [item.id, item.runtimeStore?.getSnapshot() ?? {}]));
}

export const UploadDialog = forwardRef<UploadDialogHandle, UploadDialogProps>(function UploadDialog({
  open,
  initialFiles,
  maxBytes,
  maxMultipartBytes,
  uploadConcurrency,
  directoryPath,
  onClose,
  onUploaded,
  onError,
  onTaskSnapshotChange
}, ref) {
  const [mode, setMode] = useState<UploadMode>("file");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceHeaderRows, setSourceHeaderRows] = useState<SourceHeaderRow[]>([]);
  const [curlImportOpen, setCurlImportOpen] = useState(false);
  const [curlImportText, setCurlImportText] = useState("");
  const [curlImportError, setCurlImportError] = useState<string>();
  const [thumbnailUrlPicker, setThumbnailUrlPicker] = useState<ThumbnailUrlPickerTarget | null>(null);
  const [thumbnailUrlText, setThumbnailUrlText] = useState("");
  const [thumbnailUrlError, setThumbnailUrlError] = useState<string>();
  const [urlUpload, setUrlUpload] = useState<UrlUploadState>({ status: "pending" });
  const [queuedUrlTasks, setQueuedUrlTasks] = useState<QueuedUrlUploadTask[]>([]);
  const [queuedUrlDraft, setQueuedUrlDraft] = useState("");
  const [queuedUrlDraftError, setQueuedUrlDraftError] = useState<string>();
  const [queuedUrlPreparedTaskId, setQueuedUrlPreparedTaskId] = useState<string | null>(null);
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadDirectoryPath, setUploadDirectoryPath] = useState(directoryPath);
  const [pendingMagnetResume, setPendingMagnetResume] = useState(false);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [directoriesLoading, setDirectoriesLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const onErrorRef = useRef(onError);
  const activeUploadRef = useRef<UploadAbortContext | null>(null);
  const itemsRef = useRef(items);
  const urlUploadRef = useRef(urlUpload);
  const urlRuntimeStoreRef = useRef<UploadRuntimeStore | null>(null);
  if (!urlRuntimeStoreRef.current) {
    urlRuntimeStoreRef.current = createUploadRuntimeStore();
  }
  const urlRuntimeStore = urlRuntimeStoreRef.current;
  const lastTaskSnapshotKeyRef = useRef<string | null>(null);
  const lastTaskSnapshotStructureKeyRef = useRef<string | null>(null);
  const taskSnapshotTimerRef = useRef<number | null>(null);
  const pendingTaskSnapshotRef = useRef<UploadTaskSnapshot | null>(null);
  const queuedUrlTasksRef = useRef(queuedUrlTasks);
  const queuedUrlLaunchingRef = useRef(false);
  const activePersistedTaskIdRef = useRef<string | null>(null);
  const preserveHiddenUploadStateRef = useRef(false);
  const previousOpenRef = useRef(open);
  const recoveringPersistedTaskRef = useRef(false);
  const uploadTaskLockOwnerRef = useRef(`upload-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hlsThumbnailPromiseRef = useRef<Promise<GeneratedThumbnail | undefined> | null>(null);
  const hlsThumbnailGeneratingRef = useRef(false);
  const [activeUploadKind, setActiveUploadKind] = useState<"local" | "url" | null>(null);
  const [activeUploadItemId, setActiveUploadItemId] = useState<string | null>(null);
  const [activePersistedTaskId, setActivePersistedTaskIdState] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const uploadDialogStateRef = useRef({
    mode,
    queuedUrlTasks,
    sourceUrl: "",
    uploadDirectoryPath,
    activeUploadKind,
    activeUploadItemId,
    activePersistedTaskId,
    stopRequested,
    uploadBusy: false,
    onTaskSnapshotChange
  });
  const effectiveUploadConcurrency = normalizeUploadConcurrency(uploadConcurrency);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, [mode, open]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    urlUploadRef.current = urlUpload;
  }, [urlUpload]);

  useEffect(() => {
    queuedUrlTasksRef.current = queuedUrlTasks;
  }, [queuedUrlTasks]);

  useEffect(() => {
    const task = firstResumableUploadTask();
    if (!task) return;
    if (task.kind !== "local" && !acquireUploadTaskLock(uploadTaskLockOwnerRef.current)) {
      onErrorRef.current("检测到其他标签页正在恢复上传任务，本页不会重复执行");
      return;
    }

    recoveringPersistedTaskRef.current = true;
    restorePersistedUploadTask(task);
    window.setTimeout(() => {
      recoveringPersistedTaskRef.current = false;
    }, 0);
    // 恢复只在组件首次挂载时执行；后续打开弹框由 open effect 管理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeUploadKind) return;
    renewUploadTaskLock(uploadTaskLockOwnerRef.current);
    const timer = window.setInterval(() => {
      renewUploadTaskLock(uploadTaskLockOwnerRef.current);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeUploadKind]);

  useEffect(() => {
    if (recoveringPersistedTaskRef.current) {
      return;
    }

    const wasOpen = previousOpenRef.current;
    const shouldInitializeOpenState = open && !wasOpen;
    previousOpenRef.current = open;

    if (!open) {
      if (activeUploadRef.current || submitting || checkingConflicts || preserveHiddenUploadStateRef.current) {
        preserveHiddenUploadStateRef.current = true;
        return;
      }
      abortUploadTask(activeUploadRef.current);
      activeUploadRef.current = null;
      hlsThumbnailGeneratingRef.current = false;
      hlsThumbnailPromiseRef.current = null;
      urlRuntimeStore.reset();
      setActiveUploadKind(null);
      setActiveUploadItemId(null);
      setStopRequested(false);
      setItems((current) => {
        current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
        return [];
      });
      setUrlUpload((current) => {
        cleanupTemporaryHlsUpload(current);
        cleanupTemporaryMagnetUpload(current);
        revokeThumbnail(current.thumbnail?.generated);
        return { status: "pending" };
      });
      setMode("file");
      setSourceUrl("");
      setSourceHeaderRows([]);
      setCurlImportOpen(false);
      setCurlImportText("");
      setCurlImportError(undefined);
      setThumbnailUrlPicker(null);
      setThumbnailUrlText("");
      setThumbnailUrlError(undefined);
      setRemark("");
      setSubmitting(false);
      setCheckingConflicts(false);
      setDragOver(false);
      setUploadDirectoryPath(directoryPath);
      resetQueuedUrlDraftState();
      return;
    }

    if (!shouldInitializeOpenState) {
      return;
    }

    if (activeUploadRef.current || submitting || checkingConflicts || preserveHiddenUploadStateRef.current) {
      preserveHiddenUploadStateRef.current = false;
      return;
    }

    setMode("file");
    setUploadDirectoryPath(directoryPath);
    urlRuntimeStore.reset();
    setItems((current) => {
      current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
      return initialFiles.map((file) => makeItem(file));
    });
    setSourceUrl("");
    setSourceHeaderRows([]);
    setCurlImportOpen(false);
    setCurlImportText("");
    setCurlImportError(undefined);
    setThumbnailUrlPicker(null);
    setThumbnailUrlText("");
    setThumbnailUrlError(undefined);
    setUrlUpload((current) => {
      cleanupTemporaryHlsUpload(current);
      cleanupTemporaryMagnetUpload(current);
      revokeThumbnail(current.thumbnail?.generated);
      return { status: "pending" };
    });
    resetQueuedUrlDraftState();
  }, [checkingConflicts, directoryPath, open, initialFiles, submitting]);

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
    const files = Array.from(list);
    const needsLocalResume = items.some((item) => item.recoveredLocalPlaceholder);
    if (needsLocalResume && files.length > 0) {
      resumeLocalFile(files[0]);
    } else {
      addFiles(files);
    }
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

  function openThumbnailUrlPicker(target: ThumbnailUrlPickerTarget) {
    const existing = target.kind === "item"
      ? items.find((item) => item.id === target.id)?.thumbnail?.remote
      : urlUpload.thumbnail?.remote;
    setThumbnailUrlPicker(target);
    setThumbnailUrlText(existing?.url ?? "");
    setThumbnailUrlError(undefined);
  }

  function closeThumbnailUrlPicker() {
    setThumbnailUrlPicker(null);
    setThumbnailUrlText("");
    setThumbnailUrlError(undefined);
  }

  function applyThumbnailUrlPicker() {
    if (!thumbnailUrlPicker) return;

    try {
      const parsed = parseRemoteThumbnailInput(thumbnailUrlText);
      const thumbnail: UploadThumbnailState = {
        status: "ready",
        remote: {
          url: parsed.url,
          ...(parsed.headers ? { headers: parsed.headers } : {})
        },
        message: parsed.summary
      };

      if (thumbnailUrlPicker.kind === "item") {
        updateItemThumbnail(thumbnailUrlPicker.id, thumbnail);
      } else {
        updateUrlThumbnail(thumbnail);
      }

      closeThumbnailUrlPicker();
    } catch (error) {
      setThumbnailUrlError(errorMessage(error));
    }
  }

  const uploadBusy = submitting || checkingConflicts;
  const filePendingCount = useMemo(() => items.filter(isUploadableLocalItem).length, [items]);
  const folderItemCount = useMemo(() => items.filter((item) => item.relativePath).length, [items]);
  const conflictItemCount = useMemo(() => items.filter((item) =>
    isLocalItemAwaitingDecision(item) && Boolean(item.conflict)
  ).length, [items]);
  const normalizedSourceUrl = sourceUrl.trim();
  const urlPendingCount = normalizedSourceUrl && urlUpload.status !== "uploading" && urlUpload.status !== "done" ? 1 : 0;
  const pendingCount = mode === "url" ? urlPendingCount : filePendingCount;
  const isMagnetSource = isLikelyMagnetUrl(normalizedSourceUrl);
  const magnetValidFiles = useMemo(
    () => isMagnetSource && urlUpload.magnet?.import
      ? urlUpload.magnet.import.files.filter((file) => !file.file_name.startsWith("[METADATA]"))
      : [],
    [isMagnetSource, urlUpload.magnet?.import]
  );
  const magnetHasNoValidFiles = isMagnetSource && urlUpload.magnet?.import && magnetValidFiles.length === 0;
  const hasUnresolvedMagnetConflict = useMemo(
    () => isMagnetSource && Boolean(urlUpload.magnet?.selectedIndexes.some((fileIndex) =>
      Boolean(urlUpload.magnet?.fileDecisions?.[fileIndex]?.conflict)
    )),
    [isMagnetSource, urlUpload.magnet?.fileDecisions, urlUpload.magnet?.selectedIndexes]
  );
  const hasUnresolvedConflict = mode === "url"
    ? Boolean(urlUpload.conflict) || hasUnresolvedMagnetConflict
    : items.some((item) => isLocalItemAwaitingDecision(item) && Boolean(item.conflict));
  const hasInvalidMagnetFileName = useMemo(
    () => isMagnetSource && Boolean(urlUpload.magnet?.selectedIndexes.some((fileIndex) => {
      const decision = urlUpload.magnet?.fileDecisions?.[fileIndex];
      return Boolean(
        decision &&
        (decision.editingFileName || decision.conflict) &&
        decision.fileNameOverride !== undefined &&
        decision.fileNameOverride.trim().length === 0
      );
    })),
    [isMagnetSource, urlUpload.magnet?.fileDecisions, urlUpload.magnet?.selectedIndexes]
  );
  const hasInvalidFileName = mode === "url"
    ? Boolean(
        normalizedSourceUrl &&
        (urlUpload.editingFileName || urlUpload.conflict) &&
        urlUpload.fileNameOverride !== undefined &&
        urlUpload.fileNameOverride.trim().length === 0
      ) || hasInvalidMagnetFileName
    : items.some((item) =>
        isLocalItemAwaitingDecision(item) &&
        (item.editingFileName || item.conflict) &&
        item.fileNameOverride !== undefined &&
        item.fileNameOverride.trim().length === 0
      );
  const hasDone = useMemo(() => urlUpload.status === "done" || items.some((item) => item.status === "done"), [items, urlUpload.status]);
  const queuedUrlStartBlocked = mode === "url"
    ? Boolean(normalizedSourceUrl && urlUpload.status !== "done")
    : items.some((item) => item.status === "pending" || item.status === "uploading" || item.status === "error");
  const showQueuedUrlComposer = uploadBusy || activeUploadKind !== null || queuedUrlTasks.length > 0;

  useEffect(() => {
    if (recoveringPersistedTaskRef.current || queuedUrlLaunchingRef.current || queuedUrlPreparedTaskId) {
      return;
    }

    if (activeUploadKind || submitting || checkingConflicts || queuedUrlStartBlocked) {
      return;
    }

    const nextTask = queuedUrlTasksRef.current[0];
    if (!nextTask) {
      return;
    }

    launchQueuedUrlTask(nextTask);
  }, [activeUploadKind, checkingConflicts, queuedUrlPreparedTaskId, queuedUrlStartBlocked, queuedUrlTasks, submitting]);

  useEffect(() => {
    if (!queuedUrlPreparedTaskId) {
      return;
    }

    if (activeUploadKind || submitting || checkingConflicts || mode !== "url" || !normalizedSourceUrl) {
      return;
    }

    const validationError = validateSourceUrl(normalizedSourceUrl);
    if (validationError) {
      setUrlUpload({ status: "error", message: validationError });
      setQueuedUrlPreparedTaskId(null);
      queuedUrlLaunchingRef.current = false;
      onError(validationError);
      return;
    }

    setQueuedUrlPreparedTaskId(null);
    void submitUrlUpload();
    queuedUrlLaunchingRef.current = false;
  }, [activeUploadKind, checkingConflicts, mode, normalizedSourceUrl, queuedUrlPreparedTaskId, submitting]);

  function launchQueuedUrlTask(task: QueuedUrlUploadTask) {
    queuedUrlLaunchingRef.current = true;
    setQueuedUrlTasks((current) => current.filter((item) => item.id !== task.id));
    setMode("url");
    setUploadDirectoryPath(task.directoryPath);
    setRemark(task.remark);
    setSourceUrl(task.sourceUrl);
    setSourceHeaderRows([]);
    setCurlImportOpen(false);
    setCurlImportText("");
    setCurlImportError(undefined);
    setThumbnailUrlPicker(null);
    setThumbnailUrlText("");
    setThumbnailUrlError(undefined);
    setUrlUpload((current) => {
      cleanupTemporaryHlsUpload(current);
      cleanupTemporaryMagnetUpload(current);
      revokeThumbnail(current.thumbnail?.generated);
      hlsThumbnailGeneratingRef.current = false;
      hlsThumbnailPromiseRef.current = null;
      return { status: "pending", message: "已从等待队列开始导入" };
    });
    setQueuedUrlPreparedTaskId(task.id);
  }

  function addQueuedUrlTaskFromDraft() {
    const nextUrl = queuedUrlDraft.trim();
    const error = validateSourceUrl(nextUrl);
    if (error) {
      setQueuedUrlDraftError(error);
      return;
    }

    const duplicateCurrent = mode === "url" && normalizedSourceUrl === nextUrl && urlUpload.status !== "done";
    const duplicateQueued = queuedUrlTasksRef.current.some((task) => task.sourceUrl === nextUrl);
    if (duplicateCurrent || duplicateQueued) {
      setQueuedUrlDraftError("该链接已在任务列表中");
      return;
    }

    setQueuedUrlTasks((current) => [
      ...current,
      makeQueuedUrlUploadTask(nextUrl, uploadDirectoryPath, remark.trim())
    ]);
    setQueuedUrlDraft("");
    setQueuedUrlDraftError(undefined);
  }

  function removeQueuedUrlTask(id: string) {
    setQueuedUrlTasks((current) => current.filter((task) => task.id !== id));
  }

  function deleteTask(id: string) {
    if (activeUploadRef.current) {
      return;
    }

    setItems((current) => {
      const target = current.find((item) => item.id === id);
      revokeThumbnail(target?.thumbnail?.generated);
      return current.filter((item) => item.id !== id);
    });
    setQueuedUrlTasks((current) => current.filter((task) => task.id !== id));
    removeUploadTask(id);

    if (activePersistedTaskIdRef.current === id) {
      setActivePersistedTaskId(null);
    }

    if (id === "url" && !submitting && !checkingConflicts) {
      urlRuntimeStore.reset();
      setUrlUpload((current) => {
        cleanupTemporaryHlsUpload(current);
        cleanupTemporaryMagnetUpload(current);
        revokeThumbnail(current.thumbnail?.generated);
        return { status: "pending" };
      });
      setSourceUrl("");
      setSourceHeaderRows([]);
    }
  }

  function resetQueuedUrlDraftState() {
    setQueuedUrlDraft("");
    setQueuedUrlDraftError(undefined);
    setQueuedUrlPreparedTaskId(null);
    queuedUrlLaunchingRef.current = false;
  }

  function clearSettledTasks() {
    if (activeUploadRef.current || submitting || checkingConflicts) {
      return;
    }

    preserveHiddenUploadStateRef.current = false;
    clearCurrentPersistedTask({ allowFallback: false });
    resetQueuedUrlDraftState();
    abortUploadTask(activeUploadRef.current);
    activeUploadRef.current = null;
    hlsThumbnailGeneratingRef.current = false;
    hlsThumbnailPromiseRef.current = null;
    urlRuntimeStore.reset();
    setActiveUploadKind(null);
    setActiveUploadItemId(null);
    setStopRequested(false);
    setItems((current) => {
      current.forEach((item) => revokeThumbnail(item.thumbnail?.generated));
      return [];
    });
    setUrlUpload((current) => {
      cleanupTemporaryHlsUpload(current);
      cleanupTemporaryMagnetUpload(current);
      revokeThumbnail(current.thumbnail?.generated);
      return { status: "pending" };
    });
    setMode("file");
    setSourceUrl("");
    setSourceHeaderRows([]);
    setCurlImportOpen(false);
    setCurlImportText("");
    setCurlImportError(undefined);
    setThumbnailUrlPicker(null);
    setThumbnailUrlText("");
    setThumbnailUrlError(undefined);
    setRemark("");
    setSubmitting(false);
    setCheckingConflicts(false);
    setDragOver(false);
    setUploadDirectoryPath(directoryPath);
  }

  function resumeLocalFile(file: File) {
    const target = items.find((item) => item.recoveredLocalPlaceholder);
    if (!target?.retry) {
      addFiles([file]);
      return;
    }

    if (file.name !== target.file.name || file.size !== target.retry.size) {
      onError(`请选择同一个文件：${target.file.name}（${formatBytes(target.retry.size)}）`);
      return;
    }

    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? {
              ...item,
              file,
              status: "error",
              message: "已重新关联本地文件，可继续上传未完成分片",
              progress: retryFailureProgress(target.retry!, "待继续上传"),
              thumbnail: canAutoGenerateThumbnail(file) ? { status: "idle" } : undefined,
              recoveredLocalPlaceholder: false
            }
          : item
      )
    );
  }

  useImperativeHandle(ref, () => ({
    stopCurrentUpload,
    hasActiveUpload: () => Boolean(activeUploadRef.current),
    clearSettledTasks,
    deleteTask,
    resumeLocalFile
  }));

  function emitUploadTaskSnapshot(runtime: UploadRuntimeState = urlRuntimeStore.getSnapshot()) {
    const state = uploadDialogStateRef.current;
    if (!state.onTaskSnapshotChange) return;

    const snapshot = createUploadTaskSnapshot({
      mode: state.mode,
      items: itemsRef.current,
      localRuntime: localRuntimeSnapshot(itemsRef.current),
      urlUpload: urlUploadRef.current,
      urlRuntime: runtime,
      queuedUrlTasks: queuedUrlTasksRef.current,
      sourceUrl: state.sourceUrl,
      uploadDirectoryPath: state.uploadDirectoryPath,
      activeUploadKind: state.activeUploadKind,
      activeUploadItemId: state.activeUploadItemId,
      activePersistedTaskId: state.activePersistedTaskId,
      stopRequested: state.stopRequested,
      running: state.uploadBusy,
      persistedTasks: readUploadTaskQueue().tasks
    });

    const snapshotKey = uploadTaskSnapshotKey(snapshot);
    if (snapshotKey === lastTaskSnapshotKeyRef.current) {
      return;
    }
    const structureKey = uploadTaskSnapshotStructureKey(snapshot);
    const urgentSnapshot = structureKey !== lastTaskSnapshotStructureKeyRef.current;
    lastTaskSnapshotStructureKeyRef.current = structureKey;
    lastTaskSnapshotKeyRef.current = snapshotKey;
    scheduleTaskSnapshotChange(snapshot, state.onTaskSnapshotChange, urgentSnapshot);
  }

  useEffect(() => {
    uploadDialogStateRef.current = {
      mode,
      queuedUrlTasks,
      sourceUrl: normalizedSourceUrl,
      uploadDirectoryPath,
      activeUploadKind,
      activeUploadItemId,
      activePersistedTaskId,
      stopRequested,
      uploadBusy,
      onTaskSnapshotChange
    };
    emitUploadTaskSnapshot();
  }, [
    activeUploadItemId,
    activeUploadKind,
    activePersistedTaskId,
    items,
    mode,
    normalizedSourceUrl,
    onTaskSnapshotChange,
    queuedUrlTasks,
    stopRequested,
    uploadBusy,
    uploadDirectoryPath,
    urlUpload
  ]);

  useEffect(() => {
    return urlRuntimeStore.subscribe(() => {
      emitUploadTaskSnapshot(urlRuntimeStore.getSnapshot());
    });
  }, [urlRuntimeStore]);

  useEffect(() => {
    const unsubscribers = items
      .map((item) => item.runtimeStore?.subscribe(() => emitUploadTaskSnapshot()))
      .filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [items]);

  useEffect(() => {
    return () => {
      if (taskSnapshotTimerRef.current !== null) {
        window.clearTimeout(taskSnapshotTimerRef.current);
        taskSnapshotTimerRef.current = null;
      }
      pendingTaskSnapshotRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pendingMagnetResume) return;
    if (!sourceUrl.trim() || !urlUpload.magnet?.import) return;
    if (urlUpload.magnet.import.status === "ready" || urlUpload.magnet.import.status === "done" || urlUpload.magnet.import.status === "failed" || urlUpload.magnet.import.status === "cancelled") {
      return;
    }

    setPendingMagnetResume(false);
    void submitMagnetUpload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMagnetResume, sourceUrl, urlUpload.magnet?.import?.id, urlUpload.magnet?.import?.status]);

  function scheduleTaskSnapshotChange(
    snapshot: UploadTaskSnapshot | null,
    onChange: (snapshot: UploadTaskSnapshot | null) => void,
    urgent: boolean
  ) {
    if (urgent) {
      if (taskSnapshotTimerRef.current !== null) {
        window.clearTimeout(taskSnapshotTimerRef.current);
        taskSnapshotTimerRef.current = null;
      }
      pendingTaskSnapshotRef.current = null;
      onChange(snapshot);
      return;
    }

    pendingTaskSnapshotRef.current = snapshot;
    if (taskSnapshotTimerRef.current !== null) {
      return;
    }

    taskSnapshotTimerRef.current = window.setTimeout(() => {
      taskSnapshotTimerRef.current = null;
      const pending = pendingTaskSnapshotRef.current;
      pendingTaskSnapshotRef.current = null;
      onChange(pending);
    }, TASK_SNAPSHOT_UPDATE_INTERVAL_MS);
  }

  const idleThumbnailTargetKey = useMemo(
    () => {
      if (!open) return null;
      const target = items.find((item) => item.thumbnail?.status === "idle");
      return target ? `${target.id}:${target.file.name}:${target.file.size}:${target.file.lastModified}` : null;
    },
    [items, open]
  );

  useEffect(() => {
    const idleThumbnailTarget = idleThumbnailTargetKey
      ? itemsRef.current.find((item) => `${item.id}:${item.file.name}:${item.file.size}:${item.file.lastModified}` === idleThumbnailTargetKey)
      : null;
    if (!idleThumbnailTarget) return;

    const targetId = idleThumbnailTarget.id;
    setItems((current) =>
      current.map((item) =>
        item.id === targetId
          ? { ...item, thumbnail: { status: "generating", message: "正在生成缩略图" } }
          : item
      )
    );

    void generateThumbnailFromFile(idleThumbnailTarget.file)
      .then((thumbnail) => {
        setItems((current) =>
          current.map((item) => {
            if (item.id !== targetId) return item;
            revokeThumbnail(item.thumbnail?.generated);
            return { ...item, thumbnail: { status: "ready", generated: thumbnail } };
          })
        );
      })
      .catch((error) => {
        setItems((current) =>
          current.map((item) =>
            item.id === targetId
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
  }, [idleThumbnailTargetKey]);

  function handleModeChange(nextMode: UploadMode) {
    if (uploadBusy || mode === nextMode) return;
    setMode(nextMode);
  }

  function handleSourceUrlChange(value: string) {
    setSourceUrl(value);
    urlRuntimeStore.reset();
    setUrlUpload((current) => {
      cleanupTemporaryHlsUpload(current);
      cleanupTemporaryMagnetUpload(current);
      revokeThumbnail(current.thumbnail?.generated);
      hlsThumbnailGeneratingRef.current = false;
      hlsThumbnailPromiseRef.current = null;
      return { status: "pending" };
    });
  }

  function resetUrlRemoteStateForHeaderChange() {
    setUrlUpload((current) => {
      if (current.status === "uploading" || current.status === "done") {
        return current;
      }

      const shouldResetRemoteState = current.retry || current.hls || current.magnet || current.thumbnail;
      if (!shouldResetRemoteState) {
        return current;
      }

      cleanupTemporaryHlsUpload(current);
      cleanupTemporaryMagnetUpload(current);
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
        hls: undefined,
        magnet: undefined
      };
    });
  }

  function updateSourceHeaderRow(id: string, patch: Partial<Pick<SourceHeaderRow, "name" | "value">>) {
    setSourceHeaderRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              ...("name" in patch ? { name: normalizeHeaderKeyInput(patch.name ?? "") } : {}),
              ...("value" in patch ? { value: patch.value ?? "" } : {})
            }
          : row
      )
    );
    resetUrlRemoteStateForHeaderChange();
  }

  function addSourceHeaderRow() {
    setSourceHeaderRows((current) => [...current, makeSourceHeaderRow()]);
    resetUrlRemoteStateForHeaderChange();
  }

  function removeSourceHeaderRow(id: string) {
    setSourceHeaderRows((current) => current.filter((row) => row.id !== id));
    resetUrlRemoteStateForHeaderChange();
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
      const headerResult = sourceHeaderRowsFromCurlHeaders(parsed.headers);

      if (headerResult.rows.length > 0) {
        parseSourceHeaderRows(headerResult.rows);
      }

      handleSourceUrlChange(parsed.url);
      setSourceHeaderRows(headerResult.rows);
      resetUrlRemoteStateForHeaderChange();
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
    setUrlUpload((current) => {
      if (current.status === "uploading" || current.status === "done") {
        return current;
      }

      return {
        ...current,
        status: "pending",
        message: undefined,
        progress: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false,
        magnet: current.magnet
          ? {
              ...current.magnet,
              uploads: undefined,
              fileDecisions: resetMagnetDecisionsForDirectoryChange(current.magnet.fileDecisions)
            }
          : current.magnet
      };
    });
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

  function toggleMagnetFileSelection(fileIndex: number, selected: boolean) {
    setUrlUpload((current) => {
      const magnet = current.magnet;
      if (!magnet) return current;
      const selectedSet = new Set(magnet.selectedIndexes);
      if (selected) {
        selectedSet.add(fileIndex);
      } else {
        selectedSet.delete(fileIndex);
      }
      return {
        ...current,
        magnet: {
          ...magnet,
          selectedIndexes: Array.from(selectedSet).sort((left, right) => left - right)
        }
      };
    });
  }

  function selectAllMagnetFiles(uploadableOnly = true) {
    setUrlUpload((current) => {
      const magnet = current.magnet;
      if (!magnet?.import) return current;
      return {
        ...current,
        magnet: {
          ...magnet,
          selectedIndexes: magnet.import.files
            .filter((file) => !uploadableOnly || file.size <= maxMultipartBytes)
            .map((file) => file.file_index)
        }
      };
    });
  }

  function clearMagnetFileSelection() {
    setUrlUpload((current) => current.magnet
      ? { ...current, magnet: { ...current.magnet, selectedIndexes: [] } }
      : current
    );
  }

  function updateMagnetFileName(fileIndex: number, value: string) {
    setUrlUpload((current) => {
      const magnet = current.magnet;
      const file = magnet?.import?.files.find((candidate) => candidate.file_index === fileIndex);
      if (!magnet || !file) return current;

      const fileNameOverride = magnetFileNameOverrideValue(file, value);
      const nextDecisions = {
        ...(magnet.fileDecisions ?? {}),
        [fileIndex]: {
          ...(magnet.fileDecisions?.[fileIndex] ?? {}),
          fileNameOverride,
          conflictAction: "error" as FileNameConflictAction,
          conflict: undefined
        }
      };

      return {
        ...current,
        status: "pending",
        message: undefined,
        progress: undefined,
        magnet: {
          ...magnet,
          fileDecisions: nextDecisions
        }
      };
    });
  }

  function setMagnetFileNameEditing(fileIndex: number, editing: boolean) {
    setUrlUpload((current) => {
      const magnet = current.magnet;
      const file = magnet?.import?.files.find((candidate) => candidate.file_index === fileIndex);
      if (!magnet || !file) return current;

      return {
        ...current,
        magnet: {
          ...magnet,
          fileDecisions: {
            ...(magnet.fileDecisions ?? {}),
            [fileIndex]: {
              ...(magnet.fileDecisions?.[fileIndex] ?? {}),
              editingFileName: editing,
              fileNameOverride: editing && magnet.fileDecisions?.[fileIndex]?.fileNameOverride === undefined
                ? file.file_name
                : magnet.fileDecisions?.[fileIndex]?.fileNameOverride
            }
          }
        }
      };
    });
  }

  function resolveMagnetFileConflict(fileIndex: number, action: FileNameConflictAction) {
    setUrlUpload((current) => {
      const magnet = current.magnet;
      const file = magnet?.import?.files.find((candidate) => candidate.file_index === fileIndex);
      const conflict = magnet?.fileDecisions?.[fileIndex]?.conflict;
      if (!magnet || !file || !conflict) return current;

      const fileName = action === "overwrite" ? conflict.fileName : conflict.suggestedName;
      return {
        ...current,
        status: "pending",
        message: action === "overwrite" ? "已选择覆盖同名磁力文件" : undefined,
        progress: undefined,
        magnet: {
          ...magnet,
          fileDecisions: {
            ...(magnet.fileDecisions ?? {}),
            [fileIndex]: {
              ...(magnet.fileDecisions?.[fileIndex] ?? {}),
              fileNameOverride: magnetFileNameOverrideValue(file, fileName),
              editingFileName: false,
              conflict: undefined,
              conflictAction: action
            }
          }
        }
      };
    });
  }

  function resolveAllMagnetConflictsAsOverwrite() {
    setUrlUpload((current) => {
      const magnet = current.magnet;
      if (!magnet?.import) return current;

      const selected = new Set(magnet.selectedIndexes);
      const nextDecisions: Record<number, MagnetFileDecision> = { ...(magnet.fileDecisions ?? {}) };
      for (const file of magnet.import.files) {
        if (!selected.has(file.file_index)) continue;
        const decision = nextDecisions[file.file_index];
        if (!decision?.conflict) continue;

        nextDecisions[file.file_index] = {
          ...decision,
          fileNameOverride: magnetFileNameOverrideValue(file, decision.conflict.fileName),
          editingFileName: false,
          conflict: undefined,
          conflictAction: "overwrite"
        };
      }

      return {
        ...current,
        status: "pending",
        message: "已选择覆盖所有冲突磁力文件",
        progress: undefined,
        magnet: {
          ...magnet,
          fileDecisions: nextDecisions
        }
      };
    });
  }

  function validateSourceUrl(value: string): string | undefined {
    const normalized = value.trim();

    if (!normalized) {
      return "请粘贴要上传的 URL";
    }

    if (isLikelyMagnetUrl(normalized)) {
      try {
        const url = new URL(normalized);
        if (url.protocol !== "magnet:" || !url.searchParams.get("xt")) {
          return "请输入完整的磁力链接，例如 magnet:?xt=urn:btih:...";
        }
      } catch {
        return "请输入完整的磁力链接，例如 magnet:?xt=urn:btih:...";
      }
      return undefined;
    }

    try {
      const url = new URL(normalized);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "仅支持 http/https URL 或 magnet 磁力链接";
      }
    } catch {
      return "请输入完整的 URL，例如 https://example.com/file.pdf";
    }
    return undefined;
  }

  function readSourceHeadersForUpload(): { ok: true; headers?: SourceRequestHeaders } | { ok: false } {
    try {
      const headers = parseSourceHeaderRows(sourceHeaderRows);
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

  function restorePersistedUploadTask(task: PersistedUploadTask) {
    setUploadDirectoryPath(task.directoryPath);
    setRemark(task.remark ?? "");

    if (task.kind === "local") {
      const item = makePlaceholderLocalItem(task);
      setMode("file");
      setItems([item]);
      setUrlUpload({ status: "pending" });
      onErrorRef.current(`检测到未完成的本地上传：${task.fileName}。请重新选择同一个文件后继续上传。`);
      return;
    }

    setMode("url");
    setSourceUrl(task.sourceUrl);
    setSourceHeaderRows(sourceHeaderRowsFromHeaders(task.kind === "magnet" ? undefined : task.sourceHeaders));
    setItems([]);

    if (task.kind === "url-multipart") {
      seedUploadRuntimeStore(urlRuntimeStore, retryFailureProgress(task.retry, "刷新后待继续"));
      setUrlUpload({
        status: "error",
        message: "检测到未完成的 URL 上传，可点击继续完成",
        retry: task.retry,
        fileNameOverride: task.fileNameOverride,
        conflictAction: task.retry.conflictAction,
        progress: undefined
      });
      window.setTimeout(() => {
        void retryUrlMultipart(task.retry);
      }, 0);
      return;
    }

    if (task.kind === "hls") {
      const hlsState: HlsUrlState = {
        assetId: task.retry.assetId,
        segmentCount: task.retry.segmentCount,
        previewPlaylistUrl: task.retry.previewPlaylistUrl,
        retry: task.retry,
        ...(task.variantId ? { variantId: task.variantId } : {})
      };
      seedUploadRuntimeStore(urlRuntimeStore, hlsRetryFailureProgress(task.retry, "刷新后待继续"));
      setUrlUpload({
        status: "error",
        message: "检测到未完成的 HLS 上传，可点击继续完成",
        fileNameOverride: task.fileNameOverride,
        conflictAction: task.retry.conflictAction,
        progress: undefined,
        hls: hlsState
      });
      window.setTimeout(() => {
        void retryHlsUpload(task.retry);
      }, 0);
      return;
    }

    window.setTimeout(() => {
      void restoreAndResumeMagnetUpload(task);
    }, 0);
  }

  async function restoreAndResumeMagnetUpload(task: PersistedMagnetUploadTask) {
    seedUploadRuntimeStore(urlRuntimeStore, {
      completed: 0,
      total: Math.max(1, task.selectedIndexes.length),
      label: "读取磁力任务状态"
    });
    setUrlUpload({
      status: "uploading",
      message: "正在恢复磁力导入任务",
      progress: undefined,
      magnet: {
        selectedIndexes: task.selectedIndexes,
        ...(task.uploads ? { uploads: task.uploads } : {})
      }
    });

    try {
      const response = await getMagnetUploadStatus(task.importId);
      seedUploadRuntimeStore(
        urlRuntimeStore,
        response.magnet.status === "ready"
          ? undefined
          : { completed: 0, total: Math.max(1, task.selectedIndexes.length), label: magnetStatusProgressLabel("继续磁力任务", response.magnet) }
      );
      setUrlUpload((current) => ({
        ...current,
        status: response.magnet.status === "ready" ? "pending" : "uploading",
        message: response.magnet.status === "ready" ? "磁力文件已解析，点击上传继续导入" : "已恢复磁力导入任务",
        progress: undefined,
        magnet: mergeMagnetState(current.magnet, {
          import: response.magnet,
          selectedIndexes: task.selectedIndexes,
          ...(task.uploads ? { uploads: task.uploads } : {})
        })
      }));

      if (response.magnet.status !== "ready" && response.magnet.status !== "done" && response.magnet.status !== "failed" && response.magnet.status !== "cancelled") {
        setPendingMagnetResume(true);
      }
    } catch (error) {
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message: `恢复磁力任务失败：${errorMessage(error)}`,
        progress: undefined
      }));
      onErrorRef.current(`恢复磁力任务失败：${errorMessage(error)}`);
    }
  }

  function sourceHeadersForPersistence(): SourceRequestHeaders | undefined {
    try {
      return parseSourceHeaderRows(sourceHeaderRows);
    } catch {
      return undefined;
    }
  }

  function setActivePersistedTaskId(taskId: string | null) {
    activePersistedTaskIdRef.current = taskId;
    setActivePersistedTaskIdState(taskId);
  }

  function persistLocalUploadTask(item: QueueItem, retry: MultipartRetryState) {
    const now = Date.now();
    const taskId = makePersistedTaskId("local", retry.uploadId);
    upsertUploadTask({
      version: 1,
      id: taskId,
      kind: "local",
      status: item.recoveredLocalPlaceholder ? "waiting-file" : "running",
      savedAt: now,
      updatedAt: now,
      directoryPath: effectiveDirectoryPath(item, uploadDirectoryPath),
      ...(remark.trim() ? { remark: remark.trim() } : {}),
      fileName: item.file.name,
      mimeType: item.file.type || "application/octet-stream",
      size: item.file.size,
      lastModified: item.file.lastModified,
      ...(item.relativePath ? { relativePath: item.relativePath } : {}),
      retry
    });
    setActivePersistedTaskId(taskId);
  }

  function persistUrlMultipartUploadTask(retry: MultipartRetryState, fileNameOverride?: string) {
    const sourceHeaders = sourceHeadersForPersistence();
    const safeHeaders = sanitizeSourceHeadersForPersistence(sourceHeaders);
    const now = Date.now();
    const taskId = makePersistedTaskId("url-multipart", retry.uploadId);
    upsertUploadTask({
      version: 1,
      id: taskId,
      kind: "url-multipart",
      status: "running",
      savedAt: now,
      updatedAt: now,
      directoryPath: uploadDirectoryPath,
      ...(remark.trim() ? { remark: remark.trim() } : {}),
      sourceUrl: normalizedSourceUrl,
      ...(fileNameOverride ? { fileNameOverride } : {}),
      ...(safeHeaders.headers ? { sourceHeaders: safeHeaders.headers } : {}),
      ...(safeHeaders.strippedHeaderNames ? { strippedHeaderNames: safeHeaders.strippedHeaderNames } : {}),
      retry
    });
    setActivePersistedTaskId(taskId);
  }

  function persistHlsUploadTask(retry: HlsRetryState, fileNameOverride?: string, variantId?: string) {
    const sourceHeaders = sourceHeadersForPersistence();
    const safeHeaders = sanitizeSourceHeadersForPersistence(sourceHeaders);
    const now = Date.now();
    const taskId = makePersistedTaskId("hls", retry.assetId);
    upsertUploadTask({
      version: 1,
      id: taskId,
      kind: "hls",
      status: "running",
      savedAt: now,
      updatedAt: now,
      directoryPath: uploadDirectoryPath,
      ...(remark.trim() ? { remark: remark.trim() } : {}),
      sourceUrl: normalizedSourceUrl,
      ...(fileNameOverride ? { fileNameOverride } : {}),
      ...(variantId ? { variantId } : {}),
      ...(safeHeaders.headers ? { sourceHeaders: safeHeaders.headers } : {}),
      ...(safeHeaders.strippedHeaderNames ? { strippedHeaderNames: safeHeaders.strippedHeaderNames } : {}),
      retry
    });
    setActivePersistedTaskId(taskId);
  }

  function persistMagnetUploadTask(importId: string, selectedIndexes: number[], uploads?: MagnetUploadEntry[]) {
    const now = Date.now();
    const taskId = makePersistedTaskId("magnet", importId);
    removeStaleMagnetUploadTasks(normalizedSourceUrl, taskId);
    upsertUploadTask({
      version: 1,
      id: taskId,
      kind: "magnet",
      status: "running",
      savedAt: now,
      updatedAt: now,
      directoryPath: uploadDirectoryPath,
      ...(remark.trim() ? { remark: remark.trim() } : {}),
      sourceUrl: normalizedSourceUrl,
      importId,
      selectedIndexes,
      ...(uploads ? { uploads } : {})
    });
    setActivePersistedTaskId(taskId);
  }

  function removeStaleMagnetUploadTasks(sourceUrl: string, keepTaskId?: string) {
    const queue = readUploadTaskQueue();
    const tasks = queue.tasks.filter((task) => {
      if (task.kind !== "magnet") {
        return true;
      }
      if (keepTaskId && task.id === keepTaskId) {
        return true;
      }
      return task.sourceUrl !== sourceUrl;
    });

    if (tasks.length !== queue.tasks.length) {
      writeUploadTaskQueue({ version: 1, tasks });
    }
  }

  function clearCurrentPersistedTask(options: { allowFallback?: boolean } = {}) {
    const taskId = currentPersistedTaskId();
    if (taskId) {
      removeUploadTask(taskId);
      if (activePersistedTaskIdRef.current === taskId) {
        setActivePersistedTaskId(null);
      }
      return;
    }

    if (options.allowFallback === false) {
      return;
    }

    const fallback = firstResumableUploadTask();
    if (fallback) {
      removeUploadTask(fallback.id);
      if (activePersistedTaskIdRef.current === fallback.id) {
        setActivePersistedTaskId(null);
      }
    }
  }

  function currentPersistedTaskId(): string | undefined {
    if (activePersistedTaskIdRef.current) {
      return activePersistedTaskIdRef.current;
    }

    const activeTask = activeUploadRef.current;
    const currentUrlUpload = urlUploadRef.current;

    if (activeTask?.kind === "local" && activeTask.itemId) {
      const itemRetry = itemsRef.current.find((item) => item.id === activeTask.itemId)?.retry;
      if (itemRetry?.kind === "local") {
        return makePersistedTaskId("local", itemRetry.uploadId);
      }
    }

    const magnetImportId = unfinishedMagnetImportId(currentUrlUpload);
    if (magnetImportId) {
      return makePersistedTaskId("magnet", magnetImportId);
    }

    if (currentUrlUpload.hls?.retry) {
      return makePersistedTaskId("hls", currentUrlUpload.hls.retry.assetId);
    }

    if (currentUrlUpload.hls?.assetId) {
      return makePersistedTaskId("hls", currentUrlUpload.hls.assetId);
    }

    if (currentUrlUpload.retry?.kind === "url") {
      return makePersistedTaskId("url-multipart", currentUrlUpload.retry.uploadId);
    }

    return undefined;
  }

  function startUploadTask(kind: "local" | "url", itemId?: string): UploadAbortContext {
    abortUploadTask(activeUploadRef.current);
    acquireUploadTaskLock(uploadTaskLockOwnerRef.current);

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
    setActivePersistedTaskId(null);
    setActiveUploadKind(null);
    setActiveUploadItemId(null);
    setStopRequested(false);
    releaseUploadTaskLock(uploadTaskLockOwnerRef.current);
  }

  function stopCurrentUpload() {
    const task = activeUploadRef.current;
    if (!task || task.cancelled) {
      return;
    }

    const magnetImportId = task.kind === "url" ? unfinishedMagnetImportId(urlUploadRef.current) : undefined;
    task.cancelled = true;
    setStopRequested(true);
    clearCurrentPersistedTask();
    releaseUploadTaskLock(uploadTaskLockOwnerRef.current);
    if (magnetImportId) {
      cancelTemporaryMagnetUpload(magnetImportId);
    }
    abortUploadTask(task);

    if (task.kind === "local" && task.itemId) {
      updateItemProgress(task.itemId, {
        completed: currentItemCompletedChunks(task.itemId),
        total: currentItemChunkCount(task.itemId),
        label: "正在停止上传，保留已完成分片"
      });
    } else if (task.kind === "url") {
      updateUrlProgress({
        completed: urlRuntimeStore.getSnapshot().progress?.completed ?? 0,
        total: urlRuntimeStore.getSnapshot().progress?.total ?? 1,
        failed: urlRuntimeStore.getSnapshot().progress?.failed,
        label: magnetImportId ? "正在停止导入并取消 aria2 下载" : "正在停止导入，保留已完成分片"
      });
    }
  }

  function currentItemCompletedChunks(id: string): number {
    const item = itemsRef.current.find((current) => current.id === id);
    const chunks = item?.runtimeStore?.getSnapshot().chunks ?? item?.chunks;
    return chunks?.filter((chunk) => chunk.status === "completed").length ?? 0;
  }

  function currentItemChunkCount(id: string): number {
    const item = itemsRef.current.find((current) => current.id === id);
    return (item?.runtimeStore?.getSnapshot().chunks ?? item?.chunks)?.length ?? 1;
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

  async function preflightMagnetSelection(
    magnet: MagnetImport,
    selectedIndexes: number[],
    decisions: Record<number, MagnetFileDecision> = urlUploadRef.current.magnet?.fileDecisions ?? {}
  ): Promise<boolean> {
    const selectedSet = new Set(selectedIndexes);
    const selectedFiles = magnet.files.filter((file) =>
      selectedSet.has(file.file_index) &&
      file.status !== "done" &&
      file.size <= maxMultipartBytes
    );
    const entries = selectedFiles.map((file) => {
      const decision = decisions[file.file_index];
      return {
        client_id: String(file.file_index),
        directory_path: magnetTargetDirectoryPath(uploadDirectoryPath, file),
        file_name: effectiveMagnetFileName(file, decision),
        size: file.size
      };
    });

    if (entries.length === 0) {
      return true;
    }

    setCheckingConflicts(true);
    try {
      const response = await preflightUploads(entries);
      const conflictByIndex = new Map<number, UploadPreflightResultEntry>();

      for (const entry of response.entries) {
        if (entry.status !== "conflict") continue;
        const fileIndex = Number(entry.client_id);
        const decision = decisions[fileIndex];
        if (entry.source === "file" && decision?.conflictAction === "overwrite") {
          continue;
        }
        conflictByIndex.set(fileIndex, entry);
      }

      setUrlUpload((current) => {
        if (!current.magnet?.import || current.magnet.import.id !== magnet.id) {
          return current;
        }

        const nextDecisions: Record<number, MagnetFileDecision> = { ...(current.magnet.fileDecisions ?? {}) };
        for (const file of selectedFiles) {
          const conflict = conflictByIndex.get(file.file_index);
          const existing = nextDecisions[file.file_index] ?? {};

          if (conflict) {
            nextDecisions[file.file_index] = {
              ...existing,
              conflict: fileNameConflictFromPreflight(conflict),
              conflictAction: "error",
              editingFileName: false
            };
            continue;
          }

          if (existing.conflict) {
            const { conflict: _conflict, ...rest } = existing;
            nextDecisions[file.file_index] = rest;
          }
        }

        return {
          ...current,
          status: "pending",
          message: conflictByIndex.size > 0
            ? `发现 ${conflictByIndex.size} 个同名磁力文件，请选择全部覆盖或单个改名`
            : current.message,
          progress: undefined,
          magnet: {
            ...current.magnet,
            fileDecisions: nextDecisions
          }
        };
      });

      if (conflictByIndex.size > 0) {
        onError(`发现 ${conflictByIndex.size} 个同名磁力文件，请选择全部覆盖或单个改名`);
        return false;
      }

      return true;
    } catch (error) {
      onError(`磁力文件重复检测失败：${errorMessage(error)}`);
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
            ? (() => {
                resetUploadRuntimeStore(item.runtimeStore);
                return { ...item, status: "uploading", message: undefined, progress: undefined, chunks: undefined, conflict: undefined };
              })()
            : item
        )
      );

      const task = startUploadTask("local", target.id);
      try {
        const fileName = effectiveFileName(target);
        const thumbnail = await resolveLocalThumbnailForUpload(target);
        await uploadLocalMultipart(target, fileName, thumbnail, task);
        successCount += 1;
        seedUploadRuntimeStore(target.runtimeStore!, null, null);
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: "done",
                  message: undefined,
                  progress: undefined,
                  chunks: undefined,
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
        const retryProgress = retry && !conflict
          ? retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片上传失败，可手动重试")
          : undefined;
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? (() => {
                  seedUploadRuntimeStore(item.runtimeStore!, retryProgress, item.runtimeStore?.getSnapshot().chunks ?? item.chunks);
                  return {
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
                    progress: undefined
                  };
                })()
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
    const initialRetry: MultipartRetryState = {
      kind: "local",
      uploadId: upload.id,
      size: upload.size,
      chunkSize: upload.chunk_size,
      chunkCount: upload.chunk_count,
      directAccess: upload.direct_access !== false,
      conflictAction,
      completedChunks: [],
      failedChunks: chunkRange(upload.chunk_count)
    };
    persistLocalUploadTask(target, initialRetry);

    const initialChunks = createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count);
    seedUploadRuntimeStore(target.runtimeStore!, undefined, initialChunks);

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
      persistLocalUploadTask(target, retry);
      throw new MultipartChunkUploadError(
        result.cancelled ? "已停止，可重试未完成分片" : `有 ${result.failedChunks.length} 个分片上传失败，可手动重试`,
        retry,
        result.cancelled
      );
    }

    const completeProgress = {
      completed: upload.chunk_count,
      total: upload.chunk_count,
      label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
    };
    updateItemProgress(target.id, completeProgress);
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
    clearCurrentPersistedTask();
  }

  async function resolveLocalThumbnailForUpload(target: QueueItem): Promise<ThumbnailUploadPayload | undefined> {
    if (target.thumbnail?.status === "ready") {
      return thumbnailStatePayload(target.thumbnail);
    }

    if (target.thumbnail?.status === "removed" || !canAutoGenerateThumbnail(target.file)) {
      return undefined;
    }

    try {
      updateItemThumbnail(target.id, { status: "generating", message: "正在生成缩略图" });
      const generated = await generateThumbnailFromFile(target.file);
      updateItemThumbnail(target.id, { status: "ready", generated });
      return generatedThumbnailPayload(generated);
    } catch (error) {
      updateItemThumbnail(target.id, {
        status: "failed",
        message: error instanceof Error ? error.message : "缩略图生成失败"
      });
      return undefined;
    }
  }

  async function resolveUrlThumbnailForUpload(source: MultipartUpload["thumbnail_source"] | undefined): Promise<ThumbnailUploadPayload | undefined> {
    if (urlUpload.thumbnail?.status === "ready") {
      return thumbnailStatePayload(urlUpload.thumbnail);
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
      return generatedThumbnailPayload(generated);
    } catch (error) {
      updateUrlThumbnail({
        status: "failed",
        message: error instanceof Error ? error.message : "URL 缩略图生成失败"
      });
      return undefined;
    }
  }

  async function resolveMagnetThumbnailForUpload(
    importId: string,
    fileIndex: number,
    upload: MultipartUpload
  ): Promise<ThumbnailUploadPayload | undefined> {
    if (!isVideoUploadCandidate(upload)) {
      return undefined;
    }

    let generated: GeneratedThumbnail | undefined;

    try {
      updateUrlProgress({
        completed: urlRuntimeStore.getSnapshot().progress?.completed ?? 0,
        total: urlRuntimeStore.getSnapshot().progress?.total ?? 1,
        failed: urlRuntimeStore.getSnapshot().progress?.failed,
        label: `正在生成 ${upload.file_name} 缩略图`
      });
      generated = await generateThumbnailFromRemoteSource({
        kind: "video",
        url: magnetThumbnailSourceUrl(importId, fileIndex),
        mime_type: upload.mime_type
      }, upload.file_name);
      return generatedThumbnailPayload(generated);
    } catch {
      return undefined;
    } finally {
      revokeThumbnail(generated);
    }
  }

  async function retryLocalMultipart(
    target: QueueItem,
    retry: MultipartRetryState,
    thumbnail: ThumbnailUploadPayload | undefined,
    task: UploadAbortContext
  ) {
    const syncedRetry = await refreshMultipartRetryState(retry);
    seedUploadRuntimeStore(
      target.runtimeStore!,
      undefined,
      prepareRetryChunks(target.runtimeStore?.getSnapshot().chunks ?? target.chunks, syncedRetry)
    );
    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? { ...item, retry: syncedRetry }
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
      persistLocalUploadTask(target, nextRetry);
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
    clearCurrentPersistedTask();
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
    const concurrency = Math.min(params.concurrency ?? effectiveUploadConcurrency, Math.max(1, chunkIndexes.length));
    let nextIndex = 0;
    const uiUpdates = createChunkUiUpdateBatcher(params.onProgress, params.onChunkState);

    const suffix = concurrency > 1 ? `（${concurrency} 并发）` : "";
    uiUpdates.progress({
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
            onProgress: uiUpdates.progress,
            onChunkState: uiUpdates.chunkState,
            index,
            suffix,
            completed: () => completedSet.size
          });
          completedSet.add(index);
        } catch (error) {
          failedChunks.push(index);
        }

        uiUpdates.progress({
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
          uiUpdates.chunkState(index, {
            status: "failed",
            errorMessage: "已停止"
          });
        }
      }
    }

    uiUpdates.flush();

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

  function createChunkUiUpdateBatcher(
    onProgress: (progress: ChunkProgress) => void,
    onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void
  ) {
    let pendingProgress: ChunkProgress | null = null;
    const pendingChunkStates = new Map<number, Partial<UploadChunkState>>();
    let timerId: number | null = null;

    const flush = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }

      for (const [index, patch] of pendingChunkStates) {
        onChunkState?.(index, patch);
      }
      pendingChunkStates.clear();

      if (pendingProgress) {
        onProgress(pendingProgress);
        pendingProgress = null;
      }
    };

    const schedule = () => {
      if (timerId !== null) {
        return;
      }
      timerId = window.setTimeout(flush, CHUNK_UI_UPDATE_INTERVAL_MS);
    };

    return {
      progress(progress: ChunkProgress) {
        pendingProgress = progress;
        schedule();
      },
      chunkState(index: number, patch: Partial<UploadChunkState>) {
        pendingChunkStates.set(index, {
          ...(pendingChunkStates.get(index) ?? {}),
          ...patch
        });
        schedule();
      },
      flush
    };
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
    const target = itemsRef.current.find((item) => item.id === id);
    if (!target?.runtimeStore) return;
    target.runtimeStore.setState((current) => {
      if (chunkProgressEqual(current.progress, progress)) {
        return current;
      }
      return { ...current, progress };
    });
  }

  function updateItemChunk(id: string, chunkIndex: number, patch: Partial<UploadChunkState>) {
    const target = itemsRef.current.find((item) => item.id === id);
    if (!target?.runtimeStore) return;
    target.runtimeStore.setState((current) => {
      const chunks = updateChunkStates(current.chunks, chunkIndex, patch);
      return chunks === current.chunks ? current : { ...current, chunks };
    });
  }

  function updateUrlChunk(chunkIndex: number, patch: Partial<UploadChunkState>) {
    urlRuntimeStore.setState((current) => {
      const chunks = updateChunkStates(current.chunks, chunkIndex, patch);
      return chunks === current.chunks ? current : { ...current, chunks };
    });
  }

  function updateUrlProgress(progress: ChunkProgress) {
    urlRuntimeStore.setState((current) => {
      if (chunkProgressEqual(current.progress, progress)) {
        return current;
      }
      return {
        ...current,
        progress
      };
    });
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

    if (isLikelyMagnetUrl(normalizedSourceUrl)) {
      await submitMagnetUpload();
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
    seedUploadRuntimeStore(urlRuntimeStore, { completed: 0, total: 1, label: "探测远程文件" });
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: undefined,
      conflict: undefined,
      progress: undefined
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
        const initialRetry: MultipartRetryState = {
          kind: "url",
          uploadId: upload.id,
          size: upload.size,
          chunkSize: upload.chunk_size,
          chunkCount: upload.chunk_count,
          directAccess: upload.direct_access !== false,
          conflictAction,
          completedChunks: [],
          failedChunks: chunkRange(upload.chunk_count)
        };
        persistUrlMultipartUploadTask(initialRetry, fileNameOverride);
        const thumbnail = await resolveUrlThumbnailForUpload(upload.thumbnail_source);
        const initialChunks = createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count);
        seedUploadRuntimeStore(urlRuntimeStore, undefined, initialChunks);
        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          progress: undefined
        }));
        const result = await runConcurrentChunks({
          total: upload.chunk_count,
          taskLabel: "导入分片",
          doneLabel: "已导入",
          concurrency: effectiveUploadConcurrency,
          task,
          requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
          onProgress: updateUrlProgress,
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
          persistUrlMultipartUploadTask(retry, fileNameOverride);
          throw new MultipartChunkUploadError(
            result.cancelled ? "已停止，可重试未完成分片" : `有 ${result.failedChunks.length} 个分片导入失败，可手动重试`,
            retry,
            result.cancelled
          );
        }

        const completeProgress = {
          completed: upload.chunk_count,
          total: upload.chunk_count,
          label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
        };
        seedUploadRuntimeStore(urlRuntimeStore, completeProgress, urlRuntimeStore.getSnapshot().chunks);
        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          progress: undefined
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
      seedUploadRuntimeStore(urlRuntimeStore, null, null);
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "已从 URL 上传",
        progress: undefined,
        chunks: undefined,
        retry: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false
      }));
      clearCurrentPersistedTask();
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
        progress: undefined
      }));
      seedUploadRuntimeStore(
        urlRuntimeStore,
        retry && !conflict
          ? retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片导入失败，可手动重试")
          : null,
        retry && !conflict ? urlRuntimeStore.getSnapshot().chunks : null
      );
      if (retry && !conflict && !stopped) {
        persistUrlMultipartUploadTask(retry, normalizedFileNameOverride(urlUpload.fileNameOverride));
      }
      if (!stopped) {
        onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  async function submitMagnetUpload() {
    const task = startUploadTask("url");
    setSubmitting(true);
    const initialProgress = { completed: 0, total: 1, label: urlUpload.magnet?.import ? "准备磁力导入" : "解析磁力链接" };
    seedUploadRuntimeStore(urlRuntimeStore, initialProgress);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: undefined,
      retry: undefined,
      conflict: undefined,
      progress: undefined
    }));

    try {
      let magnet = urlUpload.magnet?.import;
      let selectedIndexes = urlUpload.magnet?.selectedIndexes ?? [];

      if (!magnet || magnet.status === "failed" || magnet.status === "cancelled" || magnet.status === "probing") {
        magnet = magnet && magnet.status === "probing"
          ? magnet
          : (await probeMagnetUpload(normalizedSourceUrl, task.abortController.signal)).magnet;
        if (magnet.status === "probing") {
          magnet = await waitForMagnetStatus(
            magnet.id,
            task,
            (current) => current.status !== "probing",
            "解析磁力文件列表"
          );
        }
        const parsedMagnet = magnet;
        selectedIndexes = selectedMagnetIndexesForResume(parsedMagnet, maxMultipartBytes);
        persistMagnetUploadTask(parsedMagnet.id, selectedIndexes);
        const parsedProgress = parsedMagnet.status === "ready" || parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled"
          ? null
          : { completed: 0, total: 1, label: magnetStatusProgressLabel("继续磁力任务", parsedMagnet) };
        seedUploadRuntimeStore(urlRuntimeStore, parsedProgress);
        setUrlUpload((current) => ({
          ...current,
          status: parsedMagnet.status === "ready" ? "pending" : parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled" ? "error" : "uploading",
          message: parsedMagnet.status === "ready"
            ? `已解析 ${parsedMagnet.files.length} 个文件，请选择要导入的文件后再次点击上传`
            : parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled"
              ? parsedMagnet.error_message || "磁力链接解析失败"
              : "检测到已有磁力任务，准备继续",
          progress: undefined,
          magnet: mergeMagnetState(current.magnet, {
            import: parsedMagnet,
            selectedIndexes,
            fileDecisions: {}
          })
        }));
        if (parsedMagnet.status !== "ready") {
          if (parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled") {
            throw new Error(parsedMagnet.error_message || "磁力链接解析失败");
          }
        } else {
          await preflightMagnetSelection(parsedMagnet, selectedIndexes, {});
          return;
        }
      }

      if (selectedIndexes.length === 0 && magnet) {
        selectedIndexes = selectedMagnetIndexesForResume(magnet, maxMultipartBytes);
      }
      if (selectedIndexes.length === 0) {
        throw new Error("请选择至少一个磁力文件");
      }

      const currentMagnetState = urlUploadRef.current.magnet;
      const currentDecisions = currentMagnetState?.fileDecisions ?? {};
      if (!(await preflightMagnetSelection(magnet, selectedIndexes, currentDecisions))) {
        return;
      }
      const fileOptions = magnetFileUploadOptions(magnet, selectedIndexes, currentDecisions);
      const conflictActionByFileIndex = new Map<number, FileNameConflictAction>(
        fileOptions.map((option) => [option.file_index, option.on_conflict ?? "error"])
      );

      const init = await initMagnetUpload({
        import_id: magnet.id,
        file_indexes: selectedIndexes,
        file_options: fileOptions,
        directory_path: uploadDirectoryPath,
        ...(urlUpload.conflictAction && urlUpload.conflictAction !== "error" ? { on_conflict: urlUpload.conflictAction } : {}),
        ...(remark.trim() ? { remark: remark.trim() } : {})
      }, task.abortController.signal);
      magnet = init.magnet;
      const uploads = init.uploads.map((entry) => ({
        fileIndex: entry.file_index,
        upload: entry.upload,
        targetDirectoryPath: entry.target_directory_path,
        conflictAction: conflictActionByFileIndex.get(entry.file_index) ?? "error"
      }));
      persistMagnetUploadTask(magnet.id, selectedIndexes, uploads);

      const waitingProgress = { completed: 0, total: uploads.length, label: "等待磁力文件下载完成" };
      seedUploadRuntimeStore(urlRuntimeStore, waitingProgress);
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        message: `aria2 正在下载 ${uploads.length} 个文件`,
        progress: undefined,
        magnet: mergeMagnetState(current.magnet, {
          import: magnet,
          selectedIndexes,
          uploads
        })
      }));

      magnet = await waitForMagnetStatus(
        magnet.id,
        task,
        (current) => current.status === "downloaded" || current.status === "importing" || current.status === "done" || current.status === "failed" || current.status === "cancelled",
        "下载磁力文件"
      );
      if (magnet.status === "failed" || magnet.status === "cancelled") {
        throw new Error(magnet.error_message || "磁力文件下载失败");
      }
      if (magnet.status === "done") {
        seedUploadRuntimeStore(urlRuntimeStore, null, null);
        setUrlUpload((current) => ({
          ...current,
          status: "done",
          message: "磁力任务已完成",
          progress: undefined,
          chunks: undefined,
          magnet: mergeMagnetState(current.magnet, current.magnet ? { ...current.magnet, import: magnet, uploads } : { import: magnet, selectedIndexes, uploads })
        }));
        onUploaded(uploads.length);
        clearCurrentPersistedTask();
        return;
      }

      let completedFiles = 0;
      for (const entry of uploads) {
        const { upload, fileIndex, conflictAction } = entry;
        if (task.cancelled) {
          throw new Error("已停止");
        }
        const magnetFile = magnet.files.find((file) => file.file_index === fileIndex);
        if (magnetFile?.status === "done") {
          completedFiles += 1;
          continue;
        }

        const initialChunks = createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count);
        const importProgress = {
          completed: completedFiles,
          total: uploads.length,
          label: `导入文件 ${completedFiles + 1}/${uploads.length}`
        };
        seedUploadRuntimeStore(urlRuntimeStore, importProgress, initialChunks);
        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          message: `正在导入 ${upload.file_name}`,
          progress: undefined,
          magnet: mergeMagnetState(current.magnet, current.magnet ? { ...current.magnet, import: magnet, uploads } : { import: magnet, selectedIndexes, uploads })
        }));

        const result = await runConcurrentChunks({
          total: upload.chunk_count,
          taskLabel: `导入 ${upload.file_name}`,
          doneLabel: `已导入 ${upload.file_name}`,
          concurrency: effectiveUploadConcurrency,
          task,
          requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
          onProgress: (progress) => {
            updateUrlProgress({
              completed: progress.completed,
              total: progress.total,
              failed: progress.failed,
              label: `${completedFiles + 1}/${uploads.length} · ${progress.label}`
            });
          },
          onChunkState: updateUrlChunk,
          onChunk: async (index, signal) => {
            await uploadMagnetMultipartChunk(magnet!.id, fileIndex, index, signal);
          }
        });

        if (result.failedChunks.length > 0 || result.cancelled) {
          throw new Error(result.cancelled ? "已停止，可重新发起磁力导入" : `${upload.file_name} 有 ${result.failedChunks.length} 个分片导入失败`);
        }

        const thumbnail = await resolveMagnetThumbnailForUpload(magnet!.id, fileIndex, upload);
        if (task.cancelled) {
          throw new Error("已停止");
        }

        updateUrlProgress({
          completed: upload.chunk_count,
          total: upload.chunk_count,
          label: `${completedFiles + 1}/${uploads.length} · 正在生成 ${upload.file_name} 文件索引`
        });
        await runAbortableUploadRequest(task, URL_CHUNK_REQUEST_TIMEOUT_MS, (signal) =>
          completeMagnetMultipartUpload(magnet!.id, fileIndex, thumbnail, signal, conflictAction)
        );
        completedFiles += 1;
      }

      const latest = await getMagnetUploadStatus(magnet.id, task.abortController.signal);
      seedUploadRuntimeStore(urlRuntimeStore, null, null);
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: `已导入 ${completedFiles} 个磁力文件`,
        progress: undefined,
        chunks: undefined,
        magnet: mergeMagnetState(current.magnet, {
          ...(current.magnet ?? { selectedIndexes }),
          import: latest.magnet,
          selectedIndexes,
          uploads
        })
      }));
      clearCurrentPersistedTask();
      onUploaded(completedFiles);
    } catch (uploadError) {
      const stopped = task.cancelled || isAbortError(uploadError);
      const conflict = fileNameConflictFromError(uploadError);
      const message = stopped
        ? "已停止"
        : conflict
          ? "磁力文件与目标目录已有文件重名，请换目录或先处理同名文件"
          : uploadError instanceof ApiError
            ? uploadError.message
            : uploadError instanceof Error
              ? uploadError.message
              : "磁力导入失败";
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message: conflict ? undefined : message,
        conflict,
        conflictAction: "error",
        progress: undefined
      }));
      if (conflict || !urlUploadRef.current.magnet?.import) {
        seedUploadRuntimeStore(urlRuntimeStore, null, null);
      }
      if (!stopped && urlUploadRef.current.magnet?.import) {
        persistMagnetUploadTask(
          urlUploadRef.current.magnet.import.id,
          urlUploadRef.current.magnet.selectedIndexes,
          urlUploadRef.current.magnet.uploads
        );
      }
      if (!stopped) {
        onError(message);
      }
    } finally {
      finishUploadTask(task);
      setSubmitting(false);
    }
  }

  async function waitForMagnetStatus(
    importId: string,
    task: UploadAbortContext,
    isDone: (current: MagnetImport) => boolean,
    label: string
  ): Promise<MagnetImport> {
    const deadline = Date.now() + MAGNET_DOWNLOAD_TIMEOUT_MS;
    let transientFailures = 0;

    while (true) {
      if (task.cancelled) {
        throw new Error("已停止");
      }

      let magnet: MagnetImport;
      try {
        const response = await runAbortableUploadRequest(task, URL_CHUNK_REQUEST_TIMEOUT_MS, (signal) =>
          getMagnetUploadStatus(importId, signal)
        );
        magnet = response.magnet;
        transientFailures = 0;
      } catch (error) {
        if (task.cancelled || !isRetryableMagnetStatusError(error)) {
          throw error;
        }

        transientFailures += 1;
        if (transientFailures > MAGNET_STATUS_MAX_TRANSIENT_FAILURES) {
          throw new Error(`${label}状态确认失败：${errorMessage(error)}`);
        }

        const retryLabel = `${label}状态确认失败，自动重试 ${transientFailures}/${MAGNET_STATUS_MAX_TRANSIENT_FAILURES}：${errorMessage(error)}`;
        urlRuntimeStore.setState((current) => ({
          ...current,
          progress: current.progress
            ? { ...current.progress, label: retryLabel }
            : { completed: 0, total: 1, label: retryLabel }
        }));

        if (Date.now() >= deadline) {
          throw new Error(`${label}超时`);
        }

        await delay(MAGNET_STATUS_RETRY_DELAY_MS * transientFailures, task.abortController.signal);
        continue;
      }

      const progressLabel = magnetStatusProgressLabel(label, magnet);
      urlRuntimeStore.setState((current) => ({
        ...current,
        progress: current.progress
          ? { ...current.progress, label: progressLabel }
          : { completed: 0, total: 1, label: progressLabel }
      }));

      setUrlUpload((current) => {
        const nextMagnet = current.magnet
          ? { ...current.magnet, import: magnet }
          : { import: magnet, selectedIndexes: selectedMagnetIndexesForResume(magnet, maxMultipartBytes) };

        if (
          current.magnet?.import &&
          magnetImportStructureKey(current.magnet.import) === magnetImportStructureKey(magnet)
        ) {
          return current;
        }

        return {
          ...current,
          magnet: mergeMagnetState(current.magnet, nextMagnet)
        };
      });

      if (isDone(magnet)) {
        return magnet;
      }

      if (Date.now() >= deadline) {
        throw new Error(`${label}超时`);
      }

      await delay(MAGNET_STATUS_POLL_MS, task.abortController.signal);
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
    seedUploadRuntimeStore(urlRuntimeStore, { completed: 0, total: 1, label: "探测 HLS 播放列表" });
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: undefined,
      retry: undefined,
      conflict: undefined,
      progress: undefined
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
          urlRuntimeStore.reset();
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

      const createHlsTaskProgress = { completed: 0, total: probe.media?.segment_count ?? 1, label: "创建 HLS 上传任务" };
      seedUploadRuntimeStore(urlRuntimeStore, createHlsTaskProgress);
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        message: hlsProbeSummary(probe),
        progress: undefined,
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
      persistHlsUploadTask(completionRetry, fileName, selectedVariantId);
      const initialChunks = createHlsSegmentStates(segments);
      const startProgress = { completed: 0, total: asset.segment_count, label: `开始导入 HLS 片段（${effectiveUploadConcurrency} 并发）` };
      seedUploadRuntimeStore(urlRuntimeStore, startProgress, initialChunks);
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        message: `HLS 视频 · ${asset.segment_count} 个片段`,
        progress: undefined,
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
        concurrency: effectiveUploadConcurrency,
        task,
        requestTimeoutMs: HLS_SEGMENT_REQUEST_TIMEOUT_MS,
        onProgress: updateUrlProgress,
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
        persistHlsUploadTask(retry, fileName, selectedVariantId);
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
      persistHlsUploadTask(completionRetry, fileName, selectedVariantId);
      const indexProgress = { completed: asset.segment_count, total: asset.segment_count, label: "正在生成 HLS 文件索引" };
      seedUploadRuntimeStore(urlRuntimeStore, indexProgress, urlRuntimeStore.getSnapshot().chunks);
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: undefined
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
        chunks: undefined,
        retry: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false,
        hls: current.hls ? withoutHlsRetry(current.hls) : current.hls
      }));
      clearCurrentPersistedTask();
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

      const retryProgress = retry && !conflict
        ? hlsRetryFailureProgress(retry, stopped ? "已停止，可重试未完成 HLS 片段" : "HLS 片段导入失败，可手动重试")
        : undefined;
      seedUploadRuntimeStore(urlRuntimeStore, retryProgress, urlRuntimeStore.getSnapshot().chunks);
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message: conflict ? undefined : message,
        retry: undefined,
        conflict,
        fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
        conflictAction: "error",
        editingFileName: conflict ? true : current.editingFileName,
        progress: undefined,
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
      if (retry && !conflict && !stopped) {
        persistHlsUploadTask(retry, normalizedFileNameOverride(urlUpload.fileNameOverride), urlUpload.hls?.variantId);
      }
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
    persistHlsUploadTask(syncedRetry, normalizedFileNameOverride(urlUpload.fileNameOverride), urlUpload.hls?.variantId);

    setSubmitting(true);
    const hlsRetryProgress = hlsRetryFailureProgress(syncedRetry, "准备重试失败 HLS 片段");
    const hlsRetryChunks = prepareHlsRetryChunks(urlRuntimeStore.getSnapshot().chunks ?? urlUpload.chunks, syncedRetry);
    seedUploadRuntimeStore(urlRuntimeStore, hlsRetryProgress, hlsRetryChunks);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: "准备重试 HLS 片段",
      retry: undefined,
      conflict: undefined,
      progress: undefined,
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
          concurrency: effectiveUploadConcurrency,
          task,
          requestTimeoutMs: HLS_SEGMENT_REQUEST_TIMEOUT_MS,
          onProgress: updateUrlProgress,
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
          persistHlsUploadTask(nextRetry, normalizedFileNameOverride(urlUpload.fileNameOverride), urlUpload.hls?.variantId);
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
        persistHlsUploadTask(syncedRetry, normalizedFileNameOverride(urlUpload.fileNameOverride), urlUpload.hls?.variantId);
      }

      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: undefined
      }));
      updateUrlProgress({
        completed: syncedRetry.segmentCount,
        total: syncedRetry.segmentCount,
        label: "正在生成 HLS 文件索引"
      });
      const thumbnail = await resolveHlsThumbnailForUpload(syncedRetry.previewPlaylistUrl, syncedRetry.fileName);
      await runAbortableUploadRequest(task, HLS_SEGMENT_REQUEST_TIMEOUT_MS, (signal) =>
        completeHlsUpload(syncedRetry.assetId, thumbnail, signal, conflictAction)
      );
      setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "已导入 HLS 视频",
        progress: undefined,
        chunks: undefined,
        retry: undefined,
        conflict: undefined,
        conflictAction: "error",
        editingFileName: false,
        hls: current.hls ? withoutHlsRetry(current.hls) : current.hls
      }));
      clearCurrentPersistedTask();
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
        progress: undefined,
        hls: {
          ...(current.hls ?? {}),
          assetId: nextRetry.assetId,
          segmentCount: nextRetry.segmentCount,
          previewPlaylistUrl: nextRetry.previewPlaylistUrl,
          retry: nextRetry
        }
      }));
      if (nextRetry && !conflict && !stopped) {
        persistHlsUploadTask(nextRetry, normalizedFileNameOverride(urlUpload.fileNameOverride), urlUpload.hls?.variantId);
      }
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

    if (latest?.status === "ready") {
      return thumbnailStatePayload(latest);
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
        return generatedThumbnailPayload(generated);
      }
    }

    const generated = await startHlsThumbnailGeneration(previewPlaylistUrl, fileName, "正在生成 HLS 缩略图");
    if (urlUploadRef.current.thumbnail?.status === "removed") {
      return undefined;
    }
    return generated ? generatedThumbnailPayload(generated) : undefined;
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
    persistUrlMultipartUploadTask(syncedRetry, normalizedFileNameOverride(urlUpload.fileNameOverride));
    setSubmitting(true);
    const retryStartProgress = retryFailureProgress(syncedRetry, "准备重试失败分片");
    const retryChunks = prepareRetryChunks(urlRuntimeStore.getSnapshot().chunks ?? urlUpload.chunks, syncedRetry);
    seedUploadRuntimeStore(urlRuntimeStore, retryStartProgress, retryChunks);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      progress: undefined,
      retry: syncedRetry
    }));

    try {
      const result = await runConcurrentChunks({
        total: syncedRetry.chunkCount,
        chunkIndexes: syncedRetry.failedChunks,
        completedChunks: syncedRetry.completedChunks,
        taskLabel: "重试导入分片",
        doneLabel: "已导入",
        concurrency: effectiveUploadConcurrency,
        task,
        requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
        onProgress: updateUrlProgress,
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
        persistUrlMultipartUploadTask(nextRetry, normalizedFileNameOverride(urlUpload.fileNameOverride));
        throw new MultipartChunkUploadError(
          result.cancelled ? "已停止，可重试未完成分片" : `仍有 ${result.failedChunks.length} 个分片导入失败，可继续手动重试`,
          nextRetry,
          result.cancelled
        );
      }

      const completeProgress = {
        completed: syncedRetry.chunkCount,
        total: syncedRetry.chunkCount,
        label: syncedRetry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
      };
      seedUploadRuntimeStore(urlRuntimeStore, completeProgress, urlRuntimeStore.getSnapshot().chunks);
      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: undefined
      }));
      const thumbnail = urlUpload.thumbnail?.status === "ready"
        ? thumbnailStatePayload(urlUpload.thumbnail)
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
        chunks: undefined,
        retry: undefined,
        conflictAction: "error",
        editingFileName: false
      }));
      clearCurrentPersistedTask();
      onUploaded(1);
    } catch (uploadError) {
      const nextRetry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : syncedRetry;
      const stopped = (uploadError instanceof MultipartChunkUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
      const message = stopped ? "已停止" : uploadError instanceof Error ? uploadError.message : "URL 分片重试失败";
      const retryProgress = retryFailureProgress(nextRetry, stopped ? "已停止，可重试未完成分片" : "分片导入失败，可手动重试");
      seedUploadRuntimeStore(urlRuntimeStore, retryProgress, urlRuntimeStore.getSnapshot().chunks);
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message,
        retry: nextRetry,
        progress: undefined
      }));
      if (nextRetry && !stopped) {
        persistUrlMultipartUploadTask(nextRetry, normalizedFileNameOverride(urlUpload.fileNameOverride));
      }
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
    const retryStartProgress = retryFailureProgress(target.retry, "准备重试失败分片");
    seedUploadRuntimeStore(
      target.runtimeStore!,
      retryStartProgress,
      prepareRetryChunks(target.runtimeStore?.getSnapshot().chunks ?? target.chunks, target.retry)
    );
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? { ...item, status: "uploading", message: undefined, progress: undefined }
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
                chunks: undefined,
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
      const retryProgress = retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片上传失败，可手动重试");
        setItems((current) =>
          current.map((item) =>
            item.id === id
              ? (() => {
                  seedUploadRuntimeStore(item.runtimeStore!, retryProgress, item.runtimeStore?.getSnapshot().chunks ?? item.chunks);
                return {
                  ...item,
                  status: "error",
                  message,
                  retry,
                  progress: undefined,
                  chunks: undefined
                };
              })()
            : item
        )
      );
      if (retry && !stopped) {
        seedUploadRuntimeStore(target.runtimeStore!, retryProgress, target.runtimeStore?.getSnapshot().chunks ?? target.chunks);
      } else {
        seedUploadRuntimeStore(target.runtimeStore!, null, null);
      }
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
        description={`上传到 ${uploadDirectoryPath}；按文件类型和系统配置自动选择分片大小，单文件上限 ${formatBytes(maxMultipartBytes)}，最多 ${effectiveUploadConcurrency} 分片并发`}
        size="wide"
        closeOnBackdrop={false}
        closeOnEscape={!curlImportOpen && !thumbnailUrlPicker}
        trapFocus={!curlImportOpen && !thumbnailUrlPicker}
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
            <Button variant="secondary" onClick={onClose}>
              {uploadBusy ? "收起" : hasDone ? "关闭" : "取消"}
            </Button>
            <Button
              type="submit"
              form="upload-form"
              variant="primary"
              loading={uploadBusy}
              leadingIcon={mode === "url" ? <Link2 size={16} /> : <FilePlus2 size={16} />}
              disabled={pendingCount === 0 || hasInvalidFileName || hasUnresolvedConflict || magnetHasNoValidFiles}
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
                    ? mode === "url" ? (isMagnetSource && urlUpload.magnet?.import ? "导入选中文件" : isMagnetSource ? "解析磁力链接" : "上传 URL") : `开始上传 ${pendingCount} 个`
                    : "无待传文件"}
            </Button>
          </>
        }
      >
      <form id="upload-form" className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div className="flex items-center justify-between gap-3">
          <Segmented<UploadMode>
            value={mode}
            onChange={handleModeChange}
            ariaLabel="上传方式"
            options={[
              { value: "file", label: "本地文件", icon: <UploadCloud size={15} /> },
              { value: "url", label: "URL / 磁力", icon: <Link2 size={15} /> }
            ]}
          />
          <span className="hidden text-xs text-muted sm:inline">统一分片上传</span>
        </div>
        <div className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs leading-5 text-muted">
          本地文件、URL 和磁力导入都会先创建上传会话，再上传或导入分片，最后统一生成文件索引。图片/视频会尝试生成缩略图；失败时不影响文件上传。
        </div>

        {showQueuedUrlComposer ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="queued-upload-url" className="text-xs font-medium text-muted">
                新增 URL 任务
              </label>
              {queuedUrlTasks.length > 0 ? (
                <span className="text-xs text-muted">等待 {queuedUrlTasks.length} 个</span>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="queued-upload-url"
                type="text"
                placeholder="https://example.com/video.m3u8 或 magnet:?xt=urn:btih:..."
                value={queuedUrlDraft}
                invalid={Boolean(queuedUrlDraftError)}
                leadingIcon={<Link2 size={15} />}
                inputClassName="!text-sm !text-muted"
                onChange={(event) => {
                  setQueuedUrlDraft(event.target.value);
                  setQueuedUrlDraftError(undefined);
                }}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  const pastedUrl = extractFirstUrl(pasted);
                  if (pastedUrl) {
                    event.preventDefault();
                    setQueuedUrlDraft(pastedUrl);
                    setQueuedUrlDraftError(undefined);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addQueuedUrlTaskFromDraft();
                }}
              />
              <Button
                variant="secondary"
                className="sm:w-auto"
                leadingIcon={<Plus size={15} />}
                disabled={queuedUrlDraft.trim().length === 0}
                onClick={addQueuedUrlTaskFromDraft}
              >
                加入队列
              </Button>
            </div>
            {queuedUrlDraftError ? (
              <p className="text-xs text-danger">{queuedUrlDraftError}</p>
            ) : null}
            {queuedUrlTasks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {queuedUrlTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
                      <Link2 size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground" title={remoteFileLabel(task.sourceUrl)}>
                        {remoteFileLabel(task.sourceUrl)}
                      </p>
                      <p className="truncate text-[11px] text-muted" title={task.sourceUrl}>
                        {task.sourceUrl}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted">等待</span>
                    <button
                      type="button"
                      aria-label={`移除等待任务 ${remoteFileLabel(task.sourceUrl)}`}
                      title="移除等待任务"
                      className="grid size-7 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:focus-ring"
                      onClick={() => removeQueuedUrlTask(task.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

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
                按文件类型自动选择分片大小，最多 {effectiveUploadConcurrency} 并发，每片最多 {MULTIPART_UPLOAD_MAX_ATTEMPTS} 次
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
                    runtimeStore={item.runtimeStore!}
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
                    onThumbnailUrl={() => openThumbnailUrlPicker({ kind: "item", id: item.id })}
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
            <UrlSourceEditor
              sourceUrl={sourceUrl}
              uploadBusy={uploadBusy}
              invalid={urlUpload.status === "error"}
              isMagnetSource={isMagnetSource}
              onSourceUrlChange={handleSourceUrlChange}
              onOpenCurlImport={openCurlImport}
            />

            <SourceHeadersEditor
              rows={sourceHeaderRows}
              hidden={isMagnetSource}
              uploadBusy={uploadBusy}
              onAdd={addSourceHeaderRow}
              onUpdate={updateSourceHeaderRow}
              onRemove={removeSourceHeaderRow}
            />

            {normalizedSourceUrl ? (
              <UrlUploadRow
                url={normalizedSourceUrl}
                status={urlUpload.status}
                message={urlUpload.message}
                progress={urlUpload.progress}
                chunks={urlUpload.chunks}
                runtimeStore={urlRuntimeStore}
                fileNameOverride={urlUpload.fileNameOverride}
                editingFileName={urlUpload.editingFileName}
                conflict={urlUpload.conflict}
                hls={urlUpload.hls}
                magnet={urlUpload.magnet}
                maxMultipartBytes={maxMultipartBytes}
                directoryPath={uploadDirectoryPath}
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
                onMagnetFileToggle={toggleMagnetFileSelection}
                onMagnetSelectAll={() => selectAllMagnetFiles(true)}
                onMagnetClearSelection={clearMagnetFileSelection}
                onMagnetFileNameChange={updateMagnetFileName}
                onMagnetFileNameEditingChange={setMagnetFileNameEditing}
                onMagnetRenameConflict={(fileIndex) => resolveMagnetFileConflict(fileIndex, "error")}
                onMagnetOverwriteConflict={(fileIndex) => resolveMagnetFileConflict(fileIndex, "overwrite")}
                onMagnetOverwriteAllConflicts={resolveAllMagnetConflictsAsOverwrite}
                onRenameConflict={urlUpload.conflict && !isMagnetSource ? () => resolveUrlConflict("error") : undefined}
                onOverwriteConflict={urlUpload.conflict ? () => resolveUrlConflict("overwrite") : undefined}
                thumbnail={urlUpload.thumbnail}
                onThumbnailChange={(file) => void handleManualUrlThumbnail(file)}
                onThumbnailUrl={() => openThumbnailUrlPicker({ kind: "url" })}
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
            className="!text-sm !leading-6 !text-muted"
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
              className="font-mono !text-[13px] !leading-6 !text-muted"
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

      <Modal
        open={Boolean(thumbnailUrlPicker)}
        onClose={closeThumbnailUrlPicker}
        title="从 URL 选择缩略图"
        description="可粘贴图片 URL，或粘贴带 Referer/Cookie/Authorization 的 cURL。缩略图会由服务端拉取并转存。"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={closeThumbnailUrlPicker}>
              取消
            </Button>
            <Button
              variant="primary"
              leadingIcon={<Check size={15} />}
              disabled={!thumbnailUrlText.trim()}
              onClick={applyThumbnailUrlPicker}
            >
              使用此缩略图
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="upload-thumbnail-url" className="text-xs font-medium text-muted">
              缩略图 URL 或 cURL
            </label>
            <Textarea
              id="upload-thumbnail-url"
              rows={7}
              placeholder={"https://example.com/cover.jpg\n\n或：\ncurl 'https://example.com/cover.jpg' \\\n  -H 'Referer: https://example.com/' \\\n  -H 'Cookie: session=...'"}
              value={thumbnailUrlText}
              invalid={Boolean(thumbnailUrlError)}
              className="font-mono !text-[13px] !leading-6 !text-muted"
              onChange={(event) => {
                setThumbnailUrlText(event.target.value);
                setThumbnailUrlError(undefined);
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && thumbnailUrlText.trim()) {
                  event.preventDefault();
                  applyThumbnailUrlPicker();
                }
              }}
            />
          </div>

          {thumbnailUrlError ? (
            <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm leading-6 text-danger">
              {thumbnailUrlError}
            </div>
          ) : null}

          <div className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs leading-5 text-muted">
            服务端会校验缩略图类型，仅接受 JPEG、PNG、WebP，大小不超过 512 KB。cURL 中的请求体不会转发。
          </div>
        </div>
      </Modal>
    </>
  );
});

function createUploadTaskSnapshot(params: {
  mode: UploadMode;
  items: QueueItem[];
  localRuntime: Map<string, UploadRuntimeState>;
  urlUpload: UrlUploadState;
  urlRuntime: UploadRuntimeState;
  queuedUrlTasks: QueuedUrlUploadTask[];
  sourceUrl: string;
  uploadDirectoryPath: string;
  activeUploadKind: "local" | "url" | null;
  activeUploadItemId: string | null;
  activePersistedTaskId: string | null;
  stopRequested: boolean;
  running: boolean;
  persistedTasks: PersistedUploadTask[];
}): UploadTaskSnapshot | null {
  const activeItemId = params.activeUploadKind === "url" ? "url" : params.activeUploadItemId;
  const localItems: UploadTaskSnapshotItem[] = params.items.map((item) => {
    const runtime = params.localRuntime.get(item.id);
    const progress = runtime?.progress ?? item.progress;
    const progressPercent = uploadTaskProgressPercent(item.status, progress);
    return {
      id: item.id,
      kind: "local",
      title: effectiveFileName(item),
      description: item.relativePath
        ? `${effectiveDirectoryPath(item, params.uploadDirectoryPath)} · ${formatCompactBytes(item.file.size)}`
        : `${params.uploadDirectoryPath} · ${formatCompactBytes(item.file.size)}`,
      status: item.status,
      progressPercent,
      progressLabel: progress?.label ?? item.message,
      canStop: params.activeUploadKind === "local" && params.activeUploadItemId === item.id && !params.stopRequested,
      canDelete: !(params.activeUploadKind === "local" && params.activeUploadItemId === item.id)
    };
  });

  const hasUrlTask = Boolean(
    params.sourceUrl ||
    params.urlUpload.status !== "pending" ||
    params.urlRuntime.progress ||
    params.urlUpload.progress ||
    params.urlUpload.retry ||
    params.urlUpload.hls?.retry ||
    params.urlUpload.magnet?.import
  );
  const urlItems: UploadTaskSnapshotItem[] = hasUrlTask
    ? [{
        id: "url",
        kind: "url",
        title: params.sourceUrl ? remoteFileLabel(params.sourceUrl) : "远程上传任务",
        description: params.sourceUrl || undefined,
        status: params.urlUpload.status,
        progressPercent: uploadTaskProgressPercent(params.urlUpload.status, params.urlRuntime.progress ?? params.urlUpload.progress),
        progressLabel: params.urlRuntime.progress?.label ?? params.urlUpload.progress?.label ?? params.urlUpload.message,
        canStop: params.activeUploadKind === "url" && !params.stopRequested,
        canDelete: params.activeUploadKind !== "url"
      }]
    : [];

  const queuedUrlItems = params.queuedUrlTasks.map(queuedUrlTaskSnapshotItem);

  const visiblePersistedIds = currentVisiblePersistedTaskIds(params.items, params.urlUpload, params.activePersistedTaskId);
  const persistedItems = params.persistedTasks
    .filter((task) => !visiblePersistedIds.has(task.id))
    .map(persistedTaskSnapshotItem);

  const taskItems = [...localItems, ...urlItems, ...queuedUrlItems, ...persistedItems].filter((item) =>
    item.status !== "pending" || item.progressLabel || item.kind === params.mode
  );
  if (taskItems.length === 0) return null;

  const summary = taskItems.reduce<UploadTaskSnapshot["summary"]>(
    (current, item) => {
      current.total += 1;
      current[item.status] += 1;
      return current;
    },
    { total: 0, pending: 0, uploading: 0, done: 0, error: 0, skipped: 0 }
  );

  return {
    items: taskItems,
    running: params.running,
    stopRequested: params.stopRequested,
    activeItemId,
    summary
  };
}

function uploadTaskSnapshotKey(snapshot: UploadTaskSnapshot | null): string {
  if (!snapshot) {
    return "empty";
  }

  return JSON.stringify({
    running: snapshot.running,
    stopRequested: snapshot.stopRequested,
    activeItemId: snapshot.activeItemId,
    summary: snapshot.summary,
    items: snapshot.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description,
      status: item.status,
      progressPercent: item.progressPercent,
      progressLabel: item.progressLabel,
      canStop: item.canStop,
      canDelete: item.canDelete
    }))
  });
}

function uploadTaskSnapshotStructureKey(snapshot: UploadTaskSnapshot | null): string {
  if (!snapshot) {
    return "empty";
  }

  return JSON.stringify({
    running: snapshot.running,
    stopRequested: snapshot.stopRequested,
    activeItemId: snapshot.activeItemId,
    summary: snapshot.summary,
    items: snapshot.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      canStop: item.canStop,
      canDelete: item.canDelete
    }))
  });
}

function queuedUrlTaskSnapshotItem(task: QueuedUrlUploadTask): UploadTaskSnapshotItem {
  return {
    id: task.id,
    kind: "url",
    title: remoteFileLabel(task.sourceUrl),
    description: `${task.directoryPath} · ${task.sourceUrl}`,
    status: "pending",
    progressPercent: 0,
    progressLabel: "等待上传",
    canStop: false,
    canDelete: true
  };
}

function uploadTaskProgressPercent(status: ItemStatus, progress?: ChunkProgress): number {
  if (progress?.total) {
    return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));
  }
  if (status === "done") return 100;
  return 0;
}

function persistedTaskSnapshotItem(task: PersistedUploadTask): UploadTaskSnapshotItem {
  const status = persistedTaskStatusToItemStatus(task.status);
  const progress = persistedTaskProgress(task);
  return {
    id: task.id,
    kind: task.kind === "local" ? "local" : "url",
    title: persistedTaskTitle(task),
    description: persistedTaskDescription(task),
    status,
    progressPercent: progress.percent,
    progressLabel: progress.label,
    canStop: false,
    canDelete: true
  };
}

function currentVisiblePersistedTaskIds(
  items: QueueItem[],
  urlUpload: UrlUploadState,
  activePersistedTaskId: string | null
): Set<string> {
  const ids = new Set<string>();
  if (activePersistedTaskId) {
    ids.add(activePersistedTaskId);
  }
  for (const item of items) {
    if (item.retry?.kind === "local") {
      ids.add(makePersistedTaskId("local", item.retry.uploadId));
    }
  }
  if (urlUpload.retry?.kind === "url") {
    ids.add(makePersistedTaskId("url-multipart", urlUpload.retry.uploadId));
  }
  const hlsAssetId = urlUpload.hls?.retry?.assetId ?? urlUpload.hls?.assetId;
  if (hlsAssetId) {
    ids.add(makePersistedTaskId("hls", hlsAssetId));
  }
  if (urlUpload.magnet?.import) {
    ids.add(makePersistedTaskId("magnet", urlUpload.magnet.import.id));
  }
  return ids;
}

function persistedTaskStatusToItemStatus(status: PersistedUploadTask["status"]): ItemStatus {
  switch (status) {
    case "running":
      return "pending";
    case "done":
      return "done";
    case "cancelled":
      return "skipped";
    case "failed":
    case "waiting-file":
      return "error";
    default:
      return "pending";
  }
}

function persistedTaskTitle(task: PersistedUploadTask): string {
  switch (task.kind) {
    case "local":
      return task.fileName;
    case "hls":
      return task.retry.fileName;
    case "magnet":
      return remoteFileLabel(task.sourceUrl);
    case "url-multipart":
      return task.fileNameOverride || remoteFileLabel(task.sourceUrl);
  }
}

function persistedTaskDescription(task: PersistedUploadTask): string {
  switch (task.kind) {
    case "local":
      return `${task.directoryPath} · ${formatCompactBytes(task.size)}`;
    case "hls":
      return `${task.directoryPath} · HLS · ${task.retry.segmentCount} 个片段`;
    case "magnet":
      return `${task.directoryPath} · 磁力任务 · ${task.selectedIndexes.length} 个文件`;
    case "url-multipart":
      return `${task.directoryPath} · ${formatCompactBytes(task.retry.size)}`;
  }
}

function persistedTaskProgress(task: PersistedUploadTask): { percent: number; label: string } {
  if (task.kind === "hls") {
    const total = Math.max(1, task.retry.segmentCount);
    return {
      percent: Math.round((task.retry.completedSegments.length / total) * 100),
      label: task.status === "waiting-file" ? "等待操作" : `已完成 ${task.retry.completedSegments.length}/${total} 个片段`
    };
  }

  if (task.kind === "magnet") {
    return {
      percent: task.status === "done" ? 100 : 0,
      label: task.status === "queued" ? "等待恢复磁力任务" : "磁力任务待处理"
    };
  }

  const total = Math.max(1, task.retry.chunkCount);
  return {
    percent: Math.round((task.retry.completedChunks.length / total) * 100),
    label: task.kind === "local" && task.status === "waiting-file"
      ? "等待重新选择本地文件"
      : `已完成 ${task.retry.completedChunks.length}/${total} 个分片`
  };
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

function isRetryableMagnetStatusError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }

  if (error instanceof ApiError) {
    return error.status === 408 ||
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504;
  }

  return error instanceof Error;
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

function sourceHeaderRowsFromCurlHeaders(headers: Record<string, string>): {
  rows: SourceHeaderRow[];
  headerCount: number;
  skippedHeaders: string[];
} {
  const rows: SourceHeaderRow[] = [];
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
    const name = normalizeHeaderKeyInput(rawName);
    const value = rawValue.trim();

    if (!value) {
      continue;
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n]/.test(value) || isBlockedSourceHeaderName(name)) {
      addSkipped(rawName.trim());
      continue;
    }

    rows.push(makeSourceHeaderRow(name, value));
  }

  return {
    rows,
    headerCount: rows.length,
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

function parseRemoteThumbnailInput(input: string): { url: string; headers?: SourceRequestHeaders; summary: string } {
  const text = input.trim();
  if (!text) {
    throw new Error("请输入缩略图 URL 或 cURL 命令");
  }

  if (/^(?:[$>]\s*)?curl(?:\.exe)?\b/i.test(text)) {
    const parsed = parseCurlCommand(text);
    const headerResult = sourceHeaderRowsFromCurlHeaders(parsed.headers);
    const headers = parseSourceHeaderRows(headerResult.rows);
    const warnings = [...parsed.warnings];
    if (headerResult.skippedHeaders.length > 0) {
      warnings.push(`已忽略 ${headerResult.skippedHeaders.length} 个不支持的请求头`);
    }

    return {
      url: parsed.url,
      ...(headers ? { headers } : {}),
      summary: curlImportSummary(headerResult.headerCount, warnings).replace("URL", "缩略图 URL")
    };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("缩略图 URL 必须是完整的 http/https 地址");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("缩略图 URL 必须使用 http 或 https");
  }

  return {
    url: url.toString(),
    summary: "URL 缩略图"
  };
}

function parseSourceHeaderRows(rows: SourceHeaderRow[]): SourceRequestHeaders | undefined {
  const headers: SourceRequestHeaders = {};
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const name = normalizeHeaderKeyInput(row.name);
    const headerValue = row.value.trim();
    const hasName = name.length > 0;
    const hasValue = headerValue.length > 0;

    if (!hasName && !hasValue) {
      continue;
    }

    if (!hasName) {
      throw new Error(`第 ${index + 1} 个请求头缺少 key`);
    }

    if (!hasValue) {
      throw new Error(`请求头 ${name} 缺少 value`);
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`请求头 key 无效：${row.name || `第 ${index + 1} 行`}`);
    }

    if (isBlockedSourceHeaderName(name)) {
      throw new Error(`不允许自定义请求头：${name}`);
    }

    if (/[\r\n]/.test(headerValue)) {
      throw new Error(`请求头 ${name} 的 value 不能包含换行`);
    }

    if (seen.has(name)) {
      throw new Error(`请求头 ${name} 重复`);
    }

    seen.add(name);
    headers[name] = headerValue;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeHeaderKeyInput(value: string): string {
  return value.trim().toLowerCase();
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

function effectiveMagnetFileName(file: MagnetImportFile, decision: MagnetFileDecision | undefined): string {
  return normalizedFileNameOverride(decision?.fileNameOverride) ?? file.file_name;
}

function magnetTargetDirectoryPath(baseDirectoryPath: string, file: MagnetImportFile): string {
  return joinDirectoryPath(baseDirectoryPath, file.relative_directory_path ?? undefined);
}

function magnetFileNameOverrideValue(file: MagnetImportFile, value: string): string | undefined {
  if (value.trim().length === 0) {
    return value;
  }

  return value.trim() === file.file_name ? undefined : value;
}

function resetMagnetDecisionsForDirectoryChange(
  decisions: Record<number, MagnetFileDecision> | undefined
): Record<number, MagnetFileDecision> | undefined {
  if (!decisions) {
    return undefined;
  }

  const next: Record<number, MagnetFileDecision> = {};
  for (const [key, decision] of Object.entries(decisions)) {
    const { conflict: _conflict, conflictAction: _conflictAction, editingFileName: _editingFileName, ...rest } = decision;
    if (Object.keys(rest).length > 0) {
      next[Number(key)] = rest;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function magnetFileUploadOptions(
  magnet: MagnetImport,
  selectedIndexes: number[],
  decisions: Record<number, MagnetFileDecision>
): MagnetFileUploadOption[] {
  const selected = new Set(selectedIndexes);
  return magnet.files
    .filter((file) => selected.has(file.file_index))
    .map((file) => {
      const decision = decisions[file.file_index];
      const fileName = effectiveMagnetFileName(file, decision);
      return {
        file_index: file.file_index,
        ...(fileName !== file.file_name ? { file_name: fileName } : {}),
        ...(decision?.conflictAction === "overwrite" ? { on_conflict: "overwrite" as const } : {})
      };
    });
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

function generatedThumbnailPayload(thumbnail: GeneratedThumbnail): ThumbnailUploadPayload {
  return {
    blob: thumbnail.blob,
    fileName: thumbnail.fileName,
    ...(thumbnail.width ? { width: thumbnail.width } : {}),
    ...(thumbnail.height ? { height: thumbnail.height } : {})
  };
}

function thumbnailStatePayload(thumbnail: UploadThumbnailState | undefined): ThumbnailUploadPayload | undefined {
  if (thumbnail?.status !== "ready") {
    return undefined;
  }

  if (thumbnail.generated) {
    return generatedThumbnailPayload(thumbnail.generated);
  }

  if (thumbnail.remote) {
    return {
      sourceUrl: thumbnail.remote.url,
      ...(thumbnail.remote.headers ? { sourceHeaders: thumbnail.remote.headers } : {})
    };
  }

  return undefined;
}

function isVideoUploadCandidate(upload: Pick<MultipartUpload, "mime_type" | "file_name">): boolean {
  return upload.mime_type.toLowerCase().startsWith("video/") || /\.(mp4|m4v|mov|webm|ogv)$/i.test(upload.file_name);
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

function cleanupTemporaryMagnetUpload(state: UrlUploadState): void {
  const importId = unfinishedMagnetImportId(state);
  if (!importId) {
    return;
  }

  cancelTemporaryMagnetUpload(importId);
}

function cancelTemporaryMagnetUpload(importId: string): void {
  removeUploadTask(makePersistedTaskId("magnet", importId));
  void cancelMagnetUpload(importId).catch(() => undefined);
}

function unfinishedMagnetImportId(state: UrlUploadState): string | undefined {
  if (state.status === "done") {
    return undefined;
  }

  const magnet = state.magnet?.import;
  if (!magnet || magnet.status === "done" || magnet.completed_at) {
    return undefined;
  }

  return magnet.id;
}

function withoutHlsRetry(state: HlsUrlState): HlsUrlState {
  const { retry: _retry, ...rest } = state;
  return rest;
}

function isLikelyMagnetUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith("magnet:?");
}

function defaultMagnetSelectedIndexes(files: MagnetImportFile[], maxMultipartBytes: number): number[] {
  return files
    .filter((file) => file.size > 0 && file.size <= maxMultipartBytes)
    .map((file) => file.file_index)
    .sort((left, right) => left - right);
}

function selectedMagnetIndexesForResume(magnet: MagnetImport, maxMultipartBytes: number): number[] {
  const selected = magnet.files
    .filter((file) => file.selected && file.size > 0 && file.size <= maxMultipartBytes)
    .map((file) => file.file_index)
    .sort((left, right) => left - right);

  return selected.length > 0 ? selected : defaultMagnetSelectedIndexes(magnet.files, maxMultipartBytes);
}

function magnetStatusLabel(status: MagnetImport["status"]): string {
  switch (status) {
    case "probing":
      return "解析中";
    case "ready":
      return "已解析";
    case "downloading":
      return "下载中";
    case "downloaded":
      return "已下载";
    case "importing":
      return "导入中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function magnetStatusProgressLabel(label: string, magnet: MagnetImport): string {
  const status = magnetStatusLabel(magnet.status);
  const fileCount = magnet.file_count || magnet.files.length;
  const size = magnet.total_size ? ` · ${formatBytes(magnet.total_size)}` : "";
  const download = magnetDownloadProgressLabel(magnet);
  return `${label} · ${status}${download ? ` · ${download}` : ""}${fileCount > 0 ? ` · ${fileCount} 个文件${size}` : ""}`;
}

function magnetDownloadProgressLabel(magnet: MagnetImport): string | null {
  const total = magnet.download_total_bytes;
  const completed = magnet.download_completed_bytes;
  if (
    typeof total !== "number" ||
    typeof completed !== "number" ||
    !Number.isFinite(total) ||
    !Number.isFinite(completed) ||
    total <= 0
  ) {
    return null;
  }

  const progress = typeof magnet.download_progress === "number"
    ? Math.min(100, Math.max(0, magnet.download_progress * 100))
    : Math.min(100, Math.max(0, (completed / total) * 100));
  const speed = magnet.download_speed_bytes_per_second && magnet.download_speed_bytes_per_second > 0
    ? ` · ${formatBytes(magnet.download_speed_bytes_per_second)}/s`
    : "";

  return `${formatBytes(completed)}/${formatBytes(total)} · ${progress >= 10 ? progress.toFixed(0) : progress.toFixed(1)}%${speed}`;
}

function magnetImportStructureKey(magnet: MagnetImport): string {
  return JSON.stringify({
    status: magnet.status,
    error: magnet.error_message ?? "",
    aria2Status: magnet.aria2_status ?? "",
    totalBytes: magnet.download_total_bytes ?? 0,
    metadataCompletedAt: magnet.metadata_completed_at ?? "",
    downloadStartedAt: magnet.download_started_at ?? "",
    downloadCompletedAt: magnet.download_completed_at ?? "",
    completedAt: magnet.completed_at ?? "",
    fileCount: magnet.file_count,
    totalSize: magnet.total_size ?? 0,
    files: magnet.files.map((file) => [
      file.file_index,
      file.path,
      file.file_name,
      file.relative_directory_path ?? "",
      file.size,
      file.mime_type,
      file.chunk_size,
      file.chunk_count,
      file.selected,
      file.status,
      file.upload_id ?? "",
      file.error_message ?? ""
    ])
  });
}

function magnetStateEqual(left: MagnetUrlState | undefined, right: MagnetUrlState | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  const leftImportKey = left.import ? magnetImportStructureKey(left.import) : "";
  const rightImportKey = right.import ? magnetImportStructureKey(right.import) : "";
  return leftImportKey === rightImportKey &&
    numberArrayEqual(left.selectedIndexes, right.selectedIndexes) &&
    magnetUploadsEqual(left.uploads, right.uploads) &&
    left.fileDecisions === right.fileDecisions;
}

function mergeMagnetState(current: MagnetUrlState | undefined, next: MagnetUrlState): MagnetUrlState {
  return magnetStateEqual(current, next) ? current! : next;
}

function numberArrayEqual(left: number[] | undefined, right: number[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function magnetUploadsEqual(left: MagnetUploadEntry[] | undefined, right: MagnetUploadEntry[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const next = right[index];
    return entry.fileIndex === next.fileIndex &&
      entry.targetDirectoryPath === next.targetDirectoryPath &&
      entry.conflictAction === next.conflictAction &&
      entry.upload.id === next.upload.id &&
      entry.upload.file_name === next.upload.file_name &&
      entry.upload.size === next.upload.size &&
      entry.upload.chunk_size === next.upload.chunk_size &&
      entry.upload.chunk_count === next.upload.chunk_count &&
      entry.upload.direct_access === next.upload.direct_access;
  });
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

  let changed = false;
  const next = chunks.map((chunk) => {
    if (chunk.index !== chunkIndex) {
      return chunk;
    }

    const patched = { ...chunk, ...patch };
    if (uploadChunkStateEqual(chunk, patched)) {
      return chunk;
    }

    changed = true;
    return patched;
  });

  return changed ? next : chunks;
}

function chunkProgressEqual(left: ChunkProgress | undefined, right: ChunkProgress | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return left.completed === right.completed &&
    left.total === right.total &&
    left.label === right.label &&
    left.failed === right.failed;
}

function uploadRuntimeStateEqual(left: UploadRuntimeState, right: UploadRuntimeState): boolean {
  return chunkProgressEqual(left.progress, right.progress) &&
    left.chunks === right.chunks;
}

function uploadChunkStateEqual(left: UploadChunkState, right: UploadChunkState): boolean {
  return left.index === right.index &&
    left.size === right.size &&
    left.status === right.status &&
    left.attempts === right.attempts &&
    left.errorMessage === right.errorMessage;
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
  runtimeStore: UploadRuntimeStore;
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
  onThumbnailUrl: () => void;
  onThumbnailRemove: () => void;
  onToggleChunks: () => void;
  disabled: boolean;
}

const QueueRow = memo(function QueueRow({
  item,
  runtimeStore,
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
  onThumbnailUrl,
  onThumbnailRemove,
  onToggleChunks,
  disabled
}: QueueRowProps) {
  const status = item.status;
  const fileName = item.fileNameOverride ?? item.file.name;
  return (
    <div className="[contain:layout_paint] flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
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
          <LocalUploadRuntimeDetails
            runtimeStore={runtimeStore}
            fallbackProgress={item.progress}
            fallbackChunks={item.chunks}
            expanded={Boolean(item.chunksExpanded)}
            onToggleChunks={onToggleChunks}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5 self-center">
          <QueueStateBadge item={item} multipart={Boolean(item.progress || item.chunks)} />
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
            onUrl={onThumbnailUrl}
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
    </div>
  );
}, queueRowPropsEqual);

const LocalUploadRuntimeDetails = memo(function LocalUploadRuntimeDetails({
  runtimeStore,
  fallbackProgress,
  fallbackChunks,
  expanded,
  onToggleChunks
}: {
  runtimeStore: UploadRuntimeStore;
  fallbackProgress?: ChunkProgress;
  fallbackChunks?: UploadChunkState[];
  expanded: boolean;
  onToggleChunks: () => void;
}) {
  const runtime = useSyncExternalStore(
    runtimeStore.subscribe,
    runtimeStore.getSnapshot,
    runtimeStore.getSnapshot
  );
  const progress = runtime.progress ?? fallbackProgress;
  const chunks = runtime.chunks ?? fallbackChunks;

  return (
    <>
      {progress ? <ProgressBar progress={progress} /> : null}
      {chunks ? (
        <div className="mt-2">
          <UploadChunkPanel chunks={chunks} expanded={expanded} onToggle={onToggleChunks} />
        </div>
      ) : null}
    </>
  );
}, (previous, next) =>
  previous.runtimeStore === next.runtimeStore &&
  chunkProgressEqual(previous.fallbackProgress, next.fallbackProgress) &&
  previous.fallbackChunks === next.fallbackChunks &&
  previous.expanded === next.expanded
);

interface UrlUploadRowProps {
  url: string;
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  onClear: () => void;
  chunks?: UploadChunkState[];
  runtimeStore: UploadRuntimeStore;
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  hls?: HlsUrlState;
  magnet?: MagnetUrlState;
  maxMultipartBytes: number;
  directoryPath: string;
  thumbnail?: UploadThumbnailState;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onHlsVariantChange: (variantId: string) => void;
  onMagnetFileToggle: (fileIndex: number, selected: boolean) => void;
  onMagnetSelectAll: () => void;
  onMagnetClearSelection: () => void;
  onMagnetFileNameChange: (fileIndex: number, value: string) => void;
  onMagnetFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onMagnetRenameConflict: (fileIndex: number) => void;
  onMagnetOverwriteConflict: (fileIndex: number) => void;
  onMagnetOverwriteAllConflicts: () => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailUrl: () => void;
  onThumbnailRemove: () => void;
  disabled: boolean;
}

interface UrlSourceEditorProps {
  sourceUrl: string;
  uploadBusy: boolean;
  invalid: boolean;
  isMagnetSource: boolean;
  onSourceUrlChange: (value: string) => void;
  onOpenCurlImport: () => void;
}

const UrlSourceEditor = memo(function UrlSourceEditor({
  sourceUrl,
  uploadBusy,
  invalid,
  isMagnetSource,
  onSourceUrlChange,
  onOpenCurlImport
}: UrlSourceEditorProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="upload-source-url" className="text-xs font-medium text-muted">
          粘贴文件 URL 或磁力链接
        </label>
        {!isMagnetSource ? (
          <button
            type="button"
            disabled={uploadBusy}
            className="rounded-md px-1.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
            onClick={onOpenCurlImport}
          >
            从 cURL 解析
          </button>
        ) : null}
      </div>
      <Input
        id="upload-source-url"
        type="text"
        placeholder="https://example.com/report.pdf 或 magnet:?xt=urn:btih:..."
        value={sourceUrl}
        disabled={uploadBusy}
        invalid={invalid}
        leadingIcon={<ClipboardPaste size={15} />}
        inputClassName="!text-sm !text-muted"
        onChange={(event) => onSourceUrlChange(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          const pastedUrl = extractFirstUrl(pasted);
          if (pastedUrl) {
            event.preventDefault();
            onSourceUrlChange(pastedUrl);
          }
        }}
      />
      <p className="text-xs leading-5 text-muted">
        URL 导入要求远端支持 Range；磁力导入会先由 aria2 下载选中文件，再分片转存到 Telegram。
      </p>
    </div>
  );
}, (previous, next) =>
  previous.sourceUrl === next.sourceUrl &&
  previous.uploadBusy === next.uploadBusy &&
  previous.invalid === next.invalid &&
  previous.isMagnetSource === next.isMagnetSource
);

interface SourceHeadersEditorProps {
  rows: SourceHeaderRow[];
  hidden: boolean;
  uploadBusy: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Pick<SourceHeaderRow, "name" | "value">>) => void;
  onRemove: (id: string) => void;
}

const SourceHeadersEditor = memo(function SourceHeadersEditor({
  rows,
  hidden,
  uploadBusy,
  onAdd,
  onUpdate,
  onRemove
}: SourceHeadersEditorProps) {
  if (hidden) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs font-medium text-muted">
          请求头（可选）
        </label>
        <button
          type="button"
          disabled={uploadBusy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
          onClick={onAdd}
        >
          <Plus size={13} />
          新增请求头
        </button>
      </div>
      <div className="rounded-xl border border-border bg-surface/70 p-2 shadow-card">
        {rows.length > 0 ? (
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <div
                key={row.id}
                className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(8rem,0.38fr)_minmax(12rem,1fr)_2rem]"
              >
                <Input
                  aria-label={`请求头 ${index + 1} 名称`}
                  placeholder="referer"
                  value={row.name}
                  disabled={uploadBusy}
                  className="!h-9 !px-2 !shadow-none"
                  inputClassName="font-mono !text-[13px] !text-muted"
                  onChange={(event) => onUpdate(row.id, { name: event.target.value })}
                />
                <Input
                  aria-label={`请求头 ${index + 1} 值`}
                  placeholder="https://example.com/"
                  value={row.value}
                  disabled={uploadBusy}
                  className="!h-9 !px-2 !shadow-none"
                  inputClassName="font-mono !text-[13px] !text-muted"
                  onChange={(event) => onUpdate(row.id, { value: event.target.value })}
                />
                <button
                  type="button"
                  aria-label={`删除请求头 ${row.name || index + 1}`}
                  title="删除请求头"
                  disabled={uploadBusy}
                  className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
                  onClick={() => onRemove(row.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-background/70 px-3 py-2 text-xs text-subtle">
            <span>暂无自定义请求头，可从 cURL 解析或手动新增。</span>
            <button
              type="button"
              disabled={uploadBusy}
              className="shrink-0 font-medium text-primary-strong transition-colors hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
              onClick={onAdd}
            >
              新增
            </button>
          </div>
        )}
      </div>
      <p className="text-xs leading-5 text-muted">
        key 会自动保存为小写。服务端会自动设置 Range；不要填写 Range、Host、Content-Length 等连接控制头。
      </p>
    </div>
  );
}, (previous, next) =>
  previous.rows === next.rows &&
  previous.hidden === next.hidden &&
  previous.uploadBusy === next.uploadBusy
);

const UrlUploadRow = memo(function UrlUploadRow({
  url,
  status,
  message,
  progress,
  chunks,
  runtimeStore,
  fileNameOverride,
  editingFileName,
  conflict,
  hls,
  magnet,
  maxMultipartBytes,
  directoryPath,
  thumbnail,
  onClear,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onHlsVariantChange,
  onMagnetFileToggle,
  onMagnetSelectAll,
  onMagnetClearSelection,
  onMagnetFileNameChange,
  onMagnetFileNameEditingChange,
  onMagnetRenameConflict,
  onMagnetOverwriteConflict,
  onMagnetOverwriteAllConflicts,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailUrl,
  onThumbnailRemove,
  disabled
}: UrlUploadRowProps) {
  const isMagnet = isLikelyMagnetUrl(url);
  const fileName = isMagnet ? (magnet?.import?.name ?? "磁力链接") : fileNameOverride ?? remoteFileLabel(url);
  return (
    <div className="[contain:layout_paint] flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <UrlUploadHeader
        url={url}
        status={status}
        message={message}
        fileName={fileName}
        fileNameOverride={fileNameOverride}
        editingFileName={editingFileName}
        conflict={conflict}
        hls={hls}
        magnet={magnet}
        maxMultipartBytes={maxMultipartBytes}
        directoryPath={directoryPath}
        thumbnail={thumbnail}
        hasProgress={Boolean(progress)}
        retryComplete={progress ? progress.failed === 0 : false}
        isMagnet={isMagnet}
        disabled={disabled}
        stopping={stopping}
        onClear={onClear}
        onRetry={onRetry}
        onStop={onStop}
        onFileNameChange={onFileNameChange}
        onFileNameEditingChange={onFileNameEditingChange}
        onHlsVariantChange={onHlsVariantChange}
        onMagnetFileToggle={onMagnetFileToggle}
        onMagnetSelectAll={onMagnetSelectAll}
        onMagnetClearSelection={onMagnetClearSelection}
        onMagnetFileNameChange={onMagnetFileNameChange}
        onMagnetFileNameEditingChange={onMagnetFileNameEditingChange}
        onMagnetRenameConflict={onMagnetRenameConflict}
        onMagnetOverwriteConflict={onMagnetOverwriteConflict}
        onMagnetOverwriteAllConflicts={onMagnetOverwriteAllConflicts}
        onRenameConflict={onRenameConflict}
        onOverwriteConflict={onOverwriteConflict}
        onThumbnailChange={onThumbnailChange}
        onThumbnailUrl={onThumbnailUrl}
        onThumbnailRemove={onThumbnailRemove}
      />
      <UrlUploadRuntimeDetails
        runtimeStore={runtimeStore}
        fallbackProgress={progress}
        fallbackChunks={chunks}
        chunkTitle={hls ? "HLS 片段明细" : "分片明细"}
      />
    </div>
  );
}, urlUploadRowPropsEqual);

interface UrlUploadHeaderProps {
  url: string;
  status: ItemStatus;
  message?: string;
  fileName: string;
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  hls?: HlsUrlState;
  magnet?: MagnetUrlState;
  maxMultipartBytes: number;
  directoryPath: string;
  thumbnail?: UploadThumbnailState;
  hasProgress: boolean;
  retryComplete: boolean;
  isMagnet: boolean;
  disabled: boolean;
  stopping?: boolean;
  onClear: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onHlsVariantChange: (variantId: string) => void;
  onMagnetFileToggle: (fileIndex: number, selected: boolean) => void;
  onMagnetSelectAll: () => void;
  onMagnetClearSelection: () => void;
  onMagnetFileNameChange: (fileIndex: number, value: string) => void;
  onMagnetFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onMagnetRenameConflict: (fileIndex: number) => void;
  onMagnetOverwriteConflict: (fileIndex: number) => void;
  onMagnetOverwriteAllConflicts: () => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailUrl: () => void;
  onThumbnailRemove: () => void;
}

const UrlUploadHeader = memo(function UrlUploadHeader({
  url,
  status,
  message,
  fileName,
  editingFileName,
  conflict,
  hls,
  magnet,
  maxMultipartBytes,
  directoryPath,
  thumbnail,
  hasProgress,
  retryComplete,
  isMagnet,
  disabled,
  stopping,
  onClear,
  onRetry,
  onStop,
  onFileNameChange,
  onFileNameEditingChange,
  onHlsVariantChange,
  onMagnetFileToggle,
  onMagnetSelectAll,
  onMagnetClearSelection,
  onMagnetFileNameChange,
  onMagnetFileNameEditingChange,
  onMagnetRenameConflict,
  onMagnetOverwriteConflict,
  onMagnetOverwriteAllConflicts,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailUrl,
  onThumbnailRemove
}: UrlUploadHeaderProps) {
  return (
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
        {isMagnet ? (
          <p className="truncate text-sm font-semibold text-foreground" title={fileName}>{fileName}</p>
        ) : (
          <EditableFileName
            value={fileName}
            originalValue={remoteFileLabel(url)}
            editing={Boolean(editingFileName)}
            conflict={conflict}
            disabled={disabled || status === "uploading" || status === "done"}
            onChange={onFileNameChange}
            onEditingChange={onFileNameEditingChange}
          />
        )}
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
        {magnet?.import ? (
          <MagnetUploadDetails
            magnet={magnet}
            maxMultipartBytes={maxMultipartBytes}
            directoryPath={directoryPath}
            disabled={disabled || status === "uploading" || status === "done"}
            onToggle={onMagnetFileToggle}
            onSelectAll={onMagnetSelectAll}
            onClearSelection={onMagnetClearSelection}
            onFileNameChange={onMagnetFileNameChange}
            onFileNameEditingChange={onMagnetFileNameEditingChange}
            onRenameConflict={onMagnetRenameConflict}
            onOverwriteConflict={onMagnetOverwriteConflict}
            onOverwriteAllConflicts={onMagnetOverwriteAllConflicts}
          />
        ) : null}
        <ConflictResolutionActions
          conflict={conflict}
          disabled={disabled}
          onRename={onRenameConflict}
          onOverwrite={onOverwriteConflict}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5 self-center">
        {!isMagnet ? (
          <ThumbnailPicker
            disabled={disabled || status === "uploading"}
            onChange={onThumbnailChange}
            onUrl={onThumbnailUrl}
            onRemove={onThumbnailRemove}
            hasThumbnail={thumbnail?.status === "ready"}
          />
        ) : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="h-6 shrink-0 rounded-md border border-primary/30 px-2 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {hls?.retry
              ? hls.retry.failedSegments.length === 0 ? "继续完成上传" : "重试 HLS 片段"
              : retryComplete ? "继续完成上传" : "重试失败分片"}
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
        <StatusBadge status={status} multipart={hasProgress} />
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
  );
}, urlUploadHeaderPropsEqual);

const UrlUploadRuntimeDetails = memo(function UrlUploadRuntimeDetails({
  runtimeStore,
  fallbackProgress,
  fallbackChunks,
  chunkTitle
}: {
  runtimeStore: UploadRuntimeStore;
  fallbackProgress?: ChunkProgress;
  fallbackChunks?: UploadChunkState[];
  chunkTitle: string;
}) {
  const runtime = useSyncExternalStore(
    runtimeStore.subscribe,
    runtimeStore.getSnapshot,
    runtimeStore.getSnapshot
  );
  const progress = runtime.progress ?? fallbackProgress;
  const chunks = runtime.chunks ?? fallbackChunks;

  return (
    <>
      {progress ? <ProgressBar progress={progress} /> : null}
      {chunks ? <UploadChunkList chunks={chunks} title={chunkTitle} /> : null}
    </>
  );
}, (previous, next) =>
  previous.runtimeStore === next.runtimeStore &&
  chunkProgressEqual(previous.fallbackProgress, next.fallbackProgress) &&
  previous.fallbackChunks === next.fallbackChunks &&
  previous.chunkTitle === next.chunkTitle
);

const HlsUploadDetails = memo(function HlsUploadDetails({
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
}, hlsUploadDetailsPropsEqual);

const MagnetUploadDetails = memo(function MagnetUploadDetails({
  magnet,
  maxMultipartBytes,
  directoryPath,
  disabled,
  onToggle,
  onSelectAll,
  onClearSelection,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict,
  onOverwriteAllConflicts
}: {
  magnet: MagnetUrlState;
  maxMultipartBytes: number;
  directoryPath: string;
  disabled: boolean;
  onToggle: (fileIndex: number, selected: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onFileNameChange: (fileIndex: number, value: string) => void;
  onFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onRenameConflict: (fileIndex: number) => void;
  onOverwriteConflict: (fileIndex: number) => void;
  onOverwriteAllConflicts: () => void;
}) {
  const info = magnet.import;
  if (!info) {
    return null;
  }

  const validFiles = useMemo(
    () => info.files.filter((file) => !file.file_name.startsWith("[METADATA]")),
    [info.files]
  );
  const selected = useMemo(() => new Set(magnet.selectedIndexes), [magnet.selectedIndexes]);
  const decisions = magnet.fileDecisions ?? {};
  const magnetStats = useMemo(
    () => {
      let selectedCount = 0;
      let selectedBytes = 0;
      let uploadableCount = 0;
      let selectedConflictCount = 0;

      for (const file of validFiles) {
        if (file.size <= maxMultipartBytes) {
          uploadableCount += 1;
        }
        if (!selected.has(file.file_index)) {
          continue;
        }
        selectedCount += 1;
        selectedBytes += file.size;
        if (decisions[file.file_index]?.conflict) {
          selectedConflictCount += 1;
        }
      }

      return { selectedCount, selectedBytes, uploadableCount, selectedConflictCount };
    },
    [decisions, maxMultipartBytes, selected, validFiles]
  );

  if (info.status === "probing" && validFiles.length === 0) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-background/70 p-3">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} />
          <span>正在解析磁力链接元数据，请稍候...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="[contain:layout_paint] mt-2 flex flex-col gap-2 rounded-lg border border-border bg-background/70 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <HlsMetaPill tone="strong">Magnet</HlsMetaPill>
          <HlsMetaPill>{magnetStatusLabel(info.status)}</HlsMetaPill>
          <HlsMetaPill>{validFiles.length} 个文件</HlsMetaPill>
          <HlsMetaPill>已选 {magnetStats.selectedCount} 个 · {formatBytes(magnetStats.selectedBytes)}</HlsMetaPill>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {magnetStats.selectedConflictCount > 0 ? (
            <button
              type="button"
              disabled={disabled}
              className="rounded-md px-1.5 py-1 font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-50"
              onClick={onOverwriteAllConflicts}
            >
              全部覆盖冲突
          </button>
          ) : null}
          <button
            type="button"
            disabled={disabled || magnetStats.uploadableCount === 0}
            className="rounded-md px-1.5 py-1 font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-50"
            onClick={onSelectAll}
          >
            全选可上传
          </button>
          <button
            type="button"
            disabled={disabled || magnetStats.selectedCount === 0}
            className="rounded-md px-1.5 py-1 font-medium text-muted transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-50"
            onClick={onClearSelection}
          >
            清空
          </button>
        </div>
      </div>
      {info.error_message ? (
        <p className="rounded-md bg-danger-soft px-2 py-1.5 text-xs text-danger">{info.error_message}</p>
      ) : null}
      <div className="[contain:layout_paint] max-h-60 overflow-auto rounded-lg border border-border bg-surface">
        {validFiles.length > 0 ? (
          <div className="divide-y divide-border">
            {validFiles.map((file) => {
              const tooLarge = file.size > maxMultipartBytes;
              const isSelected = selected.has(file.file_index);
              const decision = decisions[file.file_index];
              return (
                <MagnetFileRow
                  key={file.file_index}
                  file={file}
                  decision={decision}
                  directoryPath={directoryPath}
                  maxMultipartBytes={maxMultipartBytes}
                  disabled={disabled}
                  selected={isSelected}
                  onToggle={onToggle}
                  onFileNameChange={onFileNameChange}
                  onFileNameEditingChange={onFileNameEditingChange}
                  onRenameConflict={onRenameConflict}
                  onOverwriteConflict={onOverwriteConflict}
                />
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4 text-center text-xs text-muted">文件列表解析中</div>
        )}
      </div>
    </div>
  );
}, magnetUploadDetailsPropsEqual);

interface MagnetFileRowProps {
  file: MagnetImportFile;
  decision?: MagnetFileDecision;
  directoryPath: string;
  maxMultipartBytes: number;
  disabled: boolean;
  selected: boolean;
  onToggle: (fileIndex: number, selected: boolean) => void;
  onFileNameChange: (fileIndex: number, value: string) => void;
  onFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onRenameConflict: (fileIndex: number) => void;
  onOverwriteConflict: (fileIndex: number) => void;
}

const MagnetFileRow = memo(function MagnetFileRow({
  file,
  decision,
  directoryPath,
  maxMultipartBytes,
  disabled,
  selected,
  onToggle,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict
}: MagnetFileRowProps) {
  const tooLarge = file.size > maxMultipartBytes;
  const targetDirectoryPath = magnetTargetDirectoryPath(directoryPath, file);
  const targetFileName = effectiveMagnetFileName(file, decision);
  const editorFileName = decision?.editingFileName
    ? decision.fileNameOverride ?? file.file_name
    : targetFileName;
  const disabledRow = disabled || tooLarge;

  return (
    <div
      className={cn(
        "[contain:layout_paint] grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-xs",
        disabledRow ? "opacity-60" : "hover:bg-background"
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disabledRow}
        onChange={(event) => onToggle(file.file_index, event.currentTarget.checked)}
        className="size-4 accent-[var(--color-primary)]"
      />
      <div className="min-w-0">
        {selected && !tooLarge ? (
          <EditableFileName
            value={editorFileName}
            originalValue={file.file_name}
            editing={Boolean(decision?.editingFileName)}
            conflict={decision?.conflict}
            disabled={disabled}
            onChange={(value) => onFileNameChange(file.file_index, value)}
            onEditingChange={(editing) => onFileNameEditingChange(file.file_index, editing)}
          />
        ) : (
          <span className="block truncate font-medium text-foreground" title={file.path}>{file.path}</span>
        )}
        <p className="truncate text-[11px] text-muted">
          {tooLarge ? (
            <span className="text-danger">超过 {formatBytes(maxMultipartBytes)} 上限</span>
          ) : (
            <>
              <span>{file.mime_type}</span>
              <span> · 目标 {targetDirectoryPath === "/" ? "/" : `${targetDirectoryPath}/`}{targetFileName}</span>
              {decision?.conflict ? <span className="text-warning"> · 目标已有同名文件</span> : null}
              {!decision?.conflict && decision?.conflictAction === "overwrite" ? <span className="text-warning"> · 将覆盖</span> : null}
              {!decision?.conflict && decision?.fileNameOverride ? <span className="text-primary-strong"> · 已改名</span> : null}
            </>
          )}
        </p>
        {file.relative_directory_path ? (
          <p className="truncate text-[11px] text-subtle" title={file.path}>磁力路径：{file.path}</p>
        ) : null}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        <CompactConflictActions
          conflict={selected ? decision?.conflict : undefined}
          disabled={disabled}
          onRename={() => onRenameConflict(file.file_index)}
          onOverwrite={() => onOverwriteConflict(file.file_index)}
        />
        <span className="font-mono text-[11px] text-muted">{formatBytes(file.size)}</span>
      </span>
    </div>
  );
}, (previous, next) =>
  previous.file === next.file &&
  previous.decision === next.decision &&
  previous.directoryPath === next.directoryPath &&
  previous.maxMultipartBytes === next.maxMultipartBytes &&
  previous.disabled === next.disabled &&
  previous.selected === next.selected
);

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
      {onSkip ? (
        <button
          type="button"
          onClick={onSkip}
          disabled={disabled}
          className="h-6 rounded px-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          忽略
        </button>
      ) : null}
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
        {onRename ? (
          <button
            type="button"
            onClick={onRename}
            onPointerDown={(event) => event.preventDefault()}
            title={`重命名为 ${conflict.suggestedName}`}
            disabled={disabled}
            className="min-w-0 max-w-full rounded-md border border-warning/35 bg-surface px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="block max-w-full truncate">重命名为 {conflict.suggestedName}</span>
          </button>
        ) : null}
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

  if (thumbnail?.status === "ready" && thumbnail.remote) {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong ring-1 ring-primary/15">
        <Link2 size={16} />
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
  onUrl,
  onRemove,
  hasThumbnail
}: {
  disabled: boolean;
  onChange: (file: File) => void;
  onUrl: () => void;
  onRemove: () => void;
  hasThumbnail: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
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
      <button
        type="button"
        className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled}
        title={hasThumbnail ? "从 URL 更换缩略图" : "从 URL 选择缩略图"}
        onClick={onUrl}
      >
        <Link2 size={13} />
      </button>
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
      if (thumbnail.remote) return "URL 缩略图";
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

const UploadChunkPanel = memo(function UploadChunkPanel({
  chunks,
  expanded,
  onToggle
}: {
  chunks: UploadChunkState[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const stats = useMemo(() => uploadChunkStats(chunks), [chunks]);

  return (
    <div className="[contain:layout_paint] rounded-lg border border-border bg-background/70 p-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 text-left text-[11px] text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Layers3 size={13} className="shrink-0 text-primary-strong" />
          <span className="truncate">
            分片：{stats.completed}/{chunks.length} 完成
            {stats.uploading > 0 ? ` · ${stats.uploading} 上传中` : ""}
            {stats.failed > 0 ? ` · ${stats.failed} 失败` : ""}
          </span>
        </span>
        <span className="shrink-0 font-medium text-primary-strong">
          {expanded ? "收起详情" : "分片详情"}
        </span>
      </button>
      {expanded ? <UploadChunkList chunks={chunks} /> : null}
    </div>
  );
});

const UploadChunkList = memo(function UploadChunkList({ chunks, title = "分片明细" }: { chunks: UploadChunkState[]; title?: string }) {
  const stats = useMemo(() => uploadChunkStats(chunks), [chunks]);
  const MAX_RENDERABLE_CHUNKS = 100;
  const shouldLimitRender = chunks.length > MAX_RENDERABLE_CHUNKS;
  const visibleChunks = useMemo(
    () => shouldLimitRender ? chunks.filter((chunk) => chunk.status === "uploading" || chunk.status === "failed") : chunks,
    [chunks, shouldLimitRender]
  );

  return (
    <div className="[contain:layout_paint] mt-2 border-t border-border pt-2">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>
          {title}：{stats.completed}/{chunks.length} 完成
          {stats.uploading > 0 ? ` · ${stats.uploading} 上传中` : ""}
          {stats.failed > 0 ? ` · ${stats.failed} 失败` : ""}
        </span>
        {shouldLimitRender ? <span>仅显示上传中和失败的分片</span> : <span>每片状态实时更新</span>}
      </div>
      {shouldLimitRender && visibleChunks.length === 0 ? (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-center text-xs text-muted">
          分片过多（{chunks.length} 个），全部正常上传中
        </div>
      ) : (
        <div className="grid max-h-40 gap-1 overflow-auto pr-1 scroll-thin sm:grid-cols-2">
          {visibleChunks.map((chunk) => (
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
      )}
    </div>
  );
});

function uploadChunkStats(chunks: UploadChunkState[]): { completed: number; failed: number; uploading: number } {
  return chunks.reduce(
    (stats, chunk) => {
      if (chunk.status === "completed") {
        stats.completed += 1;
      } else if (chunk.status === "failed") {
        stats.failed += 1;
      } else if (chunk.status === "uploading") {
        stats.uploading += 1;
      }
      return stats;
    },
    { completed: 0, failed: 0, uploading: 0 }
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

const ProgressBar = memo(function ProgressBar({ progress }: { progress: ChunkProgress }) {
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="[contain:layout_paint] mt-2 flex flex-col gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out will-change-[width]"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted">
        <span className="min-w-0 truncate" title={progress.label}>{progress.label}</span>
        <span className="shrink-0">{percent}%{progress.failed ? ` · 失败 ${progress.failed}` : ""}</span>
      </div>
    </div>
  );
}, (previous, next) => chunkProgressEqual(previous.progress, next.progress));

function queueRowPropsEqual(previous: QueueRowProps, next: QueueRowProps): boolean {
  return previous.item === next.item &&
    previous.runtimeStore === next.runtimeStore &&
    previous.targetDirectoryPath === next.targetDirectoryPath &&
    previous.disabled === next.disabled &&
    previous.stopping === next.stopping &&
    Boolean(previous.onRetry) === Boolean(next.onRetry) &&
    Boolean(previous.onStop) === Boolean(next.onStop) &&
    Boolean(previous.onRenameConflict) === Boolean(next.onRenameConflict) &&
    Boolean(previous.onOverwriteConflict) === Boolean(next.onOverwriteConflict) &&
    Boolean(previous.onSkipConflict) === Boolean(next.onSkipConflict);
}

function urlUploadRowPropsEqual(previous: UrlUploadRowProps, next: UrlUploadRowProps): boolean {
  return previous.url === next.url &&
    previous.status === next.status &&
    previous.message === next.message &&
    chunkProgressEqual(previous.progress, next.progress) &&
    previous.chunks === next.chunks &&
    previous.fileNameOverride === next.fileNameOverride &&
    previous.editingFileName === next.editingFileName &&
    previous.conflict === next.conflict &&
    previous.hls === next.hls &&
    previous.magnet === next.magnet &&
    previous.maxMultipartBytes === next.maxMultipartBytes &&
    previous.directoryPath === next.directoryPath &&
    previous.thumbnail === next.thumbnail &&
    previous.stopping === next.stopping &&
    previous.disabled === next.disabled &&
    Boolean(previous.onRetry) === Boolean(next.onRetry) &&
    Boolean(previous.onStop) === Boolean(next.onStop) &&
    Boolean(previous.onRenameConflict) === Boolean(next.onRenameConflict) &&
    Boolean(previous.onOverwriteConflict) === Boolean(next.onOverwriteConflict);
}

function urlUploadHeaderPropsEqual(previous: UrlUploadHeaderProps, next: UrlUploadHeaderProps): boolean {
  return previous.url === next.url &&
    previous.status === next.status &&
    previous.message === next.message &&
    previous.fileName === next.fileName &&
    previous.fileNameOverride === next.fileNameOverride &&
    previous.editingFileName === next.editingFileName &&
    previous.conflict === next.conflict &&
    previous.hls === next.hls &&
    previous.magnet === next.magnet &&
    previous.maxMultipartBytes === next.maxMultipartBytes &&
    previous.directoryPath === next.directoryPath &&
    previous.thumbnail === next.thumbnail &&
    previous.hasProgress === next.hasProgress &&
    previous.retryComplete === next.retryComplete &&
    previous.isMagnet === next.isMagnet &&
    previous.disabled === next.disabled &&
    previous.stopping === next.stopping &&
    Boolean(previous.onRetry) === Boolean(next.onRetry) &&
    Boolean(previous.onStop) === Boolean(next.onStop) &&
    Boolean(previous.onRenameConflict) === Boolean(next.onRenameConflict) &&
    Boolean(previous.onOverwriteConflict) === Boolean(next.onOverwriteConflict);
}

function hlsUploadDetailsPropsEqual(
  previous: { hls: HlsUrlState; disabled: boolean },
  next: { hls: HlsUrlState; disabled: boolean }
): boolean {
  return previous.hls === next.hls && previous.disabled === next.disabled;
}

function magnetUploadDetailsPropsEqual(
  previous: {
    magnet: MagnetUrlState;
    maxMultipartBytes: number;
    directoryPath: string;
    disabled: boolean;
  },
  next: {
    magnet: MagnetUrlState;
    maxMultipartBytes: number;
    directoryPath: string;
    disabled: boolean;
  }
): boolean {
  return previous.magnet === next.magnet &&
    previous.maxMultipartBytes === next.maxMultipartBytes &&
    previous.directoryPath === next.directoryPath &&
    previous.disabled === next.disabled;
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
