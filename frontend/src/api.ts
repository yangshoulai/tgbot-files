export interface SessionResponse {
  ok: boolean;
  username: string;
  max_file_bytes: number;
  multipart_chunk_bytes: number;
  max_multipart_file_bytes: number;
  direct_access_max_chunks: number;
  direct_access_max_bytes: number;
  upload_concurrency: number;
  upload_concurrency_min: number;
  upload_concurrency_max: number;
  base_url: string;
  config: {
    database: boolean;
    telegram_bot_token: boolean;
    telegram_storage_chat_id: boolean;
    telegram_channels: boolean;
    tg_channel_secret: boolean;
    link_signing_secret: boolean;
    admin_username: boolean;
    admin_password: boolean;
    admin_session_secret: boolean;
  };
  config_values: {
    database: string;
    telegram_bot_token: string;
    telegram_storage_chat_id: string;
    telegram_channels: string;
    tg_channel_secret: string;
    link_signing_secret: string;
    admin_username: string;
    admin_password: string;
    admin_session_secret: string;
    public_base_url: string;
    max_file_bytes: string;
    max_multipart_file_bytes: string;
    direct_access_max_bytes: string;
  };
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface FileItem {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  md5: string;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  telegram_channel_id?: string;
  file_path: string;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  directory_id: string | null;
  directory_path: string;
  url: string | null;
  download_url: string | null;
  direct_access?: boolean;
  direct_download?: boolean;
  download_strategy?: "direct" | "direct_or_accelerated" | "accelerated";
  storage_backend?: "telegram_single" | "telegram_multipart" | "hls_package";
  chunk_size?: number | null;
  chunk_count?: number | null;
  hls_download?: HlsDownloadSummary | null;
  thumbnail_file_id?: string | null;
  thumbnail_file_unique_id?: string | null;
  thumbnail_file_path?: string | null;
  thumbnail_mime_type?: string | null;
  thumbnail_size?: number | null;
  thumbnail_width?: number | null;
  thumbnail_height?: number | null;
  thumbnail_status?: "none" | "ready" | "failed";
  thumbnail_url?: string | null;
}

export interface SettingsUpdateResponse {
  ok: boolean;
  settings: {
    upload_concurrency: number;
    upload_concurrency_min: number;
    upload_concurrency_max: number;
  };
}

export interface HlsDownloadSummary {
  segment_count: number;
  kind: "ts" | "fmp4" | null;
  part_count: number;
  direct_access: boolean;
  direct_access_max_parts: number;
  downloadable: boolean;
}

export interface HlsDownloadPart {
  index: number;
  kind?: "init" | "segment";
  segment_index: number | null;
  chunk_index: number | null;
  offset: number;
  size: number;
  url: string;
}

export interface HlsDownloadPlan {
  file_id: string;
  file_name: string;
  kind: "ts" | "fmp4";
  total_size: number;
  segment_count: number;
  part_count: number;
  direct_access: boolean;
  direct_access_max_parts: number;
  parts: HlsDownloadPart[];
}

export interface HlsDownloadPlanResponse {
  ok: boolean;
  hls_download: HlsDownloadPlan;
}

export type SourceRequestHeaders = Record<string, string>;

export interface DirectoryItem {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: string;
  deleted_at: string | null;
  file_count: number;
  total_size: number;
}

export interface CurrentDirectory {
  id: string | null;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: string | null;
  deleted_at: string | null;
}

export interface FileListResponse {
  ok: boolean;
  current_directory: CurrentDirectory;
  directories: DirectoryItem[];
  search_scope: "current";
  files: FileItem[];
  pagination: Pagination;
  global_stats: {
    file_count: number;
    total_size: number;
  };
  max_file_bytes: number;
  multipart_chunk_bytes: number;
  max_multipart_file_bytes: number;
  direct_access_max_chunks: number;
  direct_access_max_bytes: number;
}

export interface AdminUploadResponse {
  ok: boolean;
  file: FileItem;
}

export type FileNameConflictAction = "error" | "overwrite";

export interface FileUpdateResponse {
  ok: boolean;
  file: FileItem;
}

export interface DirectoryListResponse {
  ok: boolean;
  directories: DirectoryItem[];
}

export interface DirectoryCreateResponse {
  ok: boolean;
  directory: DirectoryItem;
}

export interface DirectoryDeleteResponse {
  ok: boolean;
  deleted_directories: number;
  deleted_files: number;
  directory: DirectoryItem;
}

export interface DirectoryMoveResponse {
  ok: boolean;
  moved_directories: number;
  moved_files: number;
  directory: DirectoryItem;
}

export interface DirectoryRenameResponse {
  ok: boolean;
  renamed_directories: number;
  updated_files: number;
  directory: DirectoryItem;
}

export interface MoveFilesResponse {
  ok: boolean;
  moved: number;
  directory_path: string;
}

export interface EntryMoveResponse {
  ok: boolean;
  moved: number;
  moved_directories: number;
  moved_files: number;
  directory_path: string;
}

export interface EntryDeleteResponse {
  ok: boolean;
  deleted_directories: number;
  deleted_files: number;
}

export interface MultipartUpload {
  id: string;
  source_kind?: "local" | "url" | "magnet";
  file_name: string;
  mime_type: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  directory_path: string;
  max_multipart_file_bytes: number;
  direct_access?: boolean;
  direct_access_max_chunks?: number;
  direct_access_max_bytes?: number;
  thumbnail_source?: {
    available: boolean;
    kind: "image" | "video";
    url: string;
    mime_type: string;
    expires_at: string;
  } | null;
}

export interface MultipartInitResponse {
  ok: boolean;
  upload: MultipartUpload;
}

export interface UrlMultipartInitResponse {
  ok: boolean;
  mode: "single" | "multipart";
  upload?: MultipartUpload;
  max_file_bytes?: number;
  multipart_chunk_bytes?: number;
  max_multipart_file_bytes?: number;
  direct_access_max_chunks?: number;
  direct_access_max_bytes?: number;
}

export interface MultipartChunkResponse {
  ok: boolean;
  chunk: {
    chunk_index: number;
    size: number;
    md5: string;
    telegram_file_id: string;
    telegram_channel_id?: string;
  };
  uploaded_chunks: number;
}

export interface MultipartUploadStatusResponse {
  ok: boolean;
  upload: MultipartUpload & {
    source_kind: "local" | "url" | "magnet";
  };
  uploaded_chunks: number[];
  missing_chunks: number[];
}

export interface MagnetImportFile {
  id: string;
  file_index: number;
  path: string;
  file_name: string;
  relative_directory_path: string | null;
  size: number;
  mime_type: string;
  chunk_size: number;
  chunk_count: number;
  upload_id: string | null;
  selected: boolean;
  status: "pending" | "selected" | "uploading" | "done" | "failed";
  error_message: string | null;
}

export interface MagnetImport {
  id: string;
  magnet_uri: string;
  info_hash: string | null;
  name: string | null;
  status: "probing" | "ready" | "downloading" | "downloaded" | "importing" | "done" | "failed" | "cancelled";
  file_count: number;
  total_size: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  metadata_completed_at: string | null;
  download_started_at: string | null;
  download_completed_at: string | null;
  completed_at: string | null;
  aria2_status: "active" | "waiting" | "paused" | "error" | "complete" | "removed" | null;
  download_completed_bytes: number | null;
  download_total_bytes: number | null;
  download_progress: number | null;
  download_speed_bytes_per_second: number | null;
  files: MagnetImportFile[];
}

export interface MagnetProbeResponse {
  ok: boolean;
  magnet: MagnetImport;
}

export interface MagnetInitResponse {
  ok: boolean;
  magnet: MagnetImport;
  uploads: Array<{
    file_index: number;
    upload: MultipartUpload;
    target_directory_path: string;
  }>;
}

export interface MagnetFileUploadOption {
  file_index: number;
  file_name?: string;
  on_conflict?: FileNameConflictAction;
}

export interface HlsVariant {
  id: string;
  uri: string;
  bandwidth: number | null;
  resolution: string | null;
  codecs: string | null;
}

export interface HlsMediaSummary {
  playlist_url: string;
  target_duration: number;
  duration: number;
  segment_count: number;
}

export interface HlsProbeInfo {
  playlist_url: string;
  file_name: string;
  kind: "master" | "media";
  selected_variant_id: string | null;
  variants: HlsVariant[];
  media: HlsMediaSummary | null;
}

export interface HlsAsset {
  id: string;
  source_url: string;
  media_playlist_url: string;
  file_name: string;
  mime_type: string;
  directory_id: string | null;
  directory_path: string;
  status: "pending" | "importing" | "done" | "failed" | "cancelled";
  selected_variant_id: string | null;
  target_duration: number;
  duration: number;
  segment_count: number;
  estimated_size: number | null;
  final_file_id: string | null;
  remark: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  preview_playlist_url: string;
}

export interface HlsSegment {
  id: string;
  asset_id: string;
  segment_index: number;
  source_url: string;
  duration: number;
  mime_type: string;
  size: number | null;
  storage_backend: "telegram_single" | "telegram_multipart" | null;
  telegram_channel_id: string;
  multipart_upload_id: string | null;
  chunk_size: number | null;
  chunk_count: number | null;
  status: "pending" | "importing" | "done" | "failed";
  attempts: number;
  error_message: string | null;
  uploaded_chunks: number[];
  missing_chunks: number[];
  completed_at: string | null;
}

export interface HlsUploadInfo {
  asset: HlsAsset;
  segments: HlsSegment[];
}

export interface HlsProbeResponse {
  ok: boolean;
  hls: HlsProbeInfo;
}

export interface HlsInitResponse {
  ok: boolean;
  hls: HlsUploadInfo;
}

export interface HlsSegmentImportResponse {
  ok: boolean;
  segment: HlsSegment;
  uploaded_chunks: number[];
  missing_chunks: number[];
}

export interface UploadPreflightRequestEntry {
  client_id: string;
  directory_path: string;
  file_name: string;
  relative_path?: string;
  size?: number;
}

export interface UploadPreflightResultEntry extends UploadPreflightRequestEntry {
  status: "ready" | "conflict";
  source?: "file" | "batch";
  suggested_name?: string;
  message?: string;
}

export interface UploadPreflightResponse {
  ok: boolean;
  entries: UploadPreflightResultEntry[];
  summary: {
    total: number;
    ready: number;
    conflicts: number;
  };
}

export interface TelegramChannelItem {
  id: string;
  name: string;
  masked_bot_token: string;
  chat_id: string;
  status: "active" | "disabled";
  is_default: boolean;
  configured: boolean;
  created_at: string;
  updated_at: string;
}

export interface TelegramChannelListResponse {
  ok: boolean;
  channels: TelegramChannelItem[];
}

export interface TelegramChannelWriteResponse {
  ok: boolean;
  channel?: TelegramChannelItem | null;
}

export interface TelegramChannelInput {
  name?: string;
  bot_token?: string;
  chat_id?: string;
  status?: "active" | "disabled";
}

export interface ApiKeyItem {
  id: string;
  name: string;
  key?: string;
  masked_key: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface ApiKeyListResponse {
  ok: boolean;
  api_keys: ApiKeyItem[];
}

export interface ApiKeyDetailResponse {
  ok: boolean;
  api_key: ApiKeyItem & { key: string };
}

export interface ApiKeyCreateResponse {
  ok: boolean;
  api_key: ApiKeyItem & { key: string };
}

export interface ApiKeyWriteResponse {
  ok: boolean;
  api_key?: ApiKeyItem;
}

export interface LoginResponse {
  ok: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly error?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    headers: {
      ...(init?.headers ?? {})
    },
    ...init
  });

  const contentType = response.headers.get("Content-Type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await response.json() as T : null;

  if (!response.ok) {
    const errorName =
      isJson && body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : undefined;
    const message =
      isJson && body && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : response.statusText || "请求失败";
    const details =
      isJson && body && typeof body === "object" && "details" in body && isRecord((body as { details?: unknown }).details)
        ? (body as { details: Record<string, unknown> }).details
        : undefined;
    throw new ApiError(response.status, message, errorName, details);
  }

  return body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getSession() {
  return requestJson<SessionResponse>("/api/admin/session");
}

export function login(username: string, password: string, rememberMe: boolean) {
  return requestJson<LoginResponse>("/api/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ username, password, remember_me: rememberMe })
  });
}

export function logout() {
  return requestJson<LoginResponse>("/api/admin/logout", {
    method: "POST"
  });
}

export function updateSettings(body: { upload_concurrency: number }) {
  return requestJson<SettingsUpdateResponse>("/api/admin/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export function listFiles(params: {
  q: string;
  page?: number;
  limit?: number | "all";
  dir?: string;
  all?: boolean;
  type?: "all" | "image" | "video" | "text" | "pdf" | "archive" | "other";
  created_from?: string;
  created_to?: string;
}) {
  const search = new URLSearchParams({
    q: params.q,
    dir: params.dir || "/"
  });

  if (params.page !== undefined) {
    search.set("page", String(params.page));
  }

  if (params.limit !== undefined) {
    search.set("limit", String(params.limit));
  }

  if (params.all) {
    search.set("all", "1");
  }

  if (params.type && params.type !== "all") {
    search.set("type", params.type);
  }

  if (params.created_from) {
    search.set("created_from", params.created_from);
  }

  if (params.created_to) {
    search.set("created_to", params.created_to);
  }

  return requestJson<FileListResponse>(`/api/admin/files?${search.toString()}`);
}

export function getHlsDownloadPlan(fileId: string) {
  return requestJson<HlsDownloadPlanResponse>(`/api/admin/files/${encodeURIComponent(fileId)}/hls-download`);
}

export function uploadFile(formData: FormData, conflictAction?: FileNameConflictAction) {
  if (conflictAction && conflictAction !== "error") {
    formData.set("on_conflict", conflictAction);
  }

  return requestJson<AdminUploadResponse>("/api/admin/files", {
    method: "POST",
    body: formData
  });
}

export function uploadFileFromUrl(
  url: string,
  remark?: string,
  directoryPath = "/",
  fileName?: string,
  conflictAction?: FileNameConflictAction,
  headers?: SourceRequestHeaders
) {
  return requestJson<AdminUploadResponse>("/api/admin/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      directory_path: directoryPath,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(fileName ? { file_name: fileName } : {}),
      ...(conflictAction && conflictAction !== "error" ? { on_conflict: conflictAction } : {}),
      ...(remark ? { remark } : {})
    })
  });
}

