import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type {
  MagnetImport,
  MultipartUpload,
  SourceRequestHeaders,
  ThumbnailUploadPayload
} from "../../../api";
import type {
  HlsRetryState,
  MagnetUploadEntry,
  MultipartRetryState
} from "../../../lib/upload-tasks";

import type {
  MagnetFileDecision,
  QueueItem,
  UploadAbortContext,
  UploadRuntimeStore,
  UrlUploadState
} from "./types";

export interface UploadEngineContext {
  // State values
  items: QueueItem[];
  urlUpload: UrlUploadState;
  sourceUrl: string;
  normalizedSourceUrl: string;
  remark: string;
  uploadDirectoryPath: string;
  effectiveUploadConcurrency: number;
  maxMultipartBytes: number;
  uploadBusy: boolean;

  // Refs
  itemsRef: MutableRefObject<QueueItem[]>;
  urlUploadRef: MutableRefObject<UrlUploadState>;

  // Runtime store
  urlRuntimeStore: UploadRuntimeStore;

  // Setters
  setItems: Dispatch<SetStateAction<QueueItem[]>>;
  setUrlUpload: Dispatch<SetStateAction<UrlUploadState>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;

  // Props
  onError: (message: string) => void;
  onUploaded: (count: number) => void;

  // Component helpers (not moved)
  startUploadTask: (kind: "local" | "url", itemId?: string) => UploadAbortContext;
  finishUploadTask: (task: UploadAbortContext) => void;
  validateSourceUrl: (value: string) => string | undefined;
  readSourceHeadersForUpload: () =>
    | { ok: true; headers?: SourceRequestHeaders }
    | { ok: false };
  persistLocalUploadTask: (item: QueueItem, retry: MultipartRetryState) => void;
  persistUrlMultipartUploadTask: (retry: MultipartRetryState, fileNameOverride?: string) => void;
  persistHlsUploadTask: (retry: HlsRetryState, fileNameOverride?: string, variantId?: string) => void;
  persistMagnetUploadTask: (importId: string, selectedIndexes: number[], uploads?: MagnetUploadEntry[]) => void;
  clearCurrentPersistedTask: (options?: { allowFallback?: boolean }) => void;
  preflightMagnetSelection: (
    magnet: MagnetImport,
    selectedIndexes: number[],
    decisions?: Record<number, MagnetFileDecision>
  ) => Promise<boolean>;
  resolveLocalThumbnailForUpload: (target: QueueItem) => Promise<ThumbnailUploadPayload | undefined>;
  resolveUrlThumbnailForUpload: (
    source: MultipartUpload["thumbnail_source"] | undefined
  ) => Promise<ThumbnailUploadPayload | undefined>;
  resolveMagnetThumbnailForUpload: (
    importId: string,
    fileIndex: number,
    upload: MultipartUpload
  ) => Promise<ThumbnailUploadPayload | undefined>;
  resolveHlsThumbnailForUpload: (
    previewPlaylistUrl: string,
    fileName: string
  ) => Promise<ThumbnailUploadPayload | undefined>;
  maybeGenerateHlsThumbnail: (previewPlaylistUrl: string, fileName: string) => Promise<void>;
}
