import {
  createAdminSessionCookie,
  createExpiredAdminSessionCookie,
  requireAdminSession,
  requireAdminSessionInfo,
  validateAdminCredentials
} from "./admin-auth";
import { createSignedToken, TokenError, verifySignedToken } from "./crypto";
import {
  findActiveApiKeyRecord,
  getApiKeyRecord,
  insertApiKeyRecord,
  insertFileRecord,
  listApiKeyRecords,
  listFileRecords,
  requireDb,
  softDeleteApiKeyRecord,
  softDeleteFileRecord,
  touchApiKeyRecord,
  updateApiKeyRecord,
  type ApiKeyRecord,
  type ApiKeyStatus,
  type FileRecord,
  type FileTypeFilter
} from "./database";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  errorResponse,
  jsonResponse,
  normalizeBaseUrl,
  parseMaxFileBytes,
  redirectResponse,
  requireEnv,
  sanitizeFileName,
  withSecurityHeaders
} from "./http";
import { md5Hex } from "./md5";
import { extensionForMimeType, mimeTypeForFileName, resolveStoredMimeType } from "./mime";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "./telegram";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_STORAGE_CHAT_ID: string;
  LINK_SIGNING_SECRET: string;
  FILES_DB?: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  MAX_FILE_BYTES?: string;
}

interface UploadResult {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  md5: string;
  filePath: string;
  publicUrl: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  remark?: string;
  createdAt: string;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      if (error instanceof AppError) {
        return errorResponse(error);
      }

      if (error instanceof TokenError) {
        return errorResponse(new AppError(401, "InvalidFileToken", "Invalid or tampered file token"));
      }

      console.error("Unexpected worker error", error);
      return errorResponse(new AppError(500, "InternalError", "Internal server error"));
    }
  }
};