export function initMultipartUpload(params: {
  file_name: string;
  mime_type: string;
  size: number;
  remark?: string;
  directory_path?: string;
  on_conflict?: FileNameConflictAction;
}, signal?: AbortSignal) {
  return requestJson<MultipartInitResponse>("/api/admin/uploads/init", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
}

export function uploadMultipartChunk(uploadId: string, chunkIndex: number, chunk: Blob, signal?: AbortSignal) {
  const form = new FormData();
  form.set("chunk", chunk);
  return requestJson<MultipartChunkResponse>(`/api/admin/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`, {
    method: "POST",
    signal,
    body: form
  });
}

export function initUrlMultipartUpload(
  url: string,
  remark?: string,
  directoryPath = "/",
  forceMultipart = false,
  fileName?: string,
  conflictAction?: FileNameConflictAction,
  headers?: SourceRequestHeaders,
  signal?: AbortSignal
) {
  return requestJson<UrlMultipartInitResponse>("/api/admin/uploads/url/init", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      directory_path: directoryPath,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(forceMultipart ? { force_multipart: true } : {}),
      ...(fileName ? { file_name: fileName } : {}),
      ...(conflictAction && conflictAction !== "error" ? { on_conflict: conflictAction } : {}),
      ...(remark ? { remark } : {})
    })
  });
}

