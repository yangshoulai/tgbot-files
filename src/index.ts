import {
  createAdminSessionCookie,
  createExpiredAdminSessionCookie,
  getAdminSession,
  requireAdminSession,
  validateAdminCredentials
} from "./admin-auth";
import { renderAdminPage, renderLoginPage } from "./admin-ui";
import { constantTimeEqual, createSignedToken, TokenError, verifySignedToken } from "./crypto";
import {
  insertFileRecord,
  listFileRecords,
  requireDb,
  softDeleteFileRecord,
  type FileRecord
} from "./database";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  errorResponse,
  htmlResponse,
  jsonResponse,
  normalizeBaseUrl,
  parseMaxFileBytes,
  redirectResponse,
  requireEnv,
  sanitizeFileName,
  withSecurityHeaders
} from "./http";
import { md5Hex } from "./md5";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "./telegram";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_STORAGE_CHAT_ID: string;
  UPLOAD_API_KEY: string;
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

  if (request.method === "GET" && url.pathname === "/login") {
    const username = await getAdminSession(request, env);
    if (username) {
      return redirectResponse("/admin", 302);
    }

    return htmlResponse(renderLoginPage({ hasError: url.searchParams.has("error") }));
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    const username = await getAdminSession(request, env);
    if (!username) {
      return redirectResponse("/login", 302);
    }

    return htmlResponse(renderAdminPage({ maxFileBytes: parseMaxFileBytes(env.MAX_FILE_BYTES), username }));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    return handleAdminLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    return handleAdminLogout(request, env);
  }

  if (url.pathname === "/api/admin/files" || url.pathname.startsWith("/api/admin/files/")) {
    return handleAdminFiles(request, env);
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
  requireBearerAuth(request, requireEnv(env, "UPLOAD_API_KEY"));

  const formFile = await readUploadFile(request, env);
  const result = await uploadAndRecordFile({
    request,
    env,
    file: formFile,
    ...(env.FILES_DB ? { db: env.FILES_DB } : {})
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
    username: credentials.username
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

async function handleAdminFiles(request: Request, env: Env): Promise<Response> {
  const username = await requireAdminSession(request, env);
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/files") {
    const page = parsePositiveInteger(url.searchParams.get("page"), 1, 1, 100000);
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 24, 1, 100);
    const result = await listFileRecords({
      db,
      query: url.searchParams.get("q") || "",
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
    const formFile = await readUploadFile(request, env);
    const result = await uploadAndRecordFile({
      request,
      env,
      file: formFile,
      db,
      uploadedBy: username
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

async function readUploadFile(request: Request, env: Env): Promise<File> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new AppError(400, "InvalidContentType", "Upload request must use multipart/form-data");
  }

  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const formData = await request.formData();
  const formFile = formData.get("file");

  if (!(formFile instanceof File)) {
    throw new AppError(400, "MissingFile", "Multipart field 'file' is required");
  }

  if (formFile.size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (formFile.size > maxFileBytes) {
    throw new AppError(413, "FileTooLarge", `File size must be <= ${maxFileBytes} bytes`, {
      max_file_bytes: maxFileBytes,
      actual_file_bytes: formFile.size
    });
  }

  return formFile;
}

async function uploadAndRecordFile(params: {
  request: Request;
  env: Env;
  file: File;
  db?: D1Database;
  uploadedBy?: string;
}): Promise<UploadResult> {
  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv(params.env, "TELEGRAM_STORAGE_CHAT_ID");
  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const fileName = sanitizeFileName(params.file.name);
  const md5 = md5Hex(await params.file.arrayBuffer());

  const telegramDocument = await uploadDocumentToTelegram({
    botToken,
    chatId,
    file: params.file,
    fileName
  });
  const storedName = telegramDocument.file_name ? sanitizeFileName(telegramDocument.file_name) : fileName;
  const mimeType = telegramDocument.mime_type || params.file.type || "application/octet-stream";
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

function requireBearerAuth(request: Request, expectedApiKey: string): void {
  const authorization = request.headers.get("Authorization") || "";
  const [scheme, token, extra] = authorization.split(/\s+/);

  if (scheme !== "Bearer" || !token || extra !== undefined || !constantTimeEqual(token, expectedApiKey)) {
    throw new AppError(401, "Unauthorized", "Missing or invalid bearer token");
  }
}

async function readLoginCredentials(request: Request): Promise<{ username: string; password: string }> {
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.toLowerCase().includes("application/json")) {
    const body = await request.json() as Partial<{ username: unknown; password: unknown }>;

    return {
      username: typeof body.username === "string" ? body.username : "",
      password: typeof body.password === "string" ? body.password : ""
    };
  }

  if (isFormContentType(contentType)) {
    const formData = await request.formData();
    const username = formData.get("username");
    const password = formData.get("password");

    return {
      username: typeof username === "string" ? username : "",
      password: typeof password === "string" ? password : ""
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

function appendDownloadParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function getPublicBaseUrl(request: Request, env: Env): string {
  return normalizeBaseUrl(env.PUBLIC_BASE_URL || new URL(request.url).origin);
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