export default worker;

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withSecurityHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/") {
    return jsonResponse({
      ok: true,
      service: "tgbot-files",
      endpoints: {
        upload: "POST /api/v1/files",
        file: "GET /f/:token/:filename?",
        admin: "GET /admin"
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    return handleAdminLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    return handleAdminLogout(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminSession(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/files" || url.pathname.startsWith("/api/admin/files/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminFiles(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/api-keys" || url.pathname.startsWith("/api/admin/api-keys/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminApiKeys(request, env));
  }

  if (request.method === "POST" && url.pathname === "/api/v1/files") {
    return handleUpload(request, env);
  }

  if (request.method === "GET" && url.pathname.startsWith("/f/")) {
    return handleFileAccess(request, env);
  }

  return errorResponse(new AppError(404, "NotFound", "Route not found"));
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  await requireUploadApiKey(request, db);

  const { file } = await readUploadInput(request, env);
  const result = await uploadAndRecordFile({
    request,
    env,
    file,
    db
  });

  return jsonResponse({
    ok: true,
    url: result.publicUrl,
    name: result.name,
    size: result.size,
    mime_type: result.mimeType
  });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const credentials = await readLoginCredentials(request);
  const isFormRequest = isFormContentType(request.headers.get("Content-Type"));

  if (!validateAdminCredentials({ env, ...credentials })) {
    if (isFormRequest) {
      return redirectResponse("/login?error=1", 303);
    }

    throw new AppError(401, "Unauthorized", "Invalid admin username or password");
  }

  const cookie = await createAdminSessionCookie({
    env,
    requestUrl: request.url,
    username: credentials.username,
    persistent: credentials.rememberMe
  });

  if (isFormRequest) {
    return redirectResponse("/admin", 303, { "Set-Cookie": cookie });
  }

  return jsonResponse({ ok: true }, 200, { "Set-Cookie": cookie });
}

async function handleAdminLogout(request: Request, env: Env): Promise<Response> {
  await requireAdminSession(request, env);

  return jsonResponse(
    { ok: true },
    200,
    { "Set-Cookie": createExpiredAdminSessionCookie(request.url) }
  );
}

async function handleAuthenticatedAdminRequest(
  request: Request,
  env: Env,
  handler: (username: string) => Promise<Response>
): Promise<Response> {
  const session = await requireAdminSessionInfo(request, env);
  const response = await handler(session.username);

  if (!response.ok) {
    return response;
  }

  const cookie = await createAdminSessionCookie({
    env,
    requestUrl: request.url,
    username: session.username,
    persistent: session.persistent
  });
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", cookie);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleAdminSession(request: Request, env: Env, username: string): Promise<Response> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const baseUrl = getPublicBaseUrl(request, env);

  return jsonResponse({
    ok: true,
    username,
    max_file_bytes: maxFileBytes,
    base_url: baseUrl,
    config: {
      files_db: Boolean(env.FILES_DB),
      telegram_bot_token: hasEnvValue(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: hasEnvValue(env.TELEGRAM_STORAGE_CHAT_ID),
      link_signing_secret: hasEnvValue(env.LINK_SIGNING_SECRET),
      admin_username: hasEnvValue(env.ADMIN_USERNAME),
      admin_password: hasEnvValue(env.ADMIN_PASSWORD),
      admin_session_secret: hasEnvValue(env.ADMIN_SESSION_SECRET)
    },
    config_values: {
      files_db: env.FILES_DB ? "已绑定" : "未绑定",
      telegram_bot_token: maskSecret(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: env.TELEGRAM_STORAGE_CHAT_ID?.trim() || "未配置",
      link_signing_secret: maskSecret(env.LINK_SIGNING_SECRET),
      admin_username: env.ADMIN_USERNAME?.trim() || "未配置",
      admin_password: maskSecret(env.ADMIN_PASSWORD),
      admin_session_secret: env.ADMIN_SESSION_SECRET?.trim()
        ? maskSecret(env.ADMIN_SESSION_SECRET)
        : "未单独配置，使用签名密钥",
      public_base_url: baseUrl,
      max_file_bytes: String(maxFileBytes)
    }
  });
}

async function handleAdminFiles(request: Request, env: Env, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/files") {
    const page = parsePositiveInteger(url.searchParams.get("page"), 1, 1, 100000);
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 24, 1, 100);
    const type = normalizeFileTypeFilter(url.searchParams.get("type"));
    const createdFrom = normalizeDateTimeParam(url.searchParams.get("created_from"), "created_from");
    const createdTo = normalizeDateTimeParam(url.searchParams.get("created_to"), "created_to");
    const result = await listFileRecords({
      db,
      query: url.searchParams.get("q") || "",
      ...(type ? { type } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
      page,
      limit
    });
    const baseUrl = getPublicBaseUrl(request, env);
    const files = result.files.map((file) => serializeFileRecord(file, baseUrl));

    return jsonResponse({
      ok: true,
      files,
      pagination: {
        page,
        limit,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / limit))
      },
      max_file_bytes: parseMaxFileBytes(env.MAX_FILE_BYTES)
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/files") {
    const { file: formFile, remark } = await readUploadInput(request, env);
    const result = await uploadAndRecordFile({
      request,
      env,
      file: formFile,
      db,
      uploadedBy: username,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      file: {
        id: result.id,
        file_name: result.name,
        mime_type: result.mimeType,
        size: result.size,
        md5: result.md5,
        telegram_file_id: result.telegramFileId,
        telegram_file_unique_id: result.telegramFileUniqueId ?? null,
        file_path: result.filePath,
        remark: result.remark ?? null,
        url: result.publicUrl,
        download_url: appendDownloadParam(result.publicUrl),
        uploaded_by: username,
        created_at: result.createdAt
      }
    });
  }

  const deleteMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const deleted = await softDeleteFileRecord(db, decodeURIComponent(deleteMatch[1]), new Date().toISOString());

    if (!deleted) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin file route not found"));
}

async function handleAdminApiKeys(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/api-keys") {
    const records = await listApiKeyRecords(db);

    return jsonResponse({
      ok: true,
      api_keys: records.map((record) => serializeApiKeyRecord(record, false))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/api-keys") {
    const body = await readJsonObject(request);
    const name = normalizeName(body.name, "API key name");
    const createdAt = new Date().toISOString();
    const record = await insertApiKeyRecord(db, {
      id: crypto.randomUUID(),
      name,
      key: generateApiKey(),
      createdAt
    });

    return jsonResponse({ ok: true, api_key: serializeApiKeyRecord(record, true) }, 201);
  }

  const match = /^\/api\/admin\/api-keys\/([^/]+)$/.exec(url.pathname);
  const id = match?.[1] ? decodeURIComponent(match[1]) : "";

  if (!id) {
    return errorResponse(new AppError(404, "NotFound", "Admin API key route not found"));
  }

  if (request.method === "GET") {
    const record = await getApiKeyRecord(db, id);

    if (!record) {
      throw new AppError(404, "NotFound", "API key not found");
    }

    return jsonResponse({ ok: true, api_key: serializeApiKeyRecord(record, true) });
  }

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const name = body.name === undefined ? undefined : normalizeName(body.name, "API key name");
    const status = body.status === undefined ? undefined : normalizeApiKeyStatus(body.status);
    const record = await updateApiKeyRecord({
      db,
      id,
      updatedAt: new Date().toISOString(),
      ...(name ? { name } : {}),
      ...(status ? { status } : {})
    });

    if (!record) {
      throw new AppError(404, "NotFound", "API key not found");
    }

    return jsonResponse({ ok: true, api_key: serializeApiKeyRecord(record, false) });
  }

  if (request.method === "DELETE") {
    const deleted = await softDeleteApiKeyRecord(db, id, new Date().toISOString());

    if (!deleted) {
      throw new AppError(404, "NotFound", "API key not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(405, "MethodNotAllowed", "Unsupported API key method"));
}

async function readUploadInput(request: Request, env: Env): Promise<{ file: File; remark?: string }> {
  const contentType = request.headers.get("Content-Type") || "";
  const normalizedContentType = contentType.toLowerCase();

  if (normalizedContentType.includes("application/json")) {
    return readUrlUploadJson(request, env);
  }

  if (!normalizedContentType.includes("multipart/form-data")) {
    throw new AppError(400, "InvalidContentType", "Upload request must use multipart/form-data or application/json");
  }

  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const formData = await request.formData();
  const formFile = formData.get("file");
  const remark = normalizeRemark(formData.get("remark"));

  if (formFile instanceof File) {
    validateUploadFileSize(formFile, maxFileBytes);

    return {
      file: formFile,
      ...(remark ? { remark } : {})
    };
  }

  const sourceUrl = normalizeSourceUrl(formData.get("url"));
  if (sourceUrl) {
    const file = await downloadFileFromUrl({
      sourceUrl,
      maxFileBytes
    });

    return {
      file,
      ...(remark ? { remark } : {})
    };
  }

  throw new AppError(400, "MissingFile", "Multipart field 'file' is required");
}

async function readUrlUploadJson(request: Request, env: Env): Promise<{ file: File; remark?: string }> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const body = await readJsonObject(request);
  const sourceUrl = normalizeSourceUrl(body.url);

  if (!sourceUrl) {
    throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
  }

  const file = await downloadFileFromUrl({
    sourceUrl,
    maxFileBytes
  });
  const remark = normalizeRemark(body.remark);

  return {
    file,
    ...(remark ? { remark } : {})
  };
}

function validateUploadFileSize(file: File, maxFileBytes: number): void {
  if (file.size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (file.size > maxFileBytes) {
    throw new AppError(413, "FileTooLarge", `File size must be <= ${maxFileBytes} bytes`, {
      max_file_bytes: maxFileBytes,
      actual_file_bytes: file.size
    });
  }
}

function normalizeSourceUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 4096) {
    throw new AppError(400, "InvalidUrl", "URL is too long");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new AppError(400, "InvalidUrl", "URL must be absolute");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "InvalidUrl", "URL protocol must be http or https");
  }

  return url;
}

async function downloadFileFromUrl(params: {
  sourceUrl: URL;
  maxFileBytes: number;
}): Promise<File> {
  let response: Response;

  try {
    response = await fetch(params.sourceUrl.toString(), {
      redirect: "follow",
      headers: {
        Accept: "*/*"
      }
    });
  } catch {
    throw new AppError(502, "UrlFetchFailed", "Failed to fetch source URL");
  }

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "UrlFetchFailed",
      `Source URL returned ${response.status}`,
      { source_status: response.status }
    );
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength > params.maxFileBytes) {
    throw new AppError(413, "FileTooLarge", `File size must be <= ${params.maxFileBytes} bytes`, {
      max_file_bytes: params.maxFileBytes,
      actual_file_bytes: contentLength
    });
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new AppError(502, "UrlFetchFailed", "Failed to read source URL response");
  }

  const initialFileName = inferRemoteFileName(params.sourceUrl, response.headers);
  const remoteMimeHint = pickRemoteMimeHint(response.headers.get("Content-Type"), initialFileName);
  const detectedMimeType = resolveStoredMimeType({
    bytes,
    fileType: remoteMimeHint
  });
  const fileName = ensureFileExtension(sanitizeFileName(initialFileName), detectedMimeType);
  const file = new File([bytes], fileName, { type: detectedMimeType });

  validateUploadFileSize(file, params.maxFileBytes);

  return file;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function pickRemoteMimeHint(contentType: string | null, fileName: string): string | undefined {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  const nameMimeType = mimeTypeForFileName(fileName);

  if (normalizedContentType && normalizedContentType !== "application/octet-stream") {
    return normalizedContentType;
  }

  return nameMimeType ?? normalizedContentType;
}

function inferRemoteFileName(sourceUrl: URL, headers: Headers): string {
  const contentDispositionName = parseContentDispositionFileName(headers.get("Content-Disposition"));
  if (contentDispositionName) {
    return contentDispositionName;
  }

  const rawSegment = sourceUrl.pathname.split("/").filter(Boolean).at(-1);
  if (!rawSegment) {
    return "download";
  }

  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return rawSegment;
  }
}

function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const encodedMatch = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value);
  const encodedValue = encodedMatch?.[1]?.trim();
  if (encodedValue) {
    const decoded = decodeContentDispositionFileName(encodedValue);
    if (decoded) {
      return decoded;
    }
  }

  const plainMatch = /(?:^|;)\s*filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  const plainValue = plainMatch?.[2] ?? plainMatch?.[1];
  const normalized = plainValue?.trim().replace(/^"|"$/g, "");

  return normalized || undefined;
}