export function uploadUrlMultipartChunk(uploadId: string, chunkIndex: number, signal?: AbortSignal) {
  return requestJson<MultipartChunkResponse>(
    `/api/admin/uploads/${encodeURIComponent(uploadId)}/url-chunks/${chunkIndex}`,
    { method: "POST", signal }
  );
}

export function getMultipartUploadStatus(uploadId: string, signal?: AbortSignal) {
  return requestJson<MultipartUploadStatusResponse>(
    `/api/admin/uploads/${encodeURIComponent(uploadId)}/status`,
    { signal }
  );
}

export function probeMagnetUpload(magnet: string, signal?: AbortSignal) {
  return requestJson<MagnetProbeResponse>("/api/admin/uploads/magnet/probe", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ magnet })
  });
}

export function getMagnetUploadStatus(importId: string, signal?: AbortSignal) {
  return requestJson<MagnetProbeResponse>(
    `/api/admin/uploads/magnet/${encodeURIComponent(importId)}/status`,
    { signal }
  );
}

export function initMagnetUpload(params: {
  import_id: string;
  file_indexes: number[];
  file_options?: MagnetFileUploadOption[];
  directory_path?: string;
  remark?: string;
  on_conflict?: FileNameConflictAction;
}, signal?: AbortSignal) {
  return requestJson<MagnetInitResponse>(
    `/api/admin/uploads/magnet/${encodeURIComponent(params.import_id)}/init`,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        file_indexes: params.file_indexes,
        ...(params.file_options && params.file_options.length > 0 ? { file_options: params.file_options } : {}),
        ...(params.directory_path ? { directory_path: params.directory_path } : {}),
        ...(params.remark ? { remark: params.remark } : {}),
        ...(params.on_conflict && params.on_conflict !== "error" ? { on_conflict: params.on_conflict } : {})
      })
    }
  );
}

