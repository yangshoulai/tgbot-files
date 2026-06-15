import type { FileNameConflictAction, MultipartUpload, SourceRequestHeaders } from "../api";

export type UploadTaskStatus = "pending" | "uploading" | "done" | "error" | "skipped";

export interface MultipartRetryState {
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

export interface HlsRetryState {
  assetId: string;
  fileName: string;
  segmentCount: number;
  previewPlaylistUrl: string;
  conflictAction: FileNameConflictAction;
  completedSegments: number[];
  failedSegments: number[];
}

export interface MagnetUploadEntry {
  fileIndex: number;
  upload: MultipartUpload;
  targetDirectoryPath: string;
  conflictAction: FileNameConflictAction;
}

export type PersistedUploadTask =
  | PersistedLocalUploadTask
  | PersistedUrlMultipartUploadTask
  | PersistedHlsUploadTask
  | PersistedMagnetUploadTask;

export interface PersistedUploadTaskBase {
  version: 1;
  id: string;
  status: "queued" | "running" | "waiting-file" | "failed" | "done" | "cancelled";
  savedAt: number;
  updatedAt: number;
  directoryPath: string;
  remark?: string;
}

export interface PersistedLocalUploadTask extends PersistedUploadTaskBase {
  kind: "local";
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  relativePath?: string;
  retry: MultipartRetryState;
}

export interface PersistedUrlMultipartUploadTask extends PersistedUploadTaskBase {
  kind: "url-multipart";
  sourceUrl: string;
  fileNameOverride?: string;
  sourceHeaders?: SourceRequestHeaders;
  strippedHeaderNames?: string[];
  retry: MultipartRetryState;
}

export interface PersistedHlsUploadTask extends PersistedUploadTaskBase {
  kind: "hls";
  sourceUrl: string;
  fileNameOverride?: string;
  sourceHeaders?: SourceRequestHeaders;
  strippedHeaderNames?: string[];
  variantId?: string;
  retry: HlsRetryState;
}

export interface PersistedMagnetUploadTask extends PersistedUploadTaskBase {
  kind: "magnet";
  sourceUrl: string;
  importId: string;
  selectedIndexes: number[];
  uploads?: MagnetUploadEntry[];
}

export interface UploadTaskQueue {
  version: 1;
  tasks: PersistedUploadTask[];
}
