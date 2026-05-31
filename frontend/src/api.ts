export interface SessionResponse {
  ok: boolean;
  username: string;
  max_file_bytes: number;
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
  url: string;
  download_url: string;
}

export interface FileListResponse {
  ok: boolean;
  files: FileItem[];
  pagination: Pagination;
  max_file_bytes: number;
}

export interface AdminUploadResponse {
  ok: boolean;
  file: FileItem;
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
  type?: "all" | "image" | "text" | "pdf" | "archive" | "other";
  created_from?: string;
  created_to?: string;
}) {
  const search = new URLSearchParams({
    q: params.q,
    page: String(params.page),
    limit: String(params.limit)
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

export function uploadFileFromUrl(url: string, remark?: string) {
  return requestJson<AdminUploadResponse>("/api/admin/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url,
      ...(remark ? { remark } : {})
    })
  });
}

export function deleteFile(id: string) {
  return requestJson<{ ok: boolean }>(`/api/admin/files/${encodeURIComponent(id)}`, {
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