export function uploadMagnetMultipartChunk(importId: string, fileIndex: number, chunkIndex: number, signal?: AbortSignal) {
  return requestJson<MultipartChunkResponse>(
    `/api/admin/uploads/magnet/${encodeURIComponent(importId)}/files/${fileIndex}/chunks/${chunkIndex}`,
    { method: "POST", signal }
  );
}

export function magnetThumbnailSourceUrl(importId: string, fileIndex: number): string {
  return `/api/admin/uploads/magnet/${encodeURIComponent(importId)}/files/${fileIndex}/thumbnail-source`;
}

export function completeMagnetMultipartUpload(
  importId: string,
  fileIndex: number,
  thumbnail?: ThumbnailUploadPayload,
  signal?: AbortSignal,
  conflictAction?: FileNameConflictAction
) {
  const path = `/api/admin/uploads/magnet/${encodeURIComponent(importId)}/files/${fileIndex}/complete`;

  if (!thumbnail) {
    return requestJson<AdminUploadResponse>(path, {
      method: "POST",
      signal,
      ...(conflictAction && conflictAction !== "error"
        ? {
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ on_conflict: conflictAction })
          }
        : {})
    });
  }

  const form = new FormData();
  if (conflictAction && conflictAction !== "error") {
    form.set("on_conflict", conflictAction);
  }
  form.set("thumbnail", thumbnail.blob, thumbnail.fileName);
  if (thumbnail.width) form.set("thumbnail_width", String(thumbnail.width));
  if (thumbnail.height) form.set("thumbnail_height", String(thumbnail.height));

  return requestJson<AdminUploadResponse>(path, {
    method: "POST",
    signal,
    body: form
  });
}

