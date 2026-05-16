import { constantTimeEqual, createSignedToken, TokenError, verifySignedToken } from "./crypto";
import {
  AppError,
  contentDispositionInline,
  errorResponse,
  jsonResponse,
  normalizeBaseUrl,
  parseMaxFileBytes,
  requireEnv,
  sanitizeFileName,
  withSecurityHeaders
} from "./http";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "./telegram";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_STORAGE_CHAT_ID: string;
  UPLOAD_API_KEY: string;
  LINK_SIGNING_SECRET: string;
  PUBLIC_BASE_URL?: string;
  MAX_FILE_BYTES?: string;
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
        file: "GET /f/:token/:filename?"
      }
    });
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

  const botToken = requireEnv(env, "TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv(env, "TELEGRAM_STORAGE_CHAT_ID");
  const signingSecret = requireEnv(env, "LINK_SIGNING_SECRET");
  const fileName = sanitizeFileName(formFile.name);

  const telegramDocument = await uploadDocumentToTelegram({
    botToken,
    chatId,
    file: formFile,
    fileName
  });
  const mimeType = telegramDocument.mime_type || formFile.type || "application/octet-stream";
  const fileSize = telegramDocument.file_size ?? formFile.size;
  const token = await createSignedToken(
    {
      v: 1,
      file_id: telegramDocument.file_id,
      name: telegramDocument.file_name ? sanitizeFileName(telegramDocument.file_name) : fileName,
      mime_type: mimeType,
      size: fileSize,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );

  const baseUrl = normalizeBaseUrl(env.PUBLIC_BASE_URL || new URL(request.url).origin);
  const publicName = encodeURIComponent(telegramDocument.file_name || fileName);
  const fileUrl = `${baseUrl}/f/${token}/${publicName}`;

  return jsonResponse({
    ok: true,
    url: fileUrl,
    name: telegramDocument.file_name || fileName,
    size: fileSize,
    mime_type: mimeType
  });
}

async function handleFileAccess(request: Request, env: Env): Promise<Response> {
  const token = extractFileToken(new URL(request.url).pathname);
  const payload = await verifySignedToken(token, requireEnv(env, "LINK_SIGNING_SECRET"));
  const botToken = requireEnv(env, "TELEGRAM_BOT_TOKEN");
  const telegramFileUrl = await getTelegramFileUrl({ botToken, fileId: payload.file_id });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: request.headers.get("Range")
  });
  const headers = withSecurityHeaders();

  headers.set("Content-Type", payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionInline(payload.name));
  headers.set("Cache-Control", "private, max-age=3600");

  copyHeader(telegramResponse.headers, headers, "Content-Length");
  copyHeader(telegramResponse.headers, headers, "Content-Range");
  copyHeader(telegramResponse.headers, headers, "Accept-Ranges");
  copyHeader(telegramResponse.headers, headers, "ETag");
  copyHeader(telegramResponse.headers, headers, "Last-Modified");

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