function decodeContentDispositionFileName(value: string): string | undefined {
  const normalized = value.replace(/^"|"$/g, "");
  const encodedPart = normalized.includes("''") ? normalized.split("''").slice(1).join("''") : normalized;

  try {
    return decodeURIComponent(encodedPart);
  } catch {
    return encodedPart || undefined;
  }
}

function ensureFileExtension(fileName: string, mimeType: string): string {
  if (/\.[a-z0-9]{1,12}$/i.test(fileName)) {
    return fileName;
  }

  const extension = extensionForMimeType(mimeType);

  return extension ? `${fileName}.${extension}` : fileName;
}

async function uploadAndRecordFile(params: {
  request: Request;
  env: Env;
  file: File;
  db?: D1Database;
  uploadedBy?: string;
  remark?: string;
}): Promise<UploadResult> {
  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv(params.env, "TELEGRAM_STORAGE_CHAT_ID");
  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const fileName = sanitizeFileName(params.file.name);
  const fileBytes = await params.file.arrayBuffer();
  const md5 = md5Hex(fileBytes);
  const uploadMimeType = resolveStoredMimeType({
    bytes: fileBytes,
    fileType: params.file.type
  });
  const uploadFile = uploadMimeType === params.file.type
    ? params.file
    : new File([fileBytes], fileName, { type: uploadMimeType });

  const telegramDocument = await uploadDocumentToTelegram({
    botToken,
    chatId,
    file: uploadFile,
    fileName
  });
  const storedName = telegramDocument.file_name ? sanitizeFileName(telegramDocument.file_name) : fileName;
  const mimeType = resolveStoredMimeType({
    bytes: fileBytes,
    fileType: params.file.type,
    telegramMimeType: telegramDocument.mime_type
  });
  const fileSize = telegramDocument.file_size ?? params.file.size;
  const createdAt = new Date().toISOString();
  const token = await createSignedToken(
    {
      v: 1,
      file_id: telegramDocument.file_id,
      name: storedName,
      mime_type: mimeType,
      size: fileSize,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );

  const id = crypto.randomUUID();
  const baseUrl = getPublicBaseUrl(params.request, params.env);
  const publicName = encodeURIComponent(storedName);
  const filePath = `/f/${token}/${publicName}`;
  const publicUrl = `${baseUrl}${filePath}`;

  if (params.db) {
    await insertFileRecord(params.db, {
      id,
      fileName: storedName,
      mimeType,
      size: fileSize,
      md5,
      telegramFileId: telegramDocument.file_id,
      filePath,
      createdAt,
      ...(params.remark ? { remark: params.remark } : {}),
      ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
      ...(params.uploadedBy ? { uploadedBy: params.uploadedBy } : {})
    });
  }

  return {
    id,
    name: storedName,
    size: fileSize,
    mimeType,
    md5,
    filePath,
    publicUrl,
    telegramFileId: telegramDocument.file_id,
    ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
    ...(params.remark ? { remark: params.remark } : {}),
    createdAt
  };
}

async function handleFileAccess(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractFileToken(url.pathname);
  const payload = await verifySignedToken(token, requireEnv(env, "LINK_SIGNING_SECRET"));
  const rangeHeader = request.headers.get("Range");
  const forceDownload = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

  const botToken = requireEnv(env, "TELEGRAM_BOT_TOKEN");
  const telegramFileUrl = await getTelegramFileUrl({ botToken, fileId: payload.file_id });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader
  });
  const headers = withSecurityHeaders();

  headers.set("Content-Type", payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    forceDownload ? contentDispositionAttachment(payload.name) : contentDispositionInline(payload.name)
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  copyHeader(telegramResponse.headers, headers, "Content-Length");
  copyHeader(telegramResponse.headers, headers, "Content-Range");
  copyHeader(telegramResponse.headers, headers, "Accept-Ranges");

  return new Response(telegramResponse.body, {
    status: telegramResponse.status,
    statusText: telegramResponse.statusText,
    headers
  });
}