export function cancelMagnetUpload(importId: string, signal?: AbortSignal) {
  return requestJson<{ ok: boolean }>(
    `/api/admin/uploads/magnet/${encodeURIComponent(importId)}`,
    { method: "DELETE", signal }
  );
}

export function preflightUploads(entries: UploadPreflightRequestEntry[], signal?: AbortSignal) {
  return requestJson<UploadPreflightResponse>("/api/admin/uploads/preflight", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ entries })
  });
}

export function probeHlsUpload(
  url: string,
  variantId?: string,
  headers?: SourceRequestHeaders,
  signal?: AbortSignal
) {
  return requestJson<HlsProbeResponse>("/api/admin/uploads/hls/probe", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(variantId ? { variant_id: variantId } : {})
    })
  });
}

export function initHlsUpload(params: {
  url: string;
  variant_id?: string;
  file_name?: string;
  directory_path?: string;
  remark?: string;
  on_conflict?: FileNameConflictAction;
  headers?: SourceRequestHeaders;
}, signal?: AbortSignal) {
  return requestJson<HlsInitResponse>("/api/admin/uploads/hls/init", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
}

export function getHlsUploadStatus(assetId: string, signal?: AbortSignal) {
  return requestJson<HlsInitResponse>(
    `/api/admin/uploads/hls/${encodeURIComponent(assetId)}/status`,
    { signal }
  );
}

export function importHlsSegment(assetId: string, segmentIndex: number, signal?: AbortSignal) {
  return requestJson<HlsSegmentImportResponse>(
    `/api/admin/uploads/hls/${encodeURIComponent(assetId)}/segments/${segmentIndex}/import`,
    { method: "POST", signal }
  );
}

export function importHlsSegmentChunk(assetId: string, segmentIndex: number, chunkIndex: number, signal?: AbortSignal) {
  return requestJson<HlsSegmentImportResponse>(
    `/api/admin/uploads/hls/${encodeURIComponent(assetId)}/segments/${segmentIndex}/chunks/${chunkIndex}/import`,
    { method: "POST", signal }
  );
}

export function completeHlsSegment(assetId: string, segmentIndex: number, signal?: AbortSignal) {
  return requestJson<HlsSegmentImportResponse>(
    `/api/admin/uploads/hls/${encodeURIComponent(assetId)}/segments/${segmentIndex}/complete`,
    { method: "POST", signal }
  );
}

export function cancelHlsUpload(assetId: string, signal?: AbortSignal) {
  return requestJson<{ ok: boolean }>(
    `/api/admin/uploads/hls/${encodeURIComponent(assetId)}`,
    { method: "DELETE", signal }
  );
}

export interface ThumbnailUploadPayload {
  blob: Blob;
  fileName: string;
  width?: number;
  height?: number;
}

export function completeMultipartUpload(
  uploadId: string,
  thumbnail?: ThumbnailUploadPayload,
  signal?: AbortSignal,
  conflictAction?: FileNameConflictAction
) {
  const path = `/api/admin/uploads/${encodeURIComponent(uploadId)}/complete`;

  if (!thumbnail) {
    return requestJson<AdminUploadResponse>(path, {
      method: "POST",
      signal,
      ...(conflictAction && conflictAction !== "error"
        ? {
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ on_conflict: conflictAction })
          }
        : {})
    });
  }

  const form = new FormData();
  if (conflictAction && conflictAction !== "error") {
    form.set("on_conflict", conflictAction);
  }
  form.set("thumbnail", thumbnail.blob, thumbnail.fileName);
  if (thumbnail.width) form.set("thumbnail_width", String(thumbnail.width));
  if (thumbnail.height) form.set("thumbnail_height", String(thumbnail.height));

  return requestJson<AdminUploadResponse>(path, {
    method: "POST",
    signal,
    body: form
  });
}

