import type { HlsRetryState, MultipartRetryState } from "../../../lib/upload-tasks";

export const DEFAULT_UPLOAD_CONCURRENCY = 5;
export const MULTIPART_UPLOAD_MAX_ATTEMPTS = 3;
export const MULTIPART_UPLOAD_RETRY_DELAY_MS = 800;
export const LOCAL_CHUNK_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const URL_CHUNK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const HLS_SEGMENT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const MAGNET_STATUS_POLL_MS = 2_000;
export const MAGNET_DOWNLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAGNET_STATUS_MAX_TRANSIENT_FAILURES = 5;
export const MAGNET_STATUS_RETRY_DELAY_MS = 2_000;
export const FILE_NAME_CONFLICT_TOAST_MESSAGE = "上传目录已存在同名文件，请选择覆盖或改名上传";
export const CHUNK_UI_UPDATE_INTERVAL_MS = 160;
export const TASK_SNAPSHOT_UPDATE_INTERVAL_MS = 500;
export const MAX_RENDERABLE_CHUNKS = 100;

export class MultipartChunkUploadError extends Error {
  constructor(
    message: string,
    public readonly retry: MultipartRetryState,
    public readonly stopped = false
  ) {
    super(message);
    this.name = "MultipartChunkUploadError";
  }
}

export class HlsSegmentUploadError extends Error {
  constructor(
    message: string,
    public readonly retry: HlsRetryState,
    public readonly stopped = false
  ) {
    super(message);
    this.name = "HlsSegmentUploadError";
  }
}