async function requireUploadApiKey(request: Request, db: D1Database): Promise<void> {
  const authorization = request.headers.get("Authorization") || "";
  const [scheme, token, extra] = authorization.split(/\s+/);

  if (scheme !== "Bearer" || !token || extra !== undefined) {
    throw new AppError(401, "Unauthorized", "Missing or invalid bearer token");
  }

  const apiKey = await findActiveApiKeyRecord(db, token);

  if (!apiKey) {
    throw new AppError(401, "Unauthorized", "Missing or invalid bearer token");
  }

  await touchApiKeyRecord(db, apiKey.id, new Date().toISOString());
}

async function readLoginCredentials(request: Request): Promise<{ username: string; password: string; rememberMe: boolean }> {
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.toLowerCase().includes("application/json")) {
    const body = await request.json() as Partial<{ username: unknown; password: unknown; remember_me: unknown }>;

    return {
      username: typeof body.username === "string" ? body.username : "",
      password: typeof body.password === "string" ? body.password : "",
      rememberMe: body.remember_me !== false
    };
  }

  if (isFormContentType(contentType)) {
    const formData = await request.formData();
    const username = formData.get("username");
    const password = formData.get("password");
    const rememberMe = formData.get("remember_me");

    return {
      username: typeof username === "string" ? username : "",
      password: typeof password === "string" ? password : "",
      rememberMe: rememberMe !== "0" && rememberMe !== "false"
    };
  }

  throw new AppError(400, "InvalidContentType", "Login request must use JSON or form data");
}

