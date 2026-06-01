export interface SessionResponse {
  ok: boolean;
  username: string;
  max_file_bytes: number;
  multipart_chunk_bytes: number;
  max_multipart_file_bytes: number;
  base_url: string;
  config: {
    files_db: boolean;
    telegram_bot_token: boolean;
    telegram_storage_chat_id: boolean;
    link_signing_secret: boolean;
    admin_username: boolean;
    admin_password: boolean;
    admin_session_secret: boolean;
  };
  config_values: {
    files_db: string;
    telegram_bot_token: string;
    telegram_storage_chat_id: string;
    link_signing_secret: string;
    admin_username: string;
    admin_password: string;
    admin_session_secret: string;
    public_base_url: string;
    max_file_bytes: string;
    max_multipart_file_bytes: string;
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
  file_path: string;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  directory_id: string | null;
  directory_path: string;
  url: string;
  download_url: string;
  storage_backend?: "telegram_single" | "telegram_multipart";
  chunk_size?: number | null;
  chunk_count?: number | null;
}

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
}

export interface AdminUploadResponse {
  ok: boolean;
  file: FileItem;
}

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
  file_name: string;
  mime_type: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  directory_path: string;
  max_multipart_file_bytes: number;
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
}

export interface MultipartChunkResponse {
  ok: boolean;
  chunk: {
    chunk_index: number;
    size: number;
    md5: string;
    telegram_file_id: string;
  };
  uploaded_chunks: number;
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
    message: string
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
    const message =
      isJson && body && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : response.statusText || "请求失败";
    throw new ApiError(response.status, message);
  }

  return body as T;
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

export function listFiles(params: {
  q: string;
  page: number;
  limit: number;
  dir?: string;
  type?: "all" | "image" | "text" | "pdf" | "archive" | "other";
  created_from?: string;
  created_to?: string;
}) {
  const search = new URLSearchParams({
    q: params.q,
    page: String(params.page),
    limit: String(params.limit),
    dir: params.dir || "/"
  });

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

export function uploadFile(formData: FormData) {
  return requestJson<AdminUploadResponse>("/api/admin/files", {
    method: "POST",
    body: formData
  });
}

export function uploadFileFromUrl(url: string, remark?: string, directoryPath = "/") {
  return requestJson<AdminUploadResponse>("/api/admin/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      directory_path: directoryPath,
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
}) {
  return requestJson<MultipartInitResponse>("/api/admin/uploads/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
}

export function uploadMultipartChunk(uploadId: string, chunkIndex: number, chunk: Blob) {
  const form = new FormData();
  form.set("chunk", chunk);
  return requestJson<MultipartChunkResponse>(`/api/admin/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`, {
    method: "POST",
    body: form
  });
}

export function initUrlMultipartUpload(url: string, remark?: string, directoryPath = "/") {
  return requestJson<UrlMultipartInitResponse>("/api/admin/uploads/url/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      directory_path: directoryPath,
      ...(remark ? { remark } : {})
    })
  });
}

export function uploadUrlMultipartChunk(uploadId: string, chunkIndex: number) {
  return requestJson<MultipartChunkResponse>(
    `/api/admin/uploads/${encodeURIComponent(uploadId)}/url-chunks/${chunkIndex}`,
    { method: "POST" }
  );
}

export function completeMultipartUpload(uploadId: string) {
  return requestJson<AdminUploadResponse>(`/api/admin/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: "POST"
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
