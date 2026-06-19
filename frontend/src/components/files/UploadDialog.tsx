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

import type {
  ChunkProgress,
  ChunkQueueResult,
  DroppedFileEntry,
  FileNameConflictState,
  HlsUrlState,
  ItemStatus,
  MagnetFileDecision,
  MagnetUrlState,
  QueueItem,
  QueuedUrlUploadTask,
  RemoteThumbnailInput,
  SourceHeaderRow,
  ThumbnailUrlPickerTarget,
  UploadAbortContext,
  UploadChunkState,
  UploadChunkStatus,
  UploadDialogHandle,
  UploadDialogProps,
  UploadMode,
  UploadRuntimeState,
  UploadRuntimeStore,
  UploadTaskSnapshot,
  UploadTaskSnapshotItem,
  UploadTaskSnapshotStatus,
  UploadThumbnailState,
  UploadThumbnailStatus,
  UrlUploadState
} from "./upload/types";

export type {
  ItemStatus,
  UploadDialogHandle,
  UploadTaskSnapshot,
  UploadTaskSnapshotItem,
  UploadTaskSnapshotStatus
} from "./upload/types";

import {
  CHUNK_UI_UPDATE_INTERVAL_MS,
  DEFAULT_UPLOAD_CONCURRENCY,
  FILE_NAME_CONFLICT_TOAST_MESSAGE,
  HLS_SEGMENT_REQUEST_TIMEOUT_MS,
  HlsSegmentUploadError,
  LOCAL_CHUNK_REQUEST_TIMEOUT_MS,
  MAGNET_DOWNLOAD_TIMEOUT_MS,
  MAGNET_STATUS_MAX_TRANSIENT_FAILURES,
  MAGNET_STATUS_POLL_MS,
  MAGNET_STATUS_RETRY_DELAY_MS,
  MAX_RENDERABLE_CHUNKS,
  MULTIPART_UPLOAD_MAX_ATTEMPTS,
  MULTIPART_UPLOAD_RETRY_DELAY_MS,
  MultipartChunkUploadError,
  TASK_SNAPSHOT_UPDATE_INTERVAL_MS,
  URL_CHUNK_REQUEST_TIMEOUT_MS
} from "./upload/constants";
import {
  completeUploadOrRetryLater,
  refreshMultipartRetryState,
  runAbortableUploadRequest,
  runConcurrentChunks
} from "./upload/chunk-engine";