export function completeHlsUpload(
  assetId: string,
  thumbnail?: ThumbnailUploadPayload,
  signal?: AbortSignal,
  conflictAction?: FileNameConflictAction
) {
  const path = `/api/admin/uploads/hls/${encodeURIComponent(assetId)}/complete`;

  if (!thumbnail) {
    return requestJson<AdminUploadResponse>(path, {
      method: "POST",
      signal,
      ...(conflictAction && conflictAction !== "error"
        ? {
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ on_conflict: conflictAction })
          }
        : {})
    });
  }

  const form = new FormData();
  if (conflictAction && conflictAction !== "error") {
    form.set("on_conflict", conflictAction);
  }
  form.set("thumbnail", thumbnail.blob, thumbnail.fileName);
  if (thumbnail.width) form.set("thumbnail_width", String(thumbnail.width));
  if (thumbnail.height) form.set("thumbnail_height", String(thumbnail.height));

  return requestJson<AdminUploadResponse>(path, {
    method: "POST",
    signal,
    body: form
  });
}

export function deleteFile(id: string) {
  return requestJson<{ ok: boolean }>(`/api/admin/files/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export function updateFileMetadata(id: string, body: { file_name?: string; remark?: string | null }) {
  return requestJson<FileUpdateResponse>(`/api/admin/files/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export function listDirectories(flat = false, parentPath = "/") {
  const search = new URLSearchParams();
  if (flat) {
    search.set("flat", "1");
  } else {
    search.set("parent_path", parentPath);
  }

  return requestJson<DirectoryListResponse>(`/api/admin/directories?${search.toString()}`);
}

export function createDirectory(parentPath: string, name: string) {
  return requestJson<DirectoryCreateResponse>("/api/admin/directories", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ parent_path: parentPath, name })
  });
}

