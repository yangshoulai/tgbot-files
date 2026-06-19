import type {
  FileNameConflictAction,
  HlsProbeInfo,
  MagnetImport,
  SourceRequestHeaders
} from "../../../api";
import type {
  HlsRetryState,
  MagnetUploadEntry,
  MultipartRetryState
} from "../../../lib/upload-tasks";
import type { GeneratedThumbnail } from "../../../lib/thumbnail";

export interface UploadDialogProps {
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
export type UploadMode = "file" | "url";
export type UploadChunkStatus = "queued" | "uploading" | "completed" | "failed";

export interface DroppedFileEntry {
  file: File;
  relativePath?: string;
}

export interface ChunkProgress {
  completed: number;
  total: number;
  label: string;
  failed?: number;
}

export interface UploadChunkState {
  index: number;
  size: number;
  status: UploadChunkStatus;
  attempts: number;
  errorMessage?: string;
}

export interface SourceHeaderRow {
  id: string;
  name: string;
  value: string;
}

export interface HlsUrlState {
  probe?: HlsProbeInfo;
  variantId?: string;
  assetId?: string;
  segmentCount?: number;
  previewPlaylistUrl?: string;
  retry?: HlsRetryState;
}

export interface MagnetFileDecision {
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  conflictAction?: FileNameConflictAction;
}

export interface MagnetUrlState {
  import?: MagnetImport;
  selectedIndexes: number[];
  fileDecisions?: Record<number, MagnetFileDecision>;
  uploads?: MagnetUploadEntry[];
}

export interface FileNameConflictState {
  fileName: string;
  suggestedName: string;
  directoryPath: string;
  source?: "file" | "batch";
  message?: string;
}

export interface QueueItem {
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

export interface UrlUploadState {
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

export interface UploadRuntimeState {
  progress?: ChunkProgress;
  chunks?: UploadChunkState[];
}

export interface UploadRuntimeStore {
  getSnapshot: () => UploadRuntimeState;
  subscribe: (listener: () => void) => () => void;
  setState: (updater: (current: UploadRuntimeState) => UploadRuntimeState) => UploadRuntimeState;
  reset: () => void;
}

export interface QueuedUrlUploadTask {
  id: string;
  sourceUrl: string;
  directoryPath: string;
  remark: string;
}

export type UploadThumbnailStatus = "idle" | "generating" | "ready" | "failed" | "removed";

export interface UploadThumbnailState {
  status: UploadThumbnailStatus;
  generated?: GeneratedThumbnail;
  remote?: RemoteThumbnailInput;
  message?: string;
}

export interface RemoteThumbnailInput {
  url: string;
  headers?: SourceRequestHeaders;
}

export type ThumbnailUrlPickerTarget =
  | { kind: "item"; id: string }
  | { kind: "url" };

export interface ChunkQueueResult {
  completedChunks: number[];
  failedChunks: number[];
  cancelled: boolean;
}

export interface UploadAbortContext {
  kind: "local" | "url";
  itemId?: string;
  abortController: AbortController;
  controllers: Set<AbortController>;
  cancelled: boolean;
}