import {
  extractFirstUrl,
  isLocalItemAwaitingDecision,
  isUploadableLocalItem,
  makeItem,
  makePlaceholderLocalItem,
  makeQueuedUrlUploadTask,
  makeSourceHeaderRow,
  sourceHeaderRowsFromHeaders
} from "./upload/item-factories";
import {
  createUploadRuntimeStore,
  localRuntimeSnapshot,
  normalizeUploadConcurrency,
  resetUploadRuntimeStore,
  seedUploadRuntimeStore
} from "./upload/runtime-store";
import {
  chunkProgressEqual,
  magnetStateEqual,
  magnetUploadsEqual,
  mergeMagnetState,
  numberArrayEqual,
  uploadChunkStateEqual,
  uploadRuntimeStateEqual
} from "./upload/equality";
import {
  chunkRange,
  createUploadChunkStates,
  expectedUploadChunkSize,
  prepareRetryChunks,
  retryFailureProgress,
  updateChunkStates
} from "./upload/chunk-math";
import {
  abortUploadTask,
  delay,
  errorMessage,
  isAbortError,
  isRetryableChunkUploadError,
  isRetryableMagnetStatusError,
  retryDelayMs
} from "./upload/abort-retry";
import {
  curlImportSummary,
  isBlockedSourceHeaderName,
  normalizeHeaderKeyInput,
  parseRemoteThumbnailInput,
  parseSourceHeaderRows,
  sourceHeaderRowsFromCurlHeaders
} from "./upload/curl-headers";
import { isVideoUploadCandidate } from "./upload/filetype";
import { generatedThumbnailPayload, thumbnailStatePayload } from "./upload/thumbnail-helpers";
import {
  effectiveDirectoryPath,
  effectiveFileName,
  fileNameConflictFromError,
  fileNameConflictFromPreflight,
  normalizedFileNameOverride,
  stringDetail,
  suggestAlternativeFileName
} from "./upload/filename-conflict";
import {
  browserRelativePath,
  collectDroppedFiles,
  joinDirectoryPath,
  normalizeRelativePath,
  readDroppedDirectoryEntries,
  readDroppedEntry,
  readDroppedFile,
  relativeDirectoryPathFor
} from "./upload/dropped-files";
import {
  defaultMagnetSelectedIndexes,
  effectiveMagnetFileName,
  isLikelyMagnetUrl,
  magnetDownloadProgressLabel,
  magnetFileNameOverrideValue,
  magnetFileUploadOptions,
  magnetImportStableUiKey,
  magnetImportStructureKey,
  magnetStatusLabel,
  magnetStatusProgressLabel,
  magnetTargetDirectoryPath,
  resetMagnetDecisionsForDirectoryChange,
  selectedMagnetIndexesForResume
} from "./upload/magnet-helpers";
import {
  cleanupTemporaryHlsUpload,
  createHlsSegmentStates,
  formatHlsDuration,
  hlsProbeSummary,
  hlsRetryFailureProgress,
  hlsRetryFromStatus,
  hlsSegmentChunkMessage,
  hlsSegmentChunkStatus,
  hlsVariantLabel,
  isLikelyHlsUrl,
  prepareHlsRetryChunks,
  withoutHlsRetry
} from "./upload/hls-helpers";
import {
  buildFolderTree,
  countFolderTreeDirectories,
  folderNodeStatusClass,
  folderNodeStatusLabel,
  sortFolderTree,
  type FolderTreeNode
} from "./upload/folder-tree";
import {
  createUploadTaskSnapshot,
  currentVisiblePersistedTaskIds,
  persistedTaskDescription,
  persistedTaskProgress,
  persistedTaskSnapshotItem,
  persistedTaskStatusToItemStatus,
  persistedTaskTitle,
  queuedUrlTaskSnapshotItem,
  remoteFileLabel,
  uploadTaskProgressPercent,
  uploadTaskSnapshotKey,
  uploadTaskSnapshotStructureKey
} from "./upload/snapshot";
import { ConflictSummary } from "./upload/components/ConflictControls";
import { FolderUploadTree } from "./upload/components/FolderUploadTree";
import { QueueRow } from "./upload/components/QueueRow";
import { UrlUploadRow, UrlSourceEditor, SourceHeadersEditor } from "./upload/components/UrlUploadRow";
import type { UploadEngineContext } from "./upload/engine-context";
import {
  retryItemFailedChunks,
  updateItemProgress,
  uploadLocalMultipart
} from "./upload/local-engine";
import {
  retryUrlMultipart,
  submitUrlUpload
} from "./upload/url-engine";
import { updateUrlProgress } from "./upload/engine-updates";
import { submitMagnetUpload } from "./upload/magnet-engine";
import {
  retryHlsUpload,
  sameOriginAdminUrl
} from "./upload/hls-engine";

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
    void submitUrlUpload(buildEngineContext());
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
    void submitMagnetUpload(buildEngineContext());
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
        void retryUrlMultipart(buildEngineContext(), task.retry);
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
        void retryHlsUpload(buildEngineContext(), task.retry);
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
          : { completed: 0, total: Math.max(1, task.selectedIndexes.length), label: magnetStatusProgressLabel("继续磁力任务", response.magnet, task.selectedIndexes.length) }
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
      updateItemProgress(buildEngineContext(), task.itemId, {
        completed: currentItemCompletedChunks(task.itemId),
        total: currentItemChunkCount(task.itemId),
        label: "正在停止上传，保留已完成分片"
      });
    } else if (task.kind === "url") {
      updateUrlProgress(buildEngineContext(), {
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
      await submitUrlUpload(buildEngineContext());
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
        await uploadLocalMultipart(buildEngineContext(), target, fileName, thumbnail, task);
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
      updateUrlProgress(buildEngineContext(), {
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

  function toggleItemChunks(id: string) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, chunksExpanded: !item.chunksExpanded } : item))
    );
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

  function buildEngineContext(): UploadEngineContext {
    return {
      items,
      urlUpload,
      sourceUrl,
      normalizedSourceUrl,
      remark,
      uploadDirectoryPath,
      effectiveUploadConcurrency,
      maxMultipartBytes,
      uploadBusy,
      itemsRef,
      urlUploadRef,
      urlRuntimeStore,
      setItems,
      setUrlUpload,
      setSubmitting,
      onError,
      onUploaded,
      startUploadTask,
      finishUploadTask,
      validateSourceUrl,
      readSourceHeadersForUpload,
      persistLocalUploadTask,
      persistUrlMultipartUploadTask,
      persistHlsUploadTask,
      persistMagnetUploadTask,
      clearCurrentPersistedTask,
      preflightMagnetSelection,
      resolveLocalThumbnailForUpload,
      resolveUrlThumbnailForUpload,
      resolveMagnetThumbnailForUpload,
      resolveHlsThumbnailForUpload,
      maybeGenerateHlsThumbnail
    };
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
        stableRendering
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
                    onRetry={item.retry ? () => void retryItemFailedChunks(buildEngineContext(), item.id) : undefined}
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
                    ? () => void retryHlsUpload(buildEngineContext(), urlUpload.hls!.retry!)
                    : urlUpload.retry
                      ? () => void retryUrlMultipart(buildEngineContext(), urlUpload.retry!)
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