export function deleteDirectory(id: string) {
  return requestJson<DirectoryDeleteResponse>(`/api/admin/directories/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export function moveDirectory(id: string, parentPath: string) {
  return requestJson<DirectoryMoveResponse>(`/api/admin/directories/${encodeURIComponent(id)}/move`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ parent_path: parentPath })
  });
}

export function renameDirectory(id: string, name: string) {
  return requestJson<DirectoryRenameResponse>(`/api/admin/directories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });
}

export function moveFiles(params: {
  file_ids: string[];
  directory_path?: string;
  new_directory_parent_path?: string;
  new_directory_name?: string;
}) {
  return requestJson<MoveFilesResponse>("/api/admin/files/move", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
}

export function moveEntries(params: {
  file_ids?: string[];
  directory_ids?: string[];
  directory_path?: string;
  new_directory_parent_path?: string;
  new_directory_name?: string;
}) {
  return requestJson<EntryMoveResponse>("/api/admin/entries/move", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
}

export function deleteEntries(params: { file_ids?: string[]; directory_ids?: string[] }) {
  return requestJson<EntryDeleteResponse>("/api/admin/entries/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
}

export function listTelegramChannels() {
  return requestJson<TelegramChannelListResponse>("/api/admin/telegram-channels");
}

export function createTelegramChannel(body: Required<Pick<TelegramChannelInput, "name" | "bot_token" | "chat_id">> & { status?: "active" | "disabled" }) {
  return requestJson<TelegramChannelWriteResponse>("/api/admin/telegram-channels", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export function updateTelegramChannel(id: string, body: TelegramChannelInput) {
  return requestJson<TelegramChannelWriteResponse>(`/api/admin/telegram-channels/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export function deleteTelegramChannel(id: string) {
  return requestJson<{ ok: boolean }>(`/api/admin/telegram-channels/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export function listApiKeys() {
  return requestJson<ApiKeyListResponse>("/api/admin/api-keys");
}

export function createApiKey(name: string) {
  return requestJson<ApiKeyCreateResponse>("/api/admin/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });
}

export function getApiKey(id: string) {
  return requestJson<ApiKeyDetailResponse>(`/api/admin/api-keys/${encodeURIComponent(id)}`);
}

export function updateApiKey(id: string, body: { name?: string; status?: "active" | "disabled" }) {
  return requestJson<ApiKeyWriteResponse>(`/api/admin/api-keys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export function deleteApiKey(id: string) {
  return requestJson<{ ok: boolean }>(`/api/admin/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