function isFormContentType(contentType: string | null): boolean {
  const normalized = (contentType || "").toLowerCase();

  return normalized.includes("application/x-www-form-urlencoded") || normalized.includes("multipart/form-data");
}

function serializeFileRecord(file: FileRecord, baseUrl: string): Record<string, unknown> {
  const url = `${baseUrl}${file.file_path}`;

  return {
    ...file,
    url,
    download_url: appendDownloadParam(url)
  };
}

function serializeApiKeyRecord(record: ApiKeyRecord, includeKey: boolean): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    masked_key: maskApiKey(record.key),
    ...(includeKey ? { key: record.key } : {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
    last_used_at: record.last_used_at
  };
}

function maskApiKey(key: string): string {
  if (key.length <= 12) {
    return `${key.slice(0, 3)}••••${key.slice(-2)}`;
  }

  return `${key.slice(0, 8)}••••••••${key.slice(-4)}`;
}

function generateApiKey(): string {
  const left = crypto.randomUUID().replace(/-/g, "");
  const right = crypto.randomUUID().replace(/-/g, "");

  return `tgf_${left}${right.slice(0, 16)}`;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError(400, "InvalidContentType", "Request must use application/json");
  }

  const body = await request.json();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(400, "InvalidBody", "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

function normalizeName(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", `${fieldName} is required`);
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 80) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be 1-80 characters`);
  }

  return normalized;
}

function normalizeApiKeyStatus(value: unknown): ApiKeyStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new AppError(400, "InvalidBody", "API key status must be active or disabled");
}

function normalizeRemark(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 1000);
}

function appendDownloadParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function getPublicBaseUrl(request: Request, env: Env): string {
  return normalizeBaseUrl(env.PUBLIC_BASE_URL || new URL(request.url).origin);
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeFileTypeFilter(value: string | null): FileTypeFilter | undefined {
  if (!value || value === "all") {
    return undefined;
  }

  if (
    value === "image" ||
    value === "text" ||
    value === "pdf" ||
    value === "archive" ||
    value === "other"
  ) {
    return value;
  }

  throw new AppError(400, "InvalidQuery", "File type filter is invalid");
}

function normalizeDateTimeParam(value: string | null, fieldName: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "InvalidQuery", `${fieldName} must be a valid date time`);
  }

  return date.toISOString();
}

function maskSecret(value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    return "未配置";
  }

  if (normalized.length <= 8) {
    return "••••";
  }

  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

function parsePositiveInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function extractFileToken(pathname: string): string {
  const match = /^\/f\/([^/]+)(?:\/.*)?$/.exec(pathname);

  if (!match?.[1]) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  return match[1];
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);

  if (value) {
    target.set(name, value);
  }
}
