import {
  createAdminSessionCookie,
  createExpiredAdminSessionCookie,
  requireAdminSession,
  requireAdminSessionInfo,
  validateAdminCredentials
} from "./admin-auth";
import { createSignedPayload, createSignedToken, TokenError, verifySignedPayload, verifySignedToken } from "./crypto";
import {
  completeMultipartUploadWithFileRecord,
  deleteStaleMultipartUploadData,
  getDirectoryRecord,
  getDirectoryRecordByPath,
  getDirectoryUsageStats,
  findActiveApiKeyRecord,
  findActiveFileNameConflict,
  getApiKeyRecord,
  getFileChunkRecord,
  getFileRecord,
  getGlobalFileUsageStats,
  getMultipartUploadRecord,
  getTelegramChannelRecord,
  getTelegramChannelUsage,
  insertDirectoryRecord,
  insertApiKeyRecord,
  insertFileRecord,
  insertMultipartUploadRecord,
  insertTelegramChannelRecord,
  listActiveTelegramChannelRecords,
  listAllDirectoryRecords,
  listDirectoryChildren,
  listFileChunkRecords,
  listApiKeyRecords,
  listFileRecords,
  listTelegramChannelRecords,
  moveFileRecords,
  moveDirectoryTree,
  renameDirectoryTree,
  requireDb,
  softDeleteApiKeyRecord,
  deleteDirectoryTree,
  deleteFileRecord,
  touchApiKeyRecord,
  updateApiKeyRecord,
  updateFileRecordMetadata,
  updateTelegramChannelRecord,
  upsertFileChunkRecord,
  deleteTelegramChannelRecord,
  type ApiKeyRecord,
  type ApiKeyStatus,
  type DirectoryRecord,
  type FileChunkRecord,
  type FileRecord,
  type FileTypeFilter,
  type MultipartUploadRecord,
  type TelegramChannelRecord,
  type TelegramChannelStatus,
  type ThumbnailStatus
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
  STALE_MULTIPART_UPLOAD_TTL_HOURS?: string;
  TG_CHANNEL_SECRET?: string;
  TELEGRAM_RATE_LIMITER?: DurableObjectNamespace;
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
  directoryId?: string | null;
  directoryPath: string;
  storageBackend: "telegram_single" | "telegram_multipart";
  telegramChannelId?: string;
  chunkSize?: number | null;
  chunkCount?: number | null;
  thumbnail?: UploadedThumbnailResult;
}

interface MultipartInitResult {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  directoryPath: string;
  thumbnailSource?: ThumbnailSourceInfo;
}

interface ThumbnailSourceInfo {
  available: boolean;
  kind: "image" | "video";
  url: string;
  mimeType: string;
  expiresAt: string;
}

interface ThumbnailInput {
  file: File;
  width?: number;
  height?: number;
}

interface UploadedThumbnailResult {
  status: ThumbnailStatus;
  fileId?: string;
  fileUniqueId?: string;
  telegramChannelId?: string;
  filePath?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
}

interface ThumbnailSourceTokenPayload {
  purpose: "thumbnail_source";
  url: string;
  mime_type: string;
  kind: "image" | "video";
  size: number;
  exp: number;
}

interface ParsedByteRange {
  start: number;
  end: number;
  partial: boolean;
}

const TELEGRAM_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
const DIRECT_MULTIPART_ACCESS_MAX_CHUNKS = 20;
const DIRECT_MULTIPART_ACCESS_MAX_BYTES = TELEGRAM_CHUNK_SIZE_BYTES * DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
const MAX_TELEGRAM_MULTIPART_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TELEGRAM_MULTIPART_CHUNKS = Math.ceil(MAX_TELEGRAM_MULTIPART_BYTES / TELEGRAM_CHUNK_SIZE_BYTES);
const TELEGRAM_RATE_LIMITER_OBJECT_NAME = "telegram-api-global";
// Token bucket for sendDocument: capacity 1, refill every 1s. The upload lock below
// still ensures only one Telegram file upload is in flight at a time.
const TELEGRAM_SEND_DOCUMENT_RATE_LIMIT_MS = 1_000;
const TELEGRAM_SEND_DOCUMENT_LOCK_LEASE_MS = 2 * 60 * 1000;
const TELEGRAM_GET_FILE_RATE_LIMIT_MS = 100;
const DEFAULT_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24;
const MIN_STALE_MULTIPART_UPLOAD_TTL_HOURS = 1;
const MAX_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24 * 30;
const MAX_THUMBNAIL_BYTES = 512 * 1024;
const THUMBNAIL_SOURCE_TOKEN_TTL_SECONDS = 10 * 60;
const IMAGE_THUMBNAIL_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_THUMBNAIL_SOURCE_MAX_BYTES = MAX_TELEGRAM_MULTIPART_BYTES;
const VIDEO_THUMBNAIL_PROXY_DEFAULT_RANGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_THUMBNAIL_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type TelegramRateLimitScope = "sendDocument" | "getFile";

interface TelegramApiSlot {
  scope: TelegramRateLimitScope;
  token?: string;
  channelId?: string;
}

interface TelegramStorageChannel {
  id: string;
  name: string;
  botToken: string;
  chatId: string;
  status: TelegramChannelStatus;
  isDefault: boolean;
}

interface TelegramUploadSlot extends TelegramApiSlot {
  scope: "sendDocument";
  token: string;
  channelId: string;
  botToken: string;
  chatId: string;
}

interface TelegramChannelFormInput {
  name: string;
  botToken?: string;
  chatId: string;
  status: TelegramChannelStatus;
}

export class TelegramRateLimiter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method !== "POST" ||
      (url.pathname !== "/acquire" && url.pathname !== "/release" && url.pathname !== "/penalize")
    ) {
      return new Response("Not found", { status: 404 });
    }

    const body = await readRateLimitRequestBody(request);
    const scope = normalizeTelegramRateLimitScope(body.scope);

    if (!scope) {
      return new Response(JSON.stringify({ ok: false, error: "InvalidScope" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    if (url.pathname === "/penalize") {
      const retryAfterMs = normalizeRetryAfterMs(body.retry_after_ms);
      const channelId = normalizeTelegramRateLimitChannelId(body.channel_id);
      await this.enqueue(() => this.penalize(scope, channelId, retryAfterMs));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    if (url.pathname === "/release") {
      const token = typeof body.token === "string" ? body.token : "";
      const channelId = normalizeTelegramRateLimitChannelId(body.channel_id);
      await this.enqueue(() => this.release(scope, channelId, token));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const channelIds = normalizeTelegramRateLimitChannelIds(body.channel_ids, body.channel_id);
    const preferredChannelId = normalizeOptionalTelegramRateLimitChannelId(body.preferred_channel_id);
    const result = scope === "sendDocument"
      ? await this.acquireSendDocument(channelIds, preferredChannelId)
      : await this.enqueue(() => this.reserve(scope, channelIds[0] ?? "default"));

    if (!result.token && result.waitMs > 0) {
      await delayMs(result.waitMs);
    }

    return new Response(JSON.stringify({
      ok: true,
      wait_ms: result.waitMs,
      token: result.token,
      channel_id: result.channelId
    }), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async acquireSendDocument(
    channelIds: string[],
    preferredChannelId?: string
  ): Promise<{ waitMs: number; token: string; channelId: string }> {
    let totalWaitMs = 0;

    while (true) {
      const result = await this.enqueue(() => this.tryAcquireSendDocument(channelIds, preferredChannelId));
      if (result.token && result.channelId) {
        return { waitMs: totalWaitMs, token: result.token, channelId: result.channelId };
      }

      totalWaitMs += result.waitMs;
      await delayMs(result.waitMs);
    }
  }

  private async tryAcquireSendDocument(
    channelIds: string[],
    preferredChannelId?: string
  ): Promise<{ waitMs: number; token?: string; channelId?: string }> {
    const now = Date.now();
    const states = await Promise.all(channelIds.map(async (channelId, index) => {
      const nextAvailableAt = await this.state.storage.get<number>(telegramRateLimitStorageKey("sendDocument", channelId)) ?? 0;
      const lockToken = await this.state.storage.get<string>(telegramRateLimitLockTokenKey("sendDocument", channelId));
      const lockedUntil = await this.state.storage.get<number>(telegramRateLimitLockUntilKey("sendDocument", channelId)) ?? 0;

      if (lockToken && lockedUntil <= now) {
        await this.clearLock("sendDocument", channelId);
      }

      const activeLockedUntil = lockToken && lockedUntil > now ? lockedUntil : 0;
      return {
        channelId,
        index,
        readyAt: Math.max(nextAvailableAt, activeLockedUntil)
      };
    }));

    states.sort((left, right) => {
      const readyDiff = left.readyAt - right.readyAt;
      if (readyDiff !== 0) return readyDiff;
      if (preferredChannelId) {
        if (left.channelId === preferredChannelId) return -1;
        if (right.channelId === preferredChannelId) return 1;
      }
      return left.index - right.index;
    });

    const selected = states[0];
    if (!selected) {
      return { waitMs: TELEGRAM_SEND_DOCUMENT_RATE_LIMIT_MS };
    }

    if (selected.readyAt > now) {
      return { waitMs: Math.max(250, Math.min(1_000, selected.readyAt - now)) };
    }

    const token = crypto.randomUUID();
    await this.state.storage.put(telegramRateLimitLockTokenKey("sendDocument", selected.channelId), token);
    await this.state.storage.put(
      telegramRateLimitLockUntilKey("sendDocument", selected.channelId),
      now + TELEGRAM_SEND_DOCUMENT_LOCK_LEASE_MS
    );
    await this.state.storage.put(
      telegramRateLimitStorageKey("sendDocument", selected.channelId),
      now + telegramRateLimitIntervalMs("sendDocument")
    );

    return { waitMs: 0, token, channelId: selected.channelId };
  }

  private async reserve(scope: TelegramRateLimitScope, channelId: string): Promise<{ waitMs: number; token?: string; channelId: string }> {
    const now = Date.now();
    const key = telegramRateLimitStorageKey(scope, channelId);
    const nextAvailableAt = await this.state.storage.get<number>(key) ?? 0;
    const waitMs = Math.max(0, nextAvailableAt - now);
    const reservedAt = now + waitMs;

    await this.state.storage.put(key, reservedAt + telegramRateLimitIntervalMs(scope));
    return { waitMs, channelId };
  }

  private async penalize(scope: TelegramRateLimitScope, channelId: string, retryAfterMs: number): Promise<void> {
    const key = telegramRateLimitStorageKey(scope, channelId);
    const current = await this.state.storage.get<number>(key) ?? 0;
    const penalizedUntil = Date.now() + retryAfterMs;

    await this.state.storage.put(key, Math.max(current, penalizedUntil));
  }

  private async release(scope: TelegramRateLimitScope, channelId: string, token: string): Promise<void> {
    if (scope !== "sendDocument" || !token) {
      return;
    }

    const currentToken = await this.state.storage.get<string>(telegramRateLimitLockTokenKey(scope, channelId));
    if (currentToken !== token) {
      return;
    }

    await this.clearLock(scope, channelId);
  }

  private async clearLock(scope: TelegramRateLimitScope, channelId: string): Promise<void> {
    await this.state.storage.delete(telegramRateLimitLockTokenKey(scope, channelId));
    await this.state.storage.delete(telegramRateLimitLockUntilKey(scope, channelId));
  }
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
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledCleanup(controller, env));
  }
};

export default worker;

async function runScheduledCleanup(controller: ScheduledController, env: Env): Promise<void> {
  const scheduledTime = Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : Date.now();
  const result = await cleanupStaleMultipartUploads(env, scheduledTime);

  if (result.deletedUploads > 0 || result.deletedChunks > 0) {
    console.log("Stale multipart upload cleanup completed", {
      cron: controller.cron,
      expired_before: result.expiredBefore,
      deleted_uploads: result.deletedUploads,
      deleted_chunks: result.deletedChunks
    });
  }
}

async function cleanupStaleMultipartUploads(
  env: Env,
  nowMs: number
): Promise<{ expiredBefore: string; deletedUploads: number; deletedChunks: number }> {
  const db = requireDb(env);
  const ttlMs = parseStaleMultipartUploadTtlMs(env.STALE_MULTIPART_UPLOAD_TTL_HOURS);
  const expiredBefore = new Date(nowMs - ttlMs).toISOString();
  const result = await deleteStaleMultipartUploadData(db, expiredBefore);

  return {
    expiredBefore,
    ...result
  };
}

function parseStaleMultipartUploadTtlMs(value: string | undefined): number {
  const parsed = Number(value?.trim());
  const hours = Number.isFinite(parsed)
    ? Math.floor(parsed)
    : DEFAULT_STALE_MULTIPART_UPLOAD_TTL_HOURS;
  const boundedHours = Math.min(
    MAX_STALE_MULTIPART_UPLOAD_TTL_HOURS,
    Math.max(MIN_STALE_MULTIPART_UPLOAD_TTL_HOURS, hours)
  );

  return boundedHours * 60 * 60 * 1000;
}

async function readRateLimitRequestBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeTelegramRateLimitScope(value: unknown): TelegramRateLimitScope | undefined {
  return value === "sendDocument" || value === "getFile" ? value : undefined;
}

function normalizeRetryAfterMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return TELEGRAM_SEND_DOCUMENT_RATE_LIMIT_MS;
  }

  return Math.min(parsed, 5 * 60 * 1000);
}

function normalizeTelegramRateLimitChannelId(value: unknown): string {
  return normalizeOptionalTelegramRateLimitChannelId(value) ?? "default";
}

function normalizeOptionalTelegramRateLimitChannelId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTelegramRateLimitChannelIds(value: unknown, fallback: unknown): string[] {
  const values = Array.isArray(value) ? value : [fallback];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of values) {
    const channelId = normalizeOptionalTelegramRateLimitChannelId(item);
    if (channelId && !seen.has(channelId)) {
      seen.add(channelId);
      result.push(channelId);
    }
  }

  return result.length > 0 ? result : ["default"];
}

function telegramRateLimitStorageKey(scope: TelegramRateLimitScope, channelId = "default"): string {
  return `telegram-rate-limit:${scope}:${channelId}:next`;
}

function telegramRateLimitLockTokenKey(scope: TelegramRateLimitScope, channelId = "default"): string {
  return `telegram-rate-limit:${scope}:${channelId}:lock-token`;
}

function telegramRateLimitLockUntilKey(scope: TelegramRateLimitScope, channelId = "default"): string {
  return `telegram-rate-limit:${scope}:${channelId}:locked-until`;
}

function telegramRateLimitIntervalMs(scope: TelegramRateLimitScope): number {
  return scope === "sendDocument" ? TELEGRAM_SEND_DOCUMENT_RATE_LIMIT_MS : TELEGRAM_GET_FILE_RATE_LIMIT_MS;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  if (url.pathname === "/api/admin/uploads" || url.pathname.startsWith("/api/admin/uploads/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminMultipartUploads(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/directories" || url.pathname.startsWith("/api/admin/directories/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminDirectories(request, env));
  }

  if (url.pathname === "/api/admin/entries" || url.pathname.startsWith("/api/admin/entries/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminEntries(request, env));
  }

  if (url.pathname === "/api/admin/files" || url.pathname.startsWith("/api/admin/files/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminFiles(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/telegram-channels" || url.pathname.startsWith("/api/admin/telegram-channels/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminTelegramChannels(request, env));
  }

  if (url.pathname === "/api/admin/api-keys" || url.pathname.startsWith("/api/admin/api-keys/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminApiKeys(request, env));
  }

  if (url.pathname === "/api/v1/files" || url.pathname.startsWith("/api/v1/files/")) {
    return handleApiFiles(request, env);
  }

  if (url.pathname === "/api/v1/uploads" || url.pathname.startsWith("/api/v1/uploads/")) {
    return handleApiMultipartUploads(request, env);
  }

  if (request.method === "GET" && url.pathname.startsWith("/f/")) {
    return handleFileAccess(request, env);
  }

  return errorResponse(new AppError(404, "NotFound", "Route not found"));
}

async function handleApiFiles(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  await requireUploadApiKey(request, db);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/v1/files") {
    const { file, directoryPath } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    await requireFileNameAvailable({
      db,
      directoryPath,
      fileName: sanitizeFileName(file.name)
    });
    const result = await uploadAndRecordFile({
      request,
      env,
      file,
      db,
      directoryPath,
      directoryId: directory?.id ?? null
    });

    return jsonResponse({
      ok: true,
      id: result.id,
      url: result.publicUrl,
      name: result.name,
      size: result.size,
      mime_type: result.mimeType
    });
  }

  const chunkMatch = /^\/api\/v1\/files\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const file = await requireFileRecord(db, decodeURIComponent(chunkMatch[1]));
    const chunkIndex = Number(chunkMatch[2]);

    return handleMultipartChunkRecordAccess({
      env,
      file,
      chunkIndex
    });
  }

  const fileMatch = /^\/api\/v1\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && fileMatch?.[1]) {
    const file = await requireFileRecord(db, decodeURIComponent(fileMatch[1]));

    return jsonResponse({
      ok: true,
      file: serializeFileRecord(file, getPublicBaseUrl(request, env))
    });
  }

  return errorResponse(new AppError(404, "NotFound", "API file route not found"));
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
    multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    base_url: baseUrl,
    config: {
      files_db: Boolean(env.FILES_DB),
      telegram_bot_token: hasEnvValue(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: hasEnvValue(env.TELEGRAM_STORAGE_CHAT_ID),
      telegram_channels: Boolean(env.FILES_DB),
      tg_channel_secret: hasEnvValue(env.TG_CHANNEL_SECRET || env.LINK_SIGNING_SECRET),
      link_signing_secret: hasEnvValue(env.LINK_SIGNING_SECRET),
      admin_username: hasEnvValue(env.ADMIN_USERNAME),
      admin_password: hasEnvValue(env.ADMIN_PASSWORD),
      admin_session_secret: hasEnvValue(env.ADMIN_SESSION_SECRET)
    },
    config_values: {
      files_db: env.FILES_DB ? "已绑定" : "未绑定",
      telegram_bot_token: maskSecret(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: env.TELEGRAM_STORAGE_CHAT_ID?.trim() || "未配置",
      telegram_channels: env.FILES_DB ? "设置页可配置" : "需要 D1 数据库",
      tg_channel_secret: env.TG_CHANNEL_SECRET?.trim() ? maskSecret(env.TG_CHANNEL_SECRET) : "未单独配置，使用签名密钥",
      link_signing_secret: maskSecret(env.LINK_SIGNING_SECRET),
      admin_username: env.ADMIN_USERNAME?.trim() || "未配置",
      admin_password: maskSecret(env.ADMIN_PASSWORD),
      admin_session_secret: env.ADMIN_SESSION_SECRET?.trim()
        ? maskSecret(env.ADMIN_SESSION_SECRET)
        : "未单独配置，使用签名密钥",
      public_base_url: baseUrl,
      max_file_bytes: String(maxFileBytes),
      max_multipart_file_bytes: String(MAX_TELEGRAM_MULTIPART_BYTES),
      direct_access_max_bytes: String(DIRECT_MULTIPART_ACCESS_MAX_BYTES)
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
    const directoryPath = normalizeDirectoryPath(url.searchParams.get("dir") || "/");
    const currentDirectory = await requireReadableDirectory(db, directoryPath);
    const normalizedQuery = url.searchParams.get("q") || "";
    const result = await listFileRecords({
      db,
      query: normalizedQuery,
      directoryPath,
      ...(type ? { type } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
      page,
      limit
    });
    const [directories, globalStats] = await Promise.all([
      listDirectoryChildren(db, directoryPath),
      getGlobalFileUsageStats(db)
    ]);
    const directoryStats = await getDirectoryUsageStats(db, directories);
    const baseUrl = getPublicBaseUrl(request, env);
    const files = result.files.map((file) => serializeFileRecord(file, baseUrl));

    return jsonResponse({
      ok: true,
      current_directory: serializeCurrentDirectory(currentDirectory, directoryPath),
      directories: directories.map((directory) => serializeDirectoryRecord(directory, directoryStats.get(directory.path))),
      search_scope: "current",
      files,
      pagination: {
        page,
        limit,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / limit))
      },
      global_stats: globalStats,
      max_file_bytes: parseMaxFileBytes(env.MAX_FILE_BYTES),
      multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
      max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
      direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
      direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/files") {
    const { file: formFile, remark, directoryPath } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    await requireFileNameAvailable({
      db,
      directoryPath,
      fileName: sanitizeFileName(formFile.name)
    });
    const result = await uploadAndRecordFile({
      request,
      env,
      file: formFile,
      db,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  if (request.method === "PATCH" && url.pathname === "/api/admin/files/move") {
    const body = await readJsonObject(request);
    const fileIds = normalizeFileIdList(body.file_ids);
    const directoryPath = await resolveMoveTargetDirectory(db, body);
    const files = await requireFileRecords(db, fileIds);
    await requireFileMoveNamesAvailable({
      db,
      files,
      directoryPath
    });
    const moved = await moveFileRecords({
      db,
      ids: fileIds,
      directoryPath
    });

    return jsonResponse({ ok: true, moved, directory_path: directoryPath });
  }

  const updateMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PATCH" && updateMatch?.[1]) {
    const id = decodeURIComponent(updateMatch[1]);
    const existing = await getFileRecord(db, id);

    if (!existing) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    const body = await readJsonObject(request);
    const hasFileName = Object.prototype.hasOwnProperty.call(body, "file_name");
    const hasRemark = Object.prototype.hasOwnProperty.call(body, "remark");

    if (!hasFileName && !hasRemark) {
      throw new AppError(400, "InvalidBody", "file_name or remark is required");
    }

    const nextFileName = hasFileName ? normalizeFileNameUpdate(body.file_name) : existing.file_name;
    const nextRemark = hasRemark ? normalizeRemarkUpdate(body.remark) : existing.remark;
    if (nextFileName !== existing.file_name) {
      await requireFileNameAvailable({
        db,
        directoryPath: existing.directory_path ?? "/",
        fileName: nextFileName,
        excludeId: existing.id
      });
    }
    const nextFilePath = nextFileName === existing.file_name
      ? existing.file_path
      : await createFilePathForRecord(existing, nextFileName, env);
    const updated = await updateFileRecordMetadata({
      db,
      id,
      fileName: nextFileName,
      remark: nextRemark,
      filePath: nextFilePath
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({
      ok: true,
      file: serializeFileRecord(updated, getPublicBaseUrl(request, env))
    });
  }

  const deleteMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const deleted = await deleteFileRecord(db, decodeURIComponent(deleteMatch[1]));

    if (!deleted) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin file route not found"));
}

async function handleAdminDirectories(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/directories") {
    const flat = url.searchParams.get("flat") === "1" || url.searchParams.get("flat") === "true";
    const parentPath = normalizeDirectoryPath(url.searchParams.get("parent_path") || "/");
    if (!flat) {
      await requireReadableDirectory(db, parentPath);
    }
    const directories = flat
      ? await listAllDirectoryRecords(db)
      : await listDirectoryChildren(db, parentPath);

    return jsonResponse({
      ok: true,
      directories: directories.map((directory) => serializeDirectoryRecord(directory))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/directories") {
    const body = await readJsonObject(request);
    const parentPath = normalizeDirectoryPath(body.parent_path ?? "/");
    const name = normalizeDirectoryName(body.name);
    const record = await insertDirectoryRecord({
      db,
      parentPath,
      name,
      createdAt: new Date().toISOString()
    });

    return jsonResponse({ ok: true, directory: serializeDirectoryRecord(record) }, 201);
  }

  const match = /^\/api\/admin\/directories\/([^/]+)$/.exec(url.pathname);
  const moveMatch = /^\/api\/admin\/directories\/([^/]+)\/move$/.exec(url.pathname);
  if (request.method === "PATCH" && moveMatch?.[1]) {
    const body = await readJsonObject(request);
    const parentPath = normalizeDirectoryPath(body.parent_path ?? "/");
    const result = await moveDirectoryTree({
      db,
      id: decodeURIComponent(moveMatch[1]),
      parentPath
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      directory: serializeDirectoryRecord(result.directory),
      moved_directories: result.movedDirectories,
      moved_files: result.movedFiles
    });
  }

  if (request.method === "PATCH" && match?.[1]) {
    const body = await readJsonObject(request);
    const name = normalizeDirectoryName(body.name);
    const result = await renameDirectoryTree({
      db,
      id: decodeURIComponent(match[1]),
      name
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      directory: serializeDirectoryRecord(result.directory),
      renamed_directories: result.renamedDirectories,
      updated_files: result.updatedFiles
    });
  }

  if (request.method === "DELETE" && match?.[1]) {
    const result = await deleteDirectoryTree({
      db,
      id: decodeURIComponent(match[1])
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      deleted_directories: result.deletedDirectories,
      deleted_files: result.deletedFiles,
      directory: serializeDirectoryRecord(result.directory)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin directory route not found"));
}

async function handleAdminEntries(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "PATCH" && url.pathname === "/api/admin/entries/move") {
    const body = await readJsonObject(request);
    const fileIds = normalizeOptionalIdList(body.file_ids, "file_ids");
    const directoryIds = normalizeOptionalIdList(body.directory_ids, "directory_ids");
    requireEntrySelection(fileIds, directoryIds);

    const directoriesToMove = await requireDirectoryRecords(db, directoryIds);
    const filesToMove = await requireFileRecords(db, fileIds);
    validateEntryMoveParent(directoriesToMove, moveTargetParentPath(body));
    const directoryPath = await resolveMoveTargetDirectory(db, body);
    await validateEntryMoveTarget(db, directoriesToMove, directoryPath);
    await requireFileMoveNamesAvailable({
      db,
      files: filesToMove,
      directoryPath
    });

    let movedDirectories = 0;
    let movedFiles = 0;

    for (const directory of directoriesToMove) {
      const result = await moveDirectoryTree({
        db,
        id: directory.id,
        parentPath: directoryPath
      });

      if (!result) {
        throw new AppError(404, "DirectoryNotFound", "Directory not found");
      }

      movedDirectories += result.movedDirectories;
      movedFiles += result.movedFiles;
    }

    movedFiles += await moveFileRecords({
      db,
      ids: fileIds,
      directoryPath
    });

    return jsonResponse({
      ok: true,
      moved: movedDirectories + movedFiles,
      moved_directories: movedDirectories,
      moved_files: movedFiles,
      directory_path: directoryPath
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/entries/delete") {
    const body = await readJsonObject(request);
    const fileIds = normalizeOptionalIdList(body.file_ids, "file_ids");
    const directoryIds = normalizeOptionalIdList(body.directory_ids, "directory_ids");
    requireEntrySelection(fileIds, directoryIds);
    await requireFileRecords(db, fileIds);
    await requireDirectoryRecords(db, directoryIds);

    let deletedDirectories = 0;
    let deletedFiles = 0;

    for (const fileId of fileIds) {
      const deleted = await deleteFileRecord(db, fileId);
      if (!deleted) {
        throw new AppError(404, "NotFound", "File record not found");
      }
      deletedFiles += 1;
    }

    for (const directoryId of directoryIds) {
      const result = await deleteDirectoryTree({
        db,
        id: directoryId
      });

      if (!result) {
        throw new AppError(404, "DirectoryNotFound", "Directory not found");
      }

      deletedDirectories += result.deletedDirectories;
      deletedFiles += result.deletedFiles;
    }

    return jsonResponse({
      ok: true,
      deleted_directories: deletedDirectories,
      deleted_files: deletedFiles
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin entry route not found"));
}

async function handleAdminMultipartUploads(request: Request, env: Env, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/init") {
    const body = await readJsonObject(request);
    const fileName = sanitizeFileName(stringField(body.file_name, "file_name"));
    const mimeType = normalizeMimeTypeField(body.mime_type);
    const size = positiveIntegerField(body.size, "size");
    const remark = normalizeRemark(body.remark);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createMultipartUpload({
      db,
      sourceKind: "local",
      fileName,
      mimeType,
      size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      upload: serializeMultipartInit(result)
    }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/url/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const remark = normalizeRemark(body.remark);
    const fileNameOverride = normalizeOptionalFileName(body.file_name);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES), {
      forceMultipart: true
    });

    if (probe.mode === "single") {
      throw new AppError(500, "InternalError", "Forced URL multipart probe returned single mode");
    }

    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      fileName: fileNameOverride ?? probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });
    const thumbnailSource = await createThumbnailSourceInfo({
      request,
      env,
      sourceUrl,
      mimeType: probe.mimeType,
      size: probe.size
    });
    if (thumbnailSource) {
      result.thumbnailSource = thumbnailSource;
    }

    return jsonResponse({
      ok: true,
      mode: "multipart",
      upload: serializeMultipartInit(result)
    }, 201);
  }

  const statusMatch = /^\/api\/admin\/uploads\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(statusMatch[1]));
    const chunks = await listFileChunkRecords(db, upload.id);

    return jsonResponse({
      ok: true,
      upload: serializeMultipartUploadStatus(upload),
      uploaded_chunks: chunks.map((chunk) => chunk.chunk_index),
      missing_chunks: missingChunkIndexes(upload, chunks)
    });
  }

  const chunkMatch = /^\/api\/admin\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(chunkMatch[1]), "local");
    const chunkIndex = normalizeChunkIndex(chunkMatch[2], upload);
    const formData = await request.formData();
    const chunk = formData.get("chunk");

    if (!(chunk instanceof File)) {
      throw new AppError(400, "MissingChunk", "Multipart field 'chunk' is required");
    }

    const expectedSize = expectedChunkSize(upload, chunkIndex);
    validateChunkFile(chunk, expectedSize);
    const record = await uploadChunkToTelegram({
      env,
      db,
      upload,
      chunk,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const urlChunkMatch = /^\/api\/admin\/uploads\/([^/]+)\/url-chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && urlChunkMatch?.[1] && urlChunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(urlChunkMatch[1]), "url");
    const chunkIndex = normalizeChunkIndex(urlChunkMatch[2], upload);
    const record = await downloadAndUploadRemoteChunk({
      env,
      db,
      upload,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(completeMatch[1]));
    const thumbnail = await readCompleteUploadThumbnail(request);
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload,
      ...(thumbnail ? { thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/uploads/url-thumbnail-source") {
    return handleThumbnailSourceProxy(request, env);
  }

  return errorResponse(new AppError(404, "NotFound", "Admin multipart upload route not found"));
}

async function handleApiMultipartUploads(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/v1/uploads/url-thumbnail-source") {
    return handleThumbnailSourceProxy(request, env);
  }

  const db = requireDb(env);
  await requireUploadApiKey(request, db);

  if (request.method === "POST" && url.pathname === "/api/v1/uploads/init") {
    const body = await readJsonObject(request);
    const fileName = sanitizeFileName(stringField(body.file_name, "file_name"));
    const mimeType = normalizeMimeTypeField(body.mime_type);
    const size = positiveIntegerField(body.size, "size");
    const remark = normalizeRemark(body.remark);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createMultipartUpload({
      db,
      sourceKind: "local",
      fileName,
      mimeType,
      size,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      upload: serializeMultipartInit(result)
    }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/uploads/url/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const remark = normalizeRemark(body.remark);
    const fileNameOverride = normalizeOptionalFileName(body.file_name);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES), {
      forceMultipart: true
    });

    if (probe.mode === "single") {
      throw new AppError(500, "InternalError", "Forced URL multipart probe returned single mode");
    }

    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      fileName: fileNameOverride ?? probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });
    const thumbnailSource = await createThumbnailSourceInfo({
      request,
      env,
      sourceUrl,
      mimeType: probe.mimeType,
      size: probe.size
    });
    if (thumbnailSource) {
      result.thumbnailSource = thumbnailSource;
    }

    return jsonResponse({
      ok: true,
      mode: "multipart",
      upload: serializeMultipartInit(result)
    }, 201);
  }

  const chunkMatch = /^\/api\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(chunkMatch[1]), "local");
    const chunkIndex = normalizeChunkIndex(chunkMatch[2], upload);
    const formData = await request.formData();
    const chunk = formData.get("chunk");

    if (!(chunk instanceof File)) {
      throw new AppError(400, "MissingChunk", "Multipart field 'chunk' is required");
    }

    validateChunkFile(chunk, expectedChunkSize(upload, chunkIndex));
    const record = await uploadChunkToTelegram({
      env,
      db,
      upload,
      chunk,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const urlChunkMatch = /^\/api\/v1\/uploads\/([^/]+)\/url-chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && urlChunkMatch?.[1] && urlChunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(urlChunkMatch[1]), "url");
    const chunkIndex = normalizeChunkIndex(urlChunkMatch[2], upload);
    const record = await downloadAndUploadRemoteChunk({
      env,
      db,
      upload,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const completeMatch = /^\/api\/v1\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(completeMatch[1]));
    const thumbnail = await readCompleteUploadThumbnail(request);
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload,
      ...(thumbnail ? { thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, null)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "API multipart upload route not found"));
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

async function handleAdminTelegramChannels(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/telegram-channels") {
    const records = await listTelegramChannelRecords(db);
    return jsonResponse({
      ok: true,
      channels: await Promise.all(records.map((record) => serializeTelegramChannelRecord(record, env)))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/telegram-channels") {
    const body = await readJsonObject(request);
    const input = normalizeTelegramChannelForm(body, { creating: true });
    const now = new Date().toISOString();
    const botToken = input.botToken ?? "";
    const botTokenHash = await telegramChannelTokenHash(botToken);

    await requireTelegramChannelUnique(db, {
      name: input.name,
      botTokenHash,
      chatId: input.chatId
    });

    await insertTelegramChannelRecord(db, {
      id: crypto.randomUUID(),
      name: input.name,
      botTokenEncrypted: await encryptTelegramBotToken(botToken, env),
      botTokenHash,
      chatId: input.chatId,
      status: input.status,
      createdAt: now,
      updatedAt: now
    });

    const records = await listTelegramChannelRecords(db);
    const created = records.find((record) => record.name === input.name && record.chat_id === input.chatId);

    return jsonResponse({
      ok: true,
      channel: created ? await serializeTelegramChannelRecord(created, env) : null
    }, 201);
  }

  const match = /^\/api\/admin\/telegram-channels\/([^/]+)$/.exec(url.pathname);
  const id = match?.[1] ? decodeURIComponent(match[1]) : "";

  if (!id) {
    return errorResponse(new AppError(404, "NotFound", "Admin Telegram channel route not found"));
  }

  const existing = await getTelegramChannelRecord(db, id);
  if (!existing) {
    throw new AppError(404, "NotFound", "Telegram channel not found");
  }

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const input = normalizeTelegramChannelForm(body, { creating: false, existing });
    const nextBotTokenEncrypted = input.botToken
      ? await encryptTelegramBotToken(input.botToken, env)
      : existing.bot_token_encrypted;
    const nextBotTokenHash = input.botToken
      ? await telegramChannelTokenHash(input.botToken)
      : existing.bot_token_hash;

    if (!nextBotTokenEncrypted || !nextBotTokenHash) {
      throw new AppError(400, "InvalidBody", "bot_token is required before this Telegram channel can be saved");
    }

    await requireTelegramChannelUnique(db, {
      name: input.name,
      botTokenHash: nextBotTokenHash,
      chatId: input.chatId,
      excludeId: id
    });

    const updated = await updateTelegramChannelRecord(db, {
      id,
      name: existing.is_default === 1 ? "default" : input.name,
      botTokenEncrypted: nextBotTokenEncrypted,
      botTokenHash: nextBotTokenHash,
      chatId: input.chatId,
      status: input.status,
      updatedAt: new Date().toISOString()
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "Telegram channel not found");
    }

    return jsonResponse({ ok: true, channel: await serializeTelegramChannelRecord(updated, env) });
  }

  if (request.method === "DELETE") {
    if (existing.is_default === 1 || existing.id === "default") {
      throw new AppError(400, "DefaultChannelProtected", "default Telegram channel cannot be deleted");
    }

    const usage = await getTelegramChannelUsage(db, id);
    if (usage.files > 0 || usage.chunks > 0) {
      throw new AppError(409, "TelegramChannelInUse", "Telegram channel is still referenced by files or chunks", {
        files: usage.files,
        chunks: usage.chunks
      });
    }

    const deleted = await deleteTelegramChannelRecord(db, id);
    if (!deleted) {
      throw new AppError(404, "NotFound", "Telegram channel not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(405, "MethodNotAllowed", "Unsupported Telegram channel method"));
}

function normalizeTelegramChannelForm(
  body: Record<string, unknown>,
  options: { creating: boolean; existing?: TelegramChannelRecord }
): TelegramChannelFormInput {
  const existing = options.existing;
  const name = existing?.is_default === 1
    ? "default"
    : normalizeName(body.name ?? existing?.name, "Telegram channel name");
  const botTokenValue = body.bot_token === undefined ? undefined : body.bot_token;
  const botToken = normalizeTelegramBotToken(botTokenValue, options.creating);
  const chatId = normalizeTelegramChatId(body.chat_id ?? existing?.chat_id);
  const status = body.status === undefined
    ? existing?.status ?? "active"
    : normalizeTelegramChannelStatus(body.status);

  return {
    name,
    ...(botToken ? { botToken } : {}),
    chatId,
    status
  };
}

function normalizeTelegramBotToken(value: unknown, required: boolean): string | undefined {
  if (typeof value !== "string") {
    if (required) {
      throw new AppError(400, "InvalidBody", "bot_token is required");
    }
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    if (required) {
      throw new AppError(400, "InvalidBody", "bot_token is required");
    }
    return undefined;
  }

  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(normalized)) {
    throw new AppError(400, "InvalidBody", "bot_token format is invalid");
  }

  return normalized;
}

function normalizeTelegramChatId(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "chat_id is required");
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new AppError(400, "InvalidBody", "chat_id is required");
  }

  return normalized.slice(0, 128);
}

function normalizeTelegramChannelStatus(value: unknown): TelegramChannelStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new AppError(400, "InvalidBody", "Telegram channel status must be active or disabled");
}

async function requireTelegramChannelUnique(paramsDb: D1Database, params: {
  name: string;
  botTokenHash: string;
  chatId: string;
  excludeId?: string;
}): Promise<void> {
  const records = await listTelegramChannelRecords(paramsDb);
  const conflict = records.find((record) =>
    record.id !== params.excludeId &&
    (record.name === params.name || (record.bot_token_hash === params.botTokenHash && record.chat_id === params.chatId))
  );

  if (!conflict) {
    return;
  }

  if (conflict.name === params.name) {
    throw new AppError(409, "TelegramChannelNameConflict", "Telegram channel name already exists");
  }

  throw new AppError(409, "TelegramChannelTargetConflict", "Telegram bot token and chat_id channel already exists");
}

async function readUploadInput(request: Request, env: Env): Promise<{ file: File; remark?: string; directoryPath: string }> {
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
  const fileNameOverride = normalizeOptionalFileName(formData.get("file_name"));
  const remark = normalizeRemark(formData.get("remark"));
  const directoryPath = normalizeDirectoryPath(formData.get("directory_path") ?? formData.get("dir") ?? "/");

  if (formFile instanceof File) {
    validateUploadFileSize(formFile, maxFileBytes);
    const file = fileNameOverride ? renameUploadFile(formFile, fileNameOverride) : formFile;

    return {
      file,
      directoryPath,
      ...(remark ? { remark } : {})
    };
  }

  const sourceUrl = normalizeSourceUrl(formData.get("url"));
  if (sourceUrl) {
    const file = await downloadFileFromUrl({
      sourceUrl,
      env,
      maxFileBytes,
      ...(fileNameOverride ? { fileName: fileNameOverride } : {})
    });

    return {
      file,
      directoryPath,
      ...(remark ? { remark } : {})
    };
  }

  throw new AppError(400, "MissingFile", "Multipart field 'file' is required");
}

async function readUrlUploadJson(request: Request, env: Env): Promise<{ file: File; remark?: string; directoryPath: string }> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const body = await readJsonObject(request);
  const sourceUrl = normalizeSourceUrl(body.url);
  const fileNameOverride = normalizeOptionalFileName(body.file_name);

  if (!sourceUrl) {
    throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? body.dir ?? "/");
  const file = await downloadFileFromUrl({
    sourceUrl,
    env,
    maxFileBytes,
    ...(fileNameOverride ? { fileName: fileNameOverride } : {})
  });
  const remark = normalizeRemark(body.remark);

  return {
    file,
    directoryPath,
    ...(remark ? { remark } : {})
  };
}

async function readCompleteUploadThumbnail(request: Request): Promise<ThumbnailInput | undefined> {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType) {
    return undefined;
  }

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return undefined;
  }

  const formData = await request.formData();
  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    return undefined;
  }

  return {
    file: thumbnail,
    ...optionalThumbnailDimensions(formData)
  };
}

function optionalThumbnailDimensions(formData: FormData): Pick<ThumbnailInput, "width" | "height"> {
  const width = optionalBoundedInteger(formData.get("thumbnail_width"), 1, 8192);
  const height = optionalBoundedInteger(formData.get("thumbnail_height"), 1, 8192);

  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
}

function optionalBoundedInteger(value: FormDataEntryValue | null, min: number, max: number): number | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return undefined;
  }

  return parsed;
}

function validateUploadFileSize(file: File, maxFileBytes: number): void {
  if (file.size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (file.size > maxFileBytes) {
    throw fileTooLargeError(maxFileBytes, file.size);
  }
}

function renameUploadFile(file: File, fileName: string): File {
  return new File([file], fileName, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified
  });
}

function fileTooLargeError(
  maxFileBytes: number,
  actualFileBytes: number,
  extraDetails: Record<string, unknown> = {}
): AppError {
  const maxFileSize = formatHumanFileSize(maxFileBytes);
  const actualFileSize = formatHumanFileSize(actualFileBytes);

  return new AppError(413, "FileTooLarge", `文件大小不能超过 ${maxFileSize}（当前 ${actualFileSize}）`, {
    max_file_bytes: maxFileBytes,
    actual_file_bytes: actualFileBytes,
    max_file_size: maxFileSize,
    actual_file_size: actualFileSize,
    ...extraDetails
  });
}

function formatHumanFileSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0B";
  }

  const units = [
    { label: "T", bytes: 1024 ** 4 },
    { label: "G", bytes: 1024 ** 3 },
    { label: "MB", bytes: 1024 ** 2 },
    { label: "KB", bytes: 1024 },
    { label: "B", bytes: 1 }
  ];
  let remaining = Math.floor(value);
  const parts: string[] = [];

  for (const unit of units) {
    const count = Math.floor(remaining / unit.bytes);
    if (count <= 0) {
      continue;
    }

    parts.push(`${count}${unit.label}`);
    remaining -= count * unit.bytes;
  }

  return parts.join("") || "0B";
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
  env: Env;
  maxFileBytes: number;
  fileName?: string;
}): Promise<File> {
  const signedFile = await downloadSignedFileUrl(params);
  if (signedFile) {
    return params.fileName ? renameUploadFile(signedFile, params.fileName) : signedFile;
  }

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
    throw fileTooLargeError(params.maxFileBytes, contentLength);
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
  const fileName = params.fileName ?? ensureFileExtension(sanitizeFileName(initialFileName), detectedMimeType);
  const file = new File([bytes], fileName, { type: detectedMimeType });

  validateUploadFileSize(file, params.maxFileBytes);

  return file;
}

async function downloadSignedFileUrl(params: {
  sourceUrl: URL;
  env: Env;
  maxFileBytes: number;
}): Promise<File | undefined> {
  const token = extractOptionalFileToken(params.sourceUrl.pathname);

  if (!token) {
    return undefined;
  }

  let payload: Awaited<ReturnType<typeof verifySignedToken>>;
  try {
    payload = await verifySignedToken(token, requireEnv(params.env, "LINK_SIGNING_SECRET"));
  } catch (error) {
    if (error instanceof TokenError) {
      return undefined;
    }

    throw error;
  }

  if (payload.size > params.maxFileBytes) {
    throw fileTooLargeError(params.maxFileBytes, payload.size);
  }

  if (payload.v !== 1) {
    return undefined;
  }

  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken,
    fileId: payload.file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: null
  });

  let bytes: ArrayBuffer;
  try {
    bytes = await telegramResponse.arrayBuffer();
  } catch {
    throw new AppError(502, "TelegramFileDownloadFailed", "Failed to read Telegram file response");
  }

  const fileName = sanitizeFileName(payload.name);
  const detectedMimeType = resolveStoredMimeType({
    bytes,
    fileType: payload.mime_type || pickRemoteMimeHint(telegramResponse.headers.get("Content-Type"), fileName)
  });
  const file = new File([bytes], ensureFileExtension(fileName, detectedMimeType), { type: detectedMimeType });

  validateUploadFileSize(file, params.maxFileBytes);

  return file;
}

async function uploadRateLimitedTelegramDocument(params: {
  env: Env;
  botToken: string;
  chatId: string;
  file: Blob;
  fileName: string;
  telegramSlot: TelegramApiSlot;
}): Promise<Awaited<ReturnType<typeof uploadDocumentToTelegram>>> {
  try {
    return await uploadDocumentToTelegram({
      botToken: params.botToken,
      chatId: params.chatId,
      file: params.file,
      fileName: params.fileName
    });
  } catch (error) {
    await penalizeTelegramApiSlotFromError(params.env, "sendDocument", params.telegramSlot.channelId, error);
    throw error;
  } finally {
    await releaseTelegramApiSlot(params.env, params.telegramSlot);
  }
}

async function uploadTelegramDocumentWithChannel(params: {
  env: Env;
  db?: D1Database;
  file: Blob;
  fileName: string;
  preferredChannelId?: string;
  preferredChannelIndex?: number;
  telegramSlot?: TelegramUploadSlot;
}): Promise<{ telegramDocument: Awaited<ReturnType<typeof uploadDocumentToTelegram>>; channel: TelegramStorageChannel }> {
  const slot = params.telegramSlot ?? await acquireTelegramUploadSlot(params.env, params.db, {
    ...(params.preferredChannelId ? { preferredChannelId: params.preferredChannelId } : {}),
    ...(params.preferredChannelIndex !== undefined ? { preferredChannelIndex: params.preferredChannelIndex } : {})
  });
  const telegramDocument = await uploadRateLimitedTelegramDocument({
    env: params.env,
    botToken: slot.botToken,
    chatId: slot.chatId,
    file: params.file,
    fileName: params.fileName,
    telegramSlot: slot
  });

  return {
    telegramDocument,
    channel: {
      id: slot.channelId,
      name: slot.channelId,
      botToken: slot.botToken,
      chatId: slot.chatId,
      status: "active",
      isDefault: slot.channelId === "default"
    }
  };
}

async function getRateLimitedTelegramFileUrl(params: {
  env: Env;
  botToken: string;
  fileId: string;
  channelId?: string;
}): Promise<string> {
  await acquireTelegramApiSlot(params.env, "getFile", params.channelId);

  try {
    return await getTelegramFileUrl({
      botToken: params.botToken,
      fileId: params.fileId
    });
  } catch (error) {
    await penalizeTelegramApiSlotFromError(params.env, "getFile", params.channelId, error);
    throw error;
  }
}

async function acquireTelegramUploadSlot(
  env: Env,
  db: D1Database | undefined,
  options: { preferredChannelId?: string; preferredChannelIndex?: number } = {}
): Promise<TelegramUploadSlot> {
  const channels = await listUploadTelegramChannels(env, db);
  const channelIds = channels.map((channel) => channel.id);
  const preferredByIndex = Number.isSafeInteger(options.preferredChannelIndex) && channels.length > 0
    ? channels[Math.abs(Number(options.preferredChannelIndex)) % channels.length]?.id
    : undefined;
  const preferredChannelId = options.preferredChannelId ?? preferredByIndex;
  const slot = await acquireTelegramApiSlot(env, "sendDocument", undefined, channelIds, preferredChannelId);
  const selectedChannel = channels.find((channel) => channel.id === slot.channelId) ?? channels[0];

  if (!selectedChannel || !slot.token) {
    throw new AppError(502, "TelegramRateLimiterFailed", "Telegram rate limiter did not return an upload channel");
  }

  return {
    scope: "sendDocument",
    token: slot.token,
    channelId: selectedChannel.id,
    botToken: selectedChannel.botToken,
    chatId: selectedChannel.chatId
  };
}

async function acquireTelegramApiSlot(
  env: Env,
  scope: TelegramRateLimitScope,
  channelId?: string,
  channelIds?: string[],
  preferredChannelId?: string
): Promise<TelegramApiSlot> {
  const normalizedChannelId = normalizeTelegramChannelId(channelId);
  const limiter = env.TELEGRAM_RATE_LIMITER;
  if (!limiter) {
    return {
      scope,
      channelId: normalizedChannelId,
      ...(scope === "sendDocument" ? { token: crypto.randomUUID() } : {})
    };
  }

  const id = limiter.idFromName(TELEGRAM_RATE_LIMITER_OBJECT_NAME);
  const response = await limiter.get(id).fetch("https://telegram-rate-limiter/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope,
      channel_id: normalizedChannelId,
      ...(channelIds ? { channel_ids: channelIds } : {}),
      ...(preferredChannelId ? { preferred_channel_id: preferredChannelId } : {})
    })
  });

  if (!response.ok) {
    throw new AppError(502, "TelegramRateLimiterFailed", "Telegram rate limiter failed");
  }

  const body = await response.json().catch(() => ({})) as { token?: unknown; channel_id?: unknown };
  return {
    scope,
    channelId: typeof body.channel_id === "string" && body.channel_id ? body.channel_id : normalizedChannelId,
    ...(typeof body.token === "string" && body.token ? { token: body.token } : {})
  };
}

async function releaseTelegramApiSlot(env: Env, slot: TelegramApiSlot): Promise<void> {
  if (slot.scope !== "sendDocument" || !slot.token || !env.TELEGRAM_RATE_LIMITER) {
    return;
  }

  const id = env.TELEGRAM_RATE_LIMITER.idFromName(TELEGRAM_RATE_LIMITER_OBJECT_NAME);
  try {
    await env.TELEGRAM_RATE_LIMITER.get(id).fetch("https://telegram-rate-limiter/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: slot.scope,
        channel_id: slot.channelId ?? "default",
        token: slot.token
      })
    });
  } catch (error) {
    console.warn("Failed to release Telegram API rate limit slot", {
      scope: slot.scope,
      channel_id: slot.channelId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function penalizeTelegramApiSlotFromError(
  env: Env,
  scope: TelegramRateLimitScope,
  channelId: string | undefined,
  error: unknown
): Promise<void> {
  const retryAfterSeconds = telegramRetryAfterSeconds(error);
  if (!retryAfterSeconds || !env.TELEGRAM_RATE_LIMITER) {
    return;
  }

  const id = env.TELEGRAM_RATE_LIMITER.idFromName(TELEGRAM_RATE_LIMITER_OBJECT_NAME);
  try {
    await env.TELEGRAM_RATE_LIMITER.get(id).fetch("https://telegram-rate-limiter/penalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        channel_id: channelId ?? "default",
        retry_after_ms: retryAfterSeconds * 1000
      })
    });
  } catch (penaltyError) {
    console.warn("Failed to update Telegram API rate limit penalty", {
      scope,
      channel_id: channelId,
      error: penaltyError instanceof Error ? penaltyError.message : String(penaltyError)
    });
  }
}

function telegramRetryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof AppError)) {
    return undefined;
  }

  const value = error.details?.telegram_retry_after_seconds;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function channelCryptoSecret(env: Env): string {
  return requireEnv({ LINK_SIGNING_SECRET: env.TG_CHANNEL_SECRET || env.LINK_SIGNING_SECRET }, "LINK_SIGNING_SECRET");
}

async function telegramChannelTokenHash(botToken: string): Promise<string> {
  return base64UrlEncodeLocal(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBufferLocal(textEncodeLocal(botToken)))));
}

async function encryptTelegramBotToken(botToken: string, env: Env): Promise<string> {
  if (!botToken) {
    return "";
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importTelegramChannelAesKey(env);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBufferLocal(iv) },
    key,
    toArrayBufferLocal(textEncodeLocal(botToken))
  ));

  return `v1.${base64UrlEncodeLocal(iv)}.${base64UrlEncodeLocal(cipher)}`;
}

async function decryptTelegramBotToken(encrypted: string, env: Env): Promise<string> {
  if (!encrypted) {
    return "";
  }

  const [version, ivPart, cipherPart, extra] = encrypted.split(".");
  if (version !== "v1" || !ivPart || !cipherPart || extra !== undefined) {
    throw new AppError(500, "InvalidTelegramChannelSecret", "Telegram channel bot token cannot be decrypted");
  }

  try {
    const key = await importTelegramChannelAesKey(env);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBufferLocal(base64UrlDecodeLocal(ivPart)) },
      key,
      toArrayBufferLocal(base64UrlDecodeLocal(cipherPart))
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new AppError(500, "InvalidTelegramChannelSecret", "Telegram channel bot token cannot be decrypted");
  }
}

async function importTelegramChannelAesKey(env: Env): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBufferLocal(textEncodeLocal(channelCryptoSecret(env))));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function textEncodeLocal(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toArrayBufferLocal(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncodeLocal(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeLocal(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(500, "InvalidTelegramChannelSecret", "Invalid base64url secret data");
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(paddingLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeTelegramChannelId(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized || "default";
}

function isTelegramChannelConfigured(record: TelegramChannelRecord): boolean {
  return Boolean(record.bot_token_encrypted && record.chat_id.trim());
}

async function materializeTelegramChannel(record: TelegramChannelRecord, env: Env): Promise<TelegramStorageChannel | null> {
  if (!isTelegramChannelConfigured(record)) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    botToken: await decryptTelegramBotToken(record.bot_token_encrypted, env),
    chatId: record.chat_id,
    status: record.status,
    isDefault: record.is_default === 1
  };
}

function defaultEnvTelegramChannel(env: Env): TelegramStorageChannel | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_STORAGE_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    return null;
  }

  return {
    id: "default",
    name: "default",
    botToken,
    chatId,
    status: "active",
    isDefault: true
  };
}

async function resolveTelegramChannel(env: Env, db: D1Database | undefined, channelId: string | null | undefined): Promise<TelegramStorageChannel> {
  const normalizedChannelId = normalizeTelegramChannelId(channelId);

  if (db) {
    const record = await getTelegramChannelRecord(db, normalizedChannelId);
    if (record) {
      const materialized = await materializeTelegramChannel(record, env);
      if (materialized) {
        return materialized;
      }
    }
  }

  if (normalizedChannelId === "default") {
    const fallback = defaultEnvTelegramChannel(env);
    if (fallback) {
      return fallback;
    }
  }

  throw new AppError(500, "TelegramChannelNotConfigured", `Telegram channel '${normalizedChannelId}' is not configured`);
}

async function listUploadTelegramChannels(env: Env, db: D1Database | undefined): Promise<TelegramStorageChannel[]> {
  const channels: TelegramStorageChannel[] = [];

  if (db) {
    const records = await listActiveTelegramChannelRecords(db);
    for (const record of records) {
      const materialized = await materializeTelegramChannel(record, env);
      if (materialized) {
        channels.push(materialized);
      } else if (record.id === "default") {
        const fallback = defaultEnvTelegramChannel(env);
        if (fallback) {
          channels.push(fallback);
        }
      }
    }
  }

  if (channels.length === 0) {
    const fallback = defaultEnvTelegramChannel(env);
    if (fallback) {
      channels.push(fallback);
    }
  }

  if (channels.length === 0) {
    throw new AppError(500, "TelegramChannelNotConfigured", "At least one active Telegram channel must be configured");
  }

  return channels;
}

async function serializeTelegramChannelRecord(record: TelegramChannelRecord, env: Env): Promise<Record<string, unknown>> {
  const botToken = record.bot_token_encrypted ? await decryptTelegramBotToken(record.bot_token_encrypted, env) : "";

  return {
    id: record.id,
    name: record.name,
    chat_id: record.chat_id,
    masked_bot_token: maskSecret(botToken),
    configured: Boolean(botToken && record.chat_id.trim()),
    status: record.status,
    is_default: record.is_default === 1,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
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

async function createMultipartUpload(params: {
  db: D1Database;
  sourceKind: "local" | "url";
  sourceUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath: string;
}): Promise<MultipartInitResult> {
  validateMultipartFileSize(params.size);
  await requireFileNameAvailable({
    db: params.db,
    directoryPath: params.directoryPath,
    fileName: params.fileName
  });
  const chunkCount = Math.ceil(params.size / TELEGRAM_CHUNK_SIZE_BYTES);
  const createdAt = new Date().toISOString();
  const record = await insertMultipartUploadRecord(params.db, {
    id: crypto.randomUUID(),
    sourceKind: params.sourceKind,
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    fileName: params.fileName,
    mimeType: params.mimeType,
    size: params.size,
    chunkSize: TELEGRAM_CHUNK_SIZE_BYTES,
    chunkCount,
    ...(params.uploadedBy ? { uploadedBy: params.uploadedBy } : {}),
    directoryId: params.directoryId ?? null,
    directoryPath: params.directoryPath,
    ...(params.remark ? { remark: params.remark } : {}),
    createdAt
  });

  return {
    id: record.id,
    fileName: record.file_name,
    mimeType: record.mime_type,
    size: record.size,
    chunkSize: record.chunk_size,
    chunkCount: record.chunk_count,
    directoryPath: record.directory_path ?? "/"
  };
}

function validateMultipartFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size, {
      chunk_size_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
      chunk_size: formatHumanFileSize(TELEGRAM_CHUNK_SIZE_BYTES),
      max_chunks: MAX_TELEGRAM_MULTIPART_CHUNKS
    });
  }
}

async function probeRemoteSourceForMultipart(
  sourceUrl: URL,
  singleMaxFileBytes: number,
  options: { forceMultipart?: boolean } = {}
): Promise<
  | { mode: "single" }
  | { mode: "multipart"; fileName: string; mimeType: string; size: number }
> {
  const head = await fetchRemoteHead(sourceUrl);
  let size = parseContentLength(head?.headers.get("Content-Length") ?? null);
  const initialFileName = inferRemoteFileName(sourceUrl, head?.headers ?? new Headers());
  const remoteMimeHint = pickRemoteMimeHint(head?.headers.get("Content-Type") ?? null, initialFileName);

  if (!options.forceMultipart && size !== undefined && size <= singleMaxFileBytes) {
    return { mode: "single" };
  }

  if (size !== undefined && size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size);
  }

  const rangeProbe = await fetchRemoteRange(sourceUrl, 0, 0);
  if (rangeProbe.status !== 206) {
    throw new AppError(400, "RangeNotSupported", "Source URL must support Range requests for large URL uploads");
  }

  const contentRange = parseContentRange(rangeProbe.headers.get("Content-Range"));
  size = contentRange?.size ?? size;

  if (size === undefined) {
    throw new AppError(400, "UnknownFileSize", "Source URL must expose Content-Length or Content-Range");
  }

  if (!options.forceMultipart && size <= singleMaxFileBytes) {
    return { mode: "single" };
  }

  if (size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size);
  }

  const detectedMimeType = resolveStoredMimeType({
    bytes: new ArrayBuffer(0),
    fileType: remoteMimeHint
  });
  const fileName = ensureFileExtension(sanitizeFileName(initialFileName), detectedMimeType);

  return {
    mode: "multipart",
    fileName,
    mimeType: detectedMimeType,
    size
  };
}

async function fetchRemoteHead(sourceUrl: URL): Promise<Response | undefined> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      method: "HEAD",
      redirect: "follow",
      headers: { Accept: "*/*" }
    });

    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

async function fetchRemoteRange(sourceUrl: URL, start: number, end: number): Promise<Response> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: {
        Accept: "*/*",
        Range: `bytes=${start}-${end}`
      }
    });

    if (!response.ok && response.status !== 206) {
      throw new AppError(
        response.status >= 500 ? 502 : 400,
        "UrlFetchFailed",
        `Source URL returned ${response.status}`,
        { source_status: response.status }
      );
    }

    return response;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(502, "UrlFetchFailed", "Failed to fetch source URL");
  }
}

async function createThumbnailSourceInfo(params: {
  request: Request;
  env: Env;
  sourceUrl: URL;
  mimeType: string;
  size: number;
}): Promise<ThumbnailSourceInfo | undefined> {
  const kind = thumbnailSourceKind(params.mimeType);

  if (!kind || params.size > thumbnailSourceMaxBytes(kind)) {
    return undefined;
  }

  const expiresAtSeconds = Math.floor(Date.now() / 1000) + THUMBNAIL_SOURCE_TOKEN_TTL_SECONDS;
  const token = await createSignedPayload(
    {
      purpose: "thumbnail_source",
      url: params.sourceUrl.toString(),
      mime_type: params.mimeType,
      kind,
      size: params.size,
      exp: expiresAtSeconds
    } satisfies ThumbnailSourceTokenPayload,
    requireEnv(params.env, "LINK_SIGNING_SECRET")
  );
  const requestUrl = new URL(params.request.url);
  const proxyPath = requestUrl.pathname.startsWith("/api/v1/")
    ? "/api/v1/uploads/url-thumbnail-source"
    : "/api/admin/uploads/url-thumbnail-source";

  return {
    available: true,
    kind,
    url: `${proxyPath}?token=${encodeURIComponent(token)}`,
    mimeType: params.mimeType,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString()
  };
}

function thumbnailSourceKind(mimeType: string): "image" | "video" | undefined {
  const normalized = mimeType.toLowerCase();

  if (normalized.startsWith("image/") && normalized !== "image/svg+xml") {
    return "image";
  }

  if (normalized.startsWith("video/")) {
    return "video";
  }

  return undefined;
}

function thumbnailSourceMaxBytes(kind: "image" | "video"): number {
  return kind === "video" ? VIDEO_THUMBNAIL_SOURCE_MAX_BYTES : IMAGE_THUMBNAIL_SOURCE_MAX_BYTES;
}

async function handleThumbnailSourceProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    throw new AppError(400, "MissingToken", "Missing thumbnail source token");
  }

  const payload = parseThumbnailSourcePayload(
    await verifySignedPayload(token, requireEnv(env, "LINK_SIGNING_SECRET"))
  );
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (payload.exp < nowSeconds) {
    throw new AppError(401, "ExpiredToken", "Thumbnail source token has expired");
  }

  if (payload.size > thumbnailSourceMaxBytes(payload.kind)) {
    throw new AppError(413, "ThumbnailSourceTooLarge", "Thumbnail source is too large");
  }

  const sourceUrl = new URL(payload.url);
  if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
    throw new AppError(400, "InvalidThumbnailSource", "Thumbnail source URL must use HTTP or HTTPS");
  }

  const rangeHeader = thumbnailProxyRangeHeader(request, payload);
  let response: Response;

  try {
    response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: {
        Accept: payload.kind === "image" ? "image/*" : "video/*",
        ...(rangeHeader ? { Range: rangeHeader } : {})
      }
    });
  } catch {
    throw new AppError(502, "ThumbnailSourceFetchFailed", "Failed to fetch thumbnail source");
  }

  if (!response.ok && response.status !== 206) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "ThumbnailSourceFetchFailed",
      `Thumbnail source returned ${response.status}`,
      { source_status: response.status }
    );
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", payload.mime_type || response.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Cache-Control", "private, max-age=600");
  copyHeader(response.headers, headers, "Content-Length");
  copyHeader(response.headers, headers, "Content-Range");
  copyHeader(response.headers, headers, "Accept-Ranges");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function thumbnailProxyRangeHeader(request: Request, payload: ThumbnailSourceTokenPayload): string | undefined {
  const requestedRange = request.headers.get("Range");

  if (requestedRange) {
    return requestedRange;
  }

  if (payload.kind === "video") {
    const end = Math.max(0, Math.min(payload.size, VIDEO_THUMBNAIL_PROXY_DEFAULT_RANGE_BYTES) - 1);
    return `bytes=0-${end}`;
  }

  return undefined;
}

function parseThumbnailSourcePayload(value: unknown): ThumbnailSourceTokenPayload {
  if (!isPlainRecord(value)) {
    throw new TokenError("Invalid thumbnail source token payload");
  }

  if (
    value.purpose !== "thumbnail_source" ||
    typeof value.url !== "string" ||
    typeof value.mime_type !== "string" ||
    (value.kind !== "image" && value.kind !== "video") ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    typeof value.exp !== "number" ||
    !Number.isSafeInteger(value.exp)
  ) {
    throw new TokenError("Invalid thumbnail source token fields");
  }

  return {
    purpose: "thumbnail_source",
    url: value.url,
    mime_type: value.mime_type,
    kind: value.kind,
    size: value.size,
    exp: value.exp
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireMultipartUpload(
  db: D1Database,
  id: string,
  sourceKind?: "local" | "url"
): Promise<MultipartUploadRecord> {
  const upload = await getMultipartUploadRecord(db, id);

  if (!upload) {
    throw new AppError(404, "UploadNotFound", "Multipart upload session not found");
  }

  if (sourceKind && upload.source_kind !== sourceKind) {
    throw new AppError(400, "InvalidUploadSource", `Upload session expects ${upload.source_kind} chunks`);
  }

  return upload;
}

async function requireFileRecord(db: D1Database, id: string): Promise<FileRecord> {
  const file = await getFileRecord(db, id);

  if (!file) {
    throw new AppError(404, "FileNotFound", "File record not found");
  }

  return file;
}

async function requireFileNameAvailable(params: {
  db: D1Database;
  directoryPath: string;
  fileName: string;
  excludeId?: string;
}): Promise<void> {
  const conflict = await findActiveFileNameConflict(params);

  if (conflict) {
    throw fileNameConflictError(params.directoryPath, params.fileName, conflict.source);
  }
}

async function requireFileMoveNamesAvailable(params: {
  db: D1Database;
  files: FileRecord[];
  directoryPath: string;
}): Promise<void> {
  const seenNames = new Set<string>();

  for (const file of params.files) {
    if (seenNames.has(file.file_name)) {
      throw fileNameConflictError(params.directoryPath, file.file_name, "file");
    }

    seenNames.add(file.file_name);
    await requireFileNameAvailable({
      db: params.db,
      directoryPath: params.directoryPath,
      fileName: file.file_name,
      excludeId: file.id
    });
  }
}

function fileNameConflictError(
  directoryPath: string,
  fileName: string,
  source: "file"
): AppError {
  return new AppError(
    409,
    "FileNameConflict",
    "当前目录已存在同名文件，请输入新的文件名",
    {
      directory_path: directoryPath,
      file_name: fileName,
      suggested_name: suggestAlternativeFileName(fileName),
      source
    }
  );
}

function suggestAlternativeFileName(fileName: string): string {
  const match = /^(.*?)(\.[^./\\]{1,12})$/.exec(fileName);
  const base = match?.[1] || fileName;
  const extension = match?.[2] || "";

  return `${base} (1)${extension}`;
}

function normalizeChunkIndex(value: string, upload: MultipartUploadRecord): number {
  const index = Number(value);

  if (!Number.isSafeInteger(index) || index < 0 || index >= upload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  return index;
}

function expectedChunkSize(upload: MultipartUploadRecord, chunkIndex: number): number {
  if (chunkIndex === upload.chunk_count - 1) {
    return upload.size - upload.chunk_size * chunkIndex;
  }

  return upload.chunk_size;
}

function validateChunkFile(chunk: Blob, expectedSize: number): void {
  if (chunk.size !== expectedSize) {
    throw new AppError(400, "InvalidChunkSize", `分片大小必须为 ${formatHumanFileSize(expectedSize)}（当前 ${formatHumanFileSize(chunk.size)}）`, {
      expected_chunk_bytes: expectedSize,
      actual_chunk_bytes: chunk.size,
      expected_chunk_size: formatHumanFileSize(expectedSize),
      actual_chunk_size: formatHumanFileSize(chunk.size)
    });
  }
}

async function downloadRemoteChunk(upload: MultipartUploadRecord, chunkIndex: number): Promise<Blob> {
  if (!upload.source_url) {
    throw new AppError(400, "InvalidUploadSource", "URL upload session is missing source URL");
  }

  const sourceUrl = new URL(upload.source_url);
  const expectedSize = expectedChunkSize(upload, chunkIndex);
  const start = chunkIndex * upload.chunk_size;
  const end = start + expectedSize - 1;
  const response = await fetchRemoteRange(sourceUrl, start, end);

  validateRemoteChunkResponse({ response, upload, start, end, expectedSize });

  let chunk: Blob;
  try {
    chunk = await response.blob();
  } catch {
    throw new AppError(502, "UrlFetchFailed", "Failed to read source URL response");
  }

  validateChunkFile(chunk, expectedSize);
  return chunk;
}

async function downloadAndUploadRemoteChunk(params: {
  env: Env;
  db: D1Database;
  upload: MultipartUploadRecord;
  chunkIndex: number;
}) {
  let telegramSlot: TelegramUploadSlot | undefined = await acquireTelegramUploadSlot(params.env, params.db, {
    preferredChannelIndex: params.chunkIndex
  });

  try {
    const chunk = await downloadRemoteChunk(params.upload, params.chunkIndex);
    const slotForUpload = telegramSlot;
    telegramSlot = undefined;

    return await uploadChunkToTelegram({
      env: params.env,
      db: params.db,
      upload: params.upload,
      chunk,
      chunkIndex: params.chunkIndex,
      telegramSlot: slotForUpload
    });
  } finally {
    if (telegramSlot) {
      await releaseTelegramApiSlot(params.env, telegramSlot);
    }
  }
}

function validateRemoteChunkResponse(params: {
  response: Response;
  upload: MultipartUploadRecord;
  start: number;
  end: number;
  expectedSize: number;
}): void {
  if (params.response.status !== 206) {
    throw new AppError(400, "RangeNotSupported", "Source URL must return 206 for chunk Range requests");
  }

  const contentRange = parseContentRange(params.response.headers.get("Content-Range"));
  if (!contentRange) {
    throw new AppError(400, "RangeNotSupported", "Source URL must include Content-Range for chunk Range requests");
  }

  if (contentRange.start !== params.start || contentRange.end !== params.end || contentRange.size !== params.upload.size) {
    throw new AppError(400, "InvalidChunkRange", "Source URL returned an unexpected byte range", {
      expected_start: params.start,
      expected_end: params.end,
      expected_total_bytes: params.upload.size,
      actual_start: contentRange.start,
      actual_end: contentRange.end,
      actual_total_bytes: contentRange.size
    });
  }

  const contentLength = parseContentLength(params.response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength !== params.expectedSize) {
    throw new AppError(400, "InvalidChunkSize", `分片大小必须为 ${formatHumanFileSize(params.expectedSize)}（当前 ${formatHumanFileSize(contentLength)}）`, {
      expected_chunk_bytes: params.expectedSize,
      actual_chunk_bytes: contentLength,
      expected_chunk_size: formatHumanFileSize(params.expectedSize),
      actual_chunk_size: formatHumanFileSize(contentLength)
    });
  }
}

async function uploadChunkToTelegram(params: {
  env: Env;
  db: D1Database;
  upload: MultipartUploadRecord;
  chunk: Blob;
  chunkIndex: number;
  telegramSlot?: TelegramUploadSlot;
}) {
  const fileName = chunkFileName(params.upload, params.chunkIndex);
  const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
    env: params.env,
    db: params.db,
    file: params.chunk,
    fileName,
    preferredChannelIndex: params.chunkIndex,
    ...(params.telegramSlot ? { telegramSlot: params.telegramSlot } : {})
  });

  return {
    fileId: params.upload.id,
    chunkIndex: params.chunkIndex,
    size: telegramDocument.file_size ?? params.chunk.size,
    md5: chunkDigest(params.upload, params.chunkIndex, telegramDocument.file_unique_id),
    telegramFileId: telegramDocument.file_id,
    telegramChannelId: channel.id,
    ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
    createdAt: new Date().toISOString()
  };
}
function preferredChunkChannelId(_upload: MultipartUploadRecord, _chunkIndex: number): string | undefined {
  return undefined;
}

function chunkFileName(upload: MultipartUploadRecord, chunkIndex: number): string {
  const padded = String(chunkIndex + 1).padStart(String(upload.chunk_count).length, "0");
  return `${upload.file_name}.part-${padded}-of-${upload.chunk_count}`;
}

function chunkDigest(upload: MultipartUploadRecord, chunkIndex: number, telegramFileUniqueId: string | undefined): string {
  return telegramFileUniqueId
    ? `tg:${telegramFileUniqueId}`
    : `chunk:${chunkIndex}:${expectedChunkSize(upload, chunkIndex)}`;
}

async function completeMultipartUpload(params: {
  request: Request;
  env: Env;
  db: D1Database;
  upload: MultipartUploadRecord;
  thumbnail?: ThumbnailInput;
}): Promise<UploadResult> {
  const chunks = await listFileChunkRecords(params.db, params.upload.id);
  validateCompleteChunks(params.upload, chunks);
  await requireFileNameAvailable({
    db: params.db,
    directoryPath: params.upload.directory_path ?? "/",
    fileName: params.upload.file_name,
    excludeId: params.upload.id
  });

  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const createdAt = new Date().toISOString();
  const token = await createSignedToken(
    {
      v: 2,
      file_record_id: params.upload.id,
      name: params.upload.file_name,
      mime_type: params.upload.mime_type,
      size: params.upload.size,
      chunk_size: params.upload.chunk_size,
      chunk_count: params.upload.chunk_count,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );
  const baseUrl = getPublicBaseUrl(params.request, params.env);
  const publicName = encodeURIComponent(params.upload.file_name);
  const filePath = `/f/${token}/${publicName}`;
  const publicUrl = `${baseUrl}${filePath}`;
  const md5 = multipartDigest(chunks);
  const thumbnail = await uploadOptionalThumbnail({
    request: params.request,
    env: params.env,
    db: params.db,
    originalFileName: params.upload.file_name,
    thumbnail: params.thumbnail
  });

  await completeMultipartUploadWithFileRecord({
    db: params.db,
    uploadId: params.upload.id,
    completedAt: createdAt,
    file: {
      id: params.upload.id,
      fileName: params.upload.file_name,
      mimeType: params.upload.mime_type,
      size: params.upload.size,
      md5,
      telegramFileId: `multipart:${params.upload.id}`,
      telegramChannelId: chunks[0]?.telegram_channel_id ?? "default",
      filePath,
      createdAt,
      storageBackend: "telegram_multipart",
      chunkSize: params.upload.chunk_size,
      chunkCount: params.upload.chunk_count,
      directoryId: params.upload.directory_id ?? null,
      directoryPath: params.upload.directory_path ?? "/",
      ...thumbnailFileRecordFields(thumbnail),
      ...(params.upload.remark ? { remark: params.upload.remark } : {}),
      ...(params.upload.uploaded_by ? { uploadedBy: params.upload.uploaded_by } : {})
    }
  });

  return {
    id: params.upload.id,
    name: params.upload.file_name,
    size: params.upload.size,
    mimeType: params.upload.mime_type,
    md5,
    filePath,
    publicUrl,
    telegramFileId: `multipart:${params.upload.id}`,
    telegramChannelId: chunks[0]?.telegram_channel_id ?? "default",
    ...(params.upload.remark ? { remark: params.upload.remark } : {}),
    createdAt,
    directoryId: params.upload.directory_id ?? null,
    directoryPath: params.upload.directory_path ?? "/",
    storageBackend: "telegram_multipart",
    chunkSize: params.upload.chunk_size,
    chunkCount: params.upload.chunk_count,
    ...(thumbnail ? { thumbnail } : {})
  };
}

async function uploadOptionalThumbnail(params: {
  request: Request;
  env: Env;
  db: D1Database;
  originalFileName: string;
  thumbnail: ThumbnailInput | undefined;
}): Promise<UploadedThumbnailResult | undefined> {
  const thumbnail = params.thumbnail;
  if (!thumbnail) {
    return undefined;
  }

  try {
    return await uploadThumbnailToTelegram({ ...params, thumbnail });
  } catch (error) {
    console.error("Thumbnail upload failed", {
      file_name: params.originalFileName,
      error: error instanceof Error ? error.message : String(error)
    });
    return { status: "failed" };
  }
}

async function uploadThumbnailToTelegram(params: {
  request: Request;
  env: Env;
  db: D1Database;
  originalFileName: string;
  thumbnail: ThumbnailInput;
}): Promise<UploadedThumbnailResult> {
  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const thumbnailBytes = await params.thumbnail.file.arrayBuffer();

  validateThumbnailBytes(thumbnailBytes, params.thumbnail.file.type);

  const mimeType = resolveStoredMimeType({
    bytes: thumbnailBytes,
    fileType: params.thumbnail.file.type
  });
  validateThumbnailMimeType(mimeType);

  const thumbnailFileName = thumbnailFileNameFor(params.originalFileName, mimeType);
  const thumbnailFile = new File([thumbnailBytes], thumbnailFileName, { type: mimeType });
  const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
    env: params.env,
    db: params.db,
    file: thumbnailFile,
    fileName: thumbnailFileName
  });
  const thumbnailSize = telegramDocument.file_size ?? thumbnailFile.size;
  const token = await createSignedToken(
    {
      v: 3,
      channel_id: channel.id,
      file_id: telegramDocument.file_id,
      name: thumbnailFileName,
      mime_type: mimeType,
      size: thumbnailSize,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );
  const filePath = `/f/${token}/${encodeURIComponent(thumbnailFileName)}`;

  return {
    status: "ready",
    fileId: telegramDocument.file_id,
    telegramChannelId: channel.id,
    ...(telegramDocument.file_unique_id ? { fileUniqueId: telegramDocument.file_unique_id } : {}),
    filePath,
    mimeType,
    size: thumbnailSize,
    ...(params.thumbnail.width ? { width: params.thumbnail.width } : {}),
    ...(params.thumbnail.height ? { height: params.thumbnail.height } : {})
  };
}

function validateThumbnailBytes(bytes: ArrayBuffer, fileType: string): void {
  if (bytes.byteLength <= 0) {
    throw new AppError(400, "InvalidThumbnail", "Thumbnail must not be empty");
  }

  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new AppError(400, "ThumbnailTooLarge", `Thumbnail must not exceed ${formatHumanFileSize(MAX_THUMBNAIL_BYTES)}`);
  }

  if (fileType && fileType.toLowerCase().includes("svg")) {
    throw new AppError(400, "InvalidThumbnailType", "SVG thumbnails are not allowed");
  }
}

function validateThumbnailMimeType(mimeType: string): void {
  if (!ALLOWED_THUMBNAIL_MIME_TYPES.has(mimeType)) {
    throw new AppError(400, "InvalidThumbnailType", "Thumbnail must be JPEG, PNG, or WebP");
  }
}

function thumbnailFileNameFor(originalFileName: string, mimeType: string): string {
  const extension = extensionForMimeType(mimeType) ?? "jpg";
  const sanitized = sanitizeFileName(originalFileName);
  const base = sanitized.replace(/\.[^./\\]{1,12}$/i, "") || "thumbnail";

  return sanitizeFileName(`${base}.thumbnail.${extension}`);
}

function thumbnailFileRecordFields(thumbnail: UploadedThumbnailResult | undefined): Partial<Parameters<typeof completeMultipartUploadWithFileRecord>[0]["file"]> {
  if (!thumbnail) {
    return {};
  }

  return {
    thumbnailStatus: thumbnail.status,
    ...(thumbnail.fileId ? { thumbnailFileId: thumbnail.fileId } : {}),
    ...(thumbnail.fileUniqueId ? { thumbnailFileUniqueId: thumbnail.fileUniqueId } : {}),
    ...(thumbnail.filePath ? { thumbnailFilePath: thumbnail.filePath } : {}),
    ...(thumbnail.mimeType ? { thumbnailMimeType: thumbnail.mimeType } : {}),
    ...(thumbnail.size ? { thumbnailSize: thumbnail.size } : {}),
    ...(thumbnail.width ? { thumbnailWidth: thumbnail.width } : {}),
    ...(thumbnail.height ? { thumbnailHeight: thumbnail.height } : {})
  };
}

function validateCompleteChunks(upload: MultipartUploadRecord, chunks: FileChunkRecord[]): void {
  if (chunks.length !== upload.chunk_count) {
    throw new AppError(409, "UploadIncomplete", "Not all chunks have been uploaded", {
      expected_chunks: upload.chunk_count,
      actual_chunks: chunks.length
    });
  }

  for (let index = 0; index < upload.chunk_count; index += 1) {
    const chunk = chunks[index];
    const expectedSize = expectedChunkSize(upload, index);
    if (!chunk || chunk.chunk_index !== index || chunk.size !== expectedSize) {
      throw new AppError(409, "UploadIncomplete", "Uploaded chunks are incomplete or inconsistent", {
        chunk_index: index,
        expected_chunk_bytes: expectedSize,
        actual_chunk_bytes: chunk?.size
      });
    }
  }
}

function multipartDigest(chunks: FileChunkRecord[]): string {
  return `multipart:${chunks.map((chunk) => chunk.md5).join(":")}`;
}

async function uploadAndRecordFile(params: {
  request: Request;
  env: Env;
  file: File;
  db?: D1Database;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath?: string;
}): Promise<UploadResult> {
  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const id = crypto.randomUUID();
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

  const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
    env: params.env,
    ...(params.db ? { db: params.db } : {}),
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
      v: 3,
      channel_id: channel.id,
      file_id: telegramDocument.file_id,
      name: storedName,
      mime_type: mimeType,
      size: fileSize,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );

  const baseUrl = getPublicBaseUrl(params.request, params.env);
  const publicName = encodeURIComponent(storedName);
  const filePath = `/f/${token}/${publicName}`;
  const publicUrl = `${baseUrl}${filePath}`;

  if (params.db) {
    await requireFileNameAvailable({
      db: params.db,
      directoryPath: params.directoryPath ?? "/",
      fileName: storedName
    });
    await insertFileRecord(params.db, {
      id,
      fileName: storedName,
      mimeType,
      size: fileSize,
      md5,
      telegramFileId: telegramDocument.file_id,
      telegramChannelId: channel.id,
      filePath,
      createdAt,
      directoryId: params.directoryId ?? null,
      directoryPath: params.directoryPath ?? "/",
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
    telegramChannelId: channel.id,
    ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
    ...(params.remark ? { remark: params.remark } : {}),
    createdAt,
    directoryId: params.directoryId ?? null,
    directoryPath: params.directoryPath ?? "/",
    storageBackend: "telegram_single",
    chunkSize: null,
    chunkCount: null
  };
}

async function createFilePathForRecord(record: FileRecord, fileName: string, env: Env): Promise<string> {
  const signingSecret = requireEnv(env, "LINK_SIGNING_SECRET");
  const iat = Math.floor(Date.now() / 1000);
  const isMultipart = record.storage_backend === "telegram_multipart";
  const token = isMultipart
    ? await createSignedToken(
        {
          v: 2,
          file_record_id: record.id,
          name: fileName,
          mime_type: record.mime_type,
          size: record.size,
          chunk_size: requirePositiveRecordInteger(record.chunk_size, "chunk_size"),
          chunk_count: requirePositiveRecordInteger(record.chunk_count, "chunk_count"),
          iat
        },
        signingSecret
      )
    : await createSignedToken(
        {
          v: 3,
          channel_id: normalizeTelegramChannelId(record.telegram_channel_id),
          file_id: record.telegram_file_id,
          name: fileName,
          mime_type: record.mime_type,
          size: record.size,
          iat
        },
        signingSecret
      );

  return `/f/${token}/${encodeURIComponent(fileName)}`;
}

function requirePositiveRecordInteger(value: number | null | undefined, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new AppError(500, "InvalidFileRecord", `File record is missing ${fieldName}`);
  }

  return value as number;
}

async function handleFileAccess(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const chunkAccess = extractMultipartChunkAccess(url.pathname);
  const token = chunkAccess?.token ?? extractFileToken(url.pathname);
  const payload = await verifySignedToken(token, requireEnv(env, "LINK_SIGNING_SECRET"));
  const rangeHeader = request.headers.get("Range");
  const forceDownload = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

  if (chunkAccess) {
    return handleMultipartChunkAccess({
      env,
      payload,
      chunkIndex: chunkAccess.chunkIndex,
      rangeHeader
    });
  }

  if (payload.v === 2) {
    return handleMultipartFileAccess({
      env,
      payload,
      rangeHeader,
      forceDownload
    });
  }

  const db = env.FILES_DB;
  const channel = await resolveTelegramChannel(env, db, payload.v === 3 ? payload.channel_id : "default");
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: payload.file_id
  });
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

async function handleMultipartChunkAccess(params: {
  env: Env;
  payload: Awaited<ReturnType<typeof verifySignedToken>>;
  chunkIndex: number;
  rangeHeader: string | null;
}): Promise<Response> {
  if (params.payload.v !== 2) {
    throw new AppError(400, "NotMultipartFile", "Chunk download is only available for multipart files");
  }

  validatePayloadChunkIndex(params.payload, params.chunkIndex);

  const db = requireDb(params.env);
  const chunk = await getFileChunkRecord(db, params.payload.file_record_id, params.chunkIndex);
  const expectedSize = expectedPayloadChunkSize(params.payload, params.chunkIndex);

  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "Multipart file chunk was not found");
  }

  const range = parseByteRange(params.rangeHeader, chunk.size);
  if (!range) {
    return rangeNotSatisfiableResponse(chunk.size);
  }

  const channel = await resolveTelegramChannel(params.env, db, chunk.telegram_channel_id);
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: chunk.telegram_file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: range.partial ? `bytes=${range.start}-${range.end}` : null
  });

  if (range.partial && telegramResponse.status !== 206 && (range.start !== 0 || range.end !== chunk.size - 1)) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
  }

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(chunkDownloadFileName(params.payload, params.chunkIndex)));
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${chunk.size}`);
  }
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(params.payload.chunk_count));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * params.payload.chunk_size));

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    headers
  });
}

async function handleMultipartChunkRecordAccess(params: {
  env: Env;
  file: FileRecord;
  chunkIndex: number;
}): Promise<Response> {
  if (fileStorageBackend(params.file) !== "telegram_multipart") {
    throw new AppError(400, "NotMultipartFile", "Chunk download is only available for multipart files");
  }

  const chunkSize = requirePositiveRecordInteger(params.file.chunk_size, "chunk_size");
  const chunkCount = requirePositiveRecordInteger(params.file.chunk_count, "chunk_count");

  if (!Number.isSafeInteger(params.chunkIndex) || params.chunkIndex < 0 || params.chunkIndex >= chunkCount) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  const db = requireDb(params.env);
  const chunk = await getFileChunkRecord(db, params.file.id, params.chunkIndex);
  const expectedSize = expectedRecordChunkSize(params.file.size, chunkSize, chunkCount, params.chunkIndex);

  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "Multipart file chunk was not found");
  }

  const channel = await resolveTelegramChannel(params.env, db, chunk.telegram_channel_id);
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: chunk.telegram_file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: null
  });

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.file.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(recordChunkDownloadFileName(params.file.file_name, chunkCount, params.chunkIndex)));
  headers.set("Content-Length", String(chunk.size));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(chunkCount));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * chunkSize));

  return new Response(telegramResponse.body, {
    status: 200,
    headers
  });
}

async function handleMultipartFileAccess(params: {
  env: Env;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!canDirectlyAccessMultipartPayload(params.payload)) {
    throw new AppError(
      403,
      "DirectAccessDisabled",
      "该文件分片数量过多，不提供完整文件访问链接，请在控制台使用加速下载",
      {
        chunk_count: params.payload.chunk_count,
        direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS
      }
    );
  }

  const db = requireDb(params.env);
  const chunks = await listFileChunkRecords(db, params.payload.file_record_id);

  validateTokenChunks(params.payload, chunks);
  const range = parseByteRange(params.rangeHeader, params.payload.size);
  if (!range) {
    return rangeNotSatisfiableResponse(params.payload.size);
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.payload.mime_type);
  headers.set(
    "Content-Disposition",
    params.forceDownload
      ? contentDispositionAttachment(params.payload.name)
      : contentDispositionInline(params.payload.name)
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range.end - range.start + 1));

  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${params.payload.size}`);
  }

  return new Response(streamMultipartFile({
    env: params.env,
    payload: params.payload,
    chunks,
    range
  }), {
    status: range.partial ? 206 : 200,
    headers
  });
}

function validateTokenChunks(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunks: FileChunkRecord[]
): void {
  if (chunks.length !== payload.chunk_count) {
    throw new AppError(404, "FileChunksNotFound", "Multipart file chunks are incomplete");
  }

  for (let index = 0; index < payload.chunk_count; index += 1) {
    const chunk = chunks[index];
    const expectedSize = expectedPayloadChunkSize(payload, index);

    if (!chunk || chunk.chunk_index !== index || chunk.size !== expectedSize) {
      throw new AppError(404, "FileChunksNotFound", "Multipart file chunks are incomplete");
    }
  }
}

function validatePayloadChunkIndex(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= payload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }
}

function expectedPayloadChunkSize(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): number {
  return chunkIndex === payload.chunk_count - 1
    ? payload.size - payload.chunk_size * chunkIndex
    : payload.chunk_size;
}

function expectedRecordChunkSize(size: number, chunkSize: number, chunkCount: number, chunkIndex: number): number {
  return chunkIndex === chunkCount - 1
    ? size - chunkSize * chunkIndex
    : chunkSize;
}

function chunkDownloadFileName(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): string {
  return recordChunkDownloadFileName(payload.name, payload.chunk_count, chunkIndex);
}

function recordChunkDownloadFileName(fileName: string, chunkCount: number, chunkIndex: number): string {
  const paddedIndex = String(chunkIndex + 1).padStart(String(chunkCount).length, "0");
  return `${fileName}.part-${paddedIndex}-of-${chunkCount}`;
}

function streamMultipartFile(params: {
  env: Env;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  chunks: FileChunkRecord[];
  range: ParsedByteRange;
}): ReadableStream<Uint8Array> {
  const segments = params.chunks
    .map((chunk) => {
      const chunkStart = chunk.chunk_index * params.payload.chunk_size;
      const chunkEnd = chunkStart + chunk.size - 1;
      const overlapStart = Math.max(params.range.start, chunkStart);
      const overlapEnd = Math.min(params.range.end, chunkEnd);

      if (overlapStart > overlapEnd) {
        return undefined;
      }

      return {
        chunk,
        chunkStart,
        chunkEnd,
        overlapStart,
        overlapEnd
      };
    })
    .filter((segment): segment is {
      chunk: FileChunkRecord;
      chunkStart: number;
      chunkEnd: number;
      overlapStart: number;
      overlapEnd: number;
    } => Boolean(segment));

  let segmentIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (reader) {
            const { done, value } = await reader.read();
            if (done) {
              reader.releaseLock();
              reader = undefined;
              segmentIndex += 1;
              continue;
            }

            if (value) {
              controller.enqueue(value);
              return;
            }

            continue;
          }

          const segment = segments[segmentIndex];
          if (!segment) {
            controller.close();
            return;
          }

          const { chunk, chunkStart, chunkEnd, overlapStart, overlapEnd } = segment;
          const channel = await resolveTelegramChannel(params.env, params.env.FILES_DB, chunk.telegram_channel_id);
          const telegramFileUrl = await getRateLimitedTelegramFileUrl({
            env: params.env,
            botToken: channel.botToken,
            channelId: channel.id,
            fileId: chunk.telegram_file_id
          });
          const telegramResponse = await fetchTelegramFile({
            fileUrl: telegramFileUrl,
            rangeHeader: `bytes=${overlapStart - chunkStart}-${overlapEnd - chunkStart}`
          });

          if (telegramResponse.status !== 206 && (overlapStart !== chunkStart || overlapEnd !== chunkEnd)) {
            throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
          }

          if (!telegramResponse.body) {
            throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
          }

          reader = telegramResponse.body.getReader();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      reader = undefined;
    }
  });
}

function parseByteRange(rangeHeader: string | null, size: number): ParsedByteRange | null {
  if (!rangeHeader) {
    return { start: 0, end: size - 1, partial: false };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }

  let start: number;
  let end: number;

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      return null;
    }

    if (start >= size) {
      return null;
    }

    end = Math.min(end, size - 1);
  }

  return { start, end, partial: true };
}

function rangeNotSatisfiableResponse(size: number): Response {
  const headers = withSecurityHeaders();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes */${size}`);
  return new Response(null, { status: 416, headers });
}

async function requireUploadApiKey(request: Request, db: D1Database): Promise<ApiKeyRecord> {
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
  return apiKey;
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
  const storageBackend = fileStorageBackend(file);
  const directAccess = canDirectlyAccessFileRecord(file);
  const url = directAccess ? `${baseUrl}${file.file_path}` : null;
  const thumbnailUrl = file.thumbnail_file_path && file.thumbnail_status === "ready"
    ? `${baseUrl}${file.thumbnail_file_path}`
    : null;

  return {
    ...file,
    directory_id: file.directory_id ?? null,
    directory_path: file.directory_path ?? "/",
    storage_backend: storageBackend,
    chunk_size: storageBackend === "telegram_multipart" ? file.chunk_size ?? null : null,
    chunk_count: storageBackend === "telegram_multipart" ? file.chunk_count ?? null : null,
    direct_access: directAccess,
    download_strategy: downloadStrategy(storageBackend, directAccess),
    url,
    download_url: url ? appendDownloadParam(url) : null,
    thumbnail_status: file.thumbnail_status ?? "none",
    thumbnail_url: thumbnailUrl,
    telegram_channel_id: file.telegram_channel_id ?? "default",
    thumbnail_file_id: file.thumbnail_file_id ?? null,
    thumbnail_file_unique_id: file.thumbnail_file_unique_id ?? null,
    thumbnail_file_path: file.thumbnail_file_path ?? null,
    thumbnail_mime_type: file.thumbnail_mime_type ?? null,
    thumbnail_size: file.thumbnail_size ?? null,
    thumbnail_width: file.thumbnail_width ?? null,
    thumbnail_height: file.thumbnail_height ?? null
  };
}

function serializeMultipartInit(result: MultipartInitResult): Record<string, unknown> {
  return {
    id: result.id,
    file_name: result.fileName,
    mime_type: result.mimeType,
    size: result.size,
    chunk_size: result.chunkSize,
    chunk_count: result.chunkCount,
    directory_path: result.directoryPath,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access: result.chunkCount <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    thumbnail_source: result.thumbnailSource
      ? {
          available: result.thumbnailSource.available,
          kind: result.thumbnailSource.kind,
          url: result.thumbnailSource.url,
          mime_type: result.thumbnailSource.mimeType,
          expires_at: result.thumbnailSource.expiresAt
        }
      : null
  };
}

function serializeDirectoryRecord(record: DirectoryRecord, usage?: { file_count: number; total_size: number }): Record<string, unknown> {
  return {
    id: record.id,
    parent_id: record.parent_id,
    name: record.name,
    path: record.path,
    created_at: record.created_at,
    deleted_at: record.deleted_at,
    file_count: usage?.file_count ?? 0,
    total_size: usage?.total_size ?? 0
  };
}

function serializeCurrentDirectory(record: DirectoryRecord | null, path: string): Record<string, unknown> {
  if (path === "/") {
    return {
      id: null,
      parent_id: null,
      name: "/",
      path: "/",
      created_at: null,
      deleted_at: null
    };
  }

  if (!record) {
    return {
      id: null,
      parent_id: null,
      name: path.split("/").filter(Boolean).at(-1) ?? path,
      path,
      created_at: null,
      deleted_at: null
    };
  }

  return serializeDirectoryRecord(record);
}

function serializeChunk(record: Awaited<ReturnType<typeof uploadChunkToTelegram>>): Record<string, unknown> {
  return {
    chunk_index: record.chunkIndex,
    size: record.size,
    md5: record.md5,
    telegram_file_id: record.telegramFileId,
    telegram_channel_id: record.telegramChannelId ?? "default"
  };
}

function serializeUploadedFileResult(result: UploadResult, username: string | null): Record<string, unknown> {
  const directAccess = canDirectlyAccessUploadResult(result);
  const url = directAccess ? result.publicUrl : null;
  const thumbnailUrl = result.thumbnail?.status === "ready" && result.thumbnail.filePath
    ? `${new URL(result.publicUrl).origin}${result.thumbnail.filePath}`
    : null;

  return {
    id: result.id,
    file_name: result.name,
    mime_type: result.mimeType,
    size: result.size,
    md5: result.md5,
    telegram_file_id: result.telegramFileId,
    telegram_file_unique_id: result.telegramFileUniqueId ?? null,
    telegram_channel_id: result.telegramChannelId ?? "default",
    file_path: result.filePath,
    remark: result.remark ?? null,
    url,
    download_url: url ? appendDownloadParam(url) : null,
    uploaded_by: username,
    created_at: result.createdAt,
    directory_id: result.directoryId ?? null,
    directory_path: result.directoryPath,
    storage_backend: result.storageBackend,
    chunk_size: result.storageBackend === "telegram_multipart" ? result.chunkSize ?? null : null,
    chunk_count: result.storageBackend === "telegram_multipart" ? result.chunkCount ?? null : null,
    direct_access: directAccess,
    download_strategy: downloadStrategy(result.storageBackend, directAccess),
    thumbnail_status: result.thumbnail?.status ?? "none",
    thumbnail_url: thumbnailUrl,
    thumbnail_file_id: result.thumbnail?.fileId ?? null,
    thumbnail_file_unique_id: result.thumbnail?.fileUniqueId ?? null,
    thumbnail_file_path: result.thumbnail?.filePath ?? null,
    thumbnail_mime_type: result.thumbnail?.mimeType ?? null,
    thumbnail_size: result.thumbnail?.size ?? null,
    thumbnail_width: result.thumbnail?.width ?? null,
    thumbnail_height: result.thumbnail?.height ?? null
  };
}

function serializeMultipartUploadStatus(upload: MultipartUploadRecord): Record<string, unknown> {
  return {
    id: upload.id,
    source_kind: upload.source_kind,
    file_name: upload.file_name,
    mime_type: upload.mime_type,
    size: upload.size,
    chunk_size: upload.chunk_size,
    chunk_count: upload.chunk_count,
    directory_path: upload.directory_path ?? "/",
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access: upload.chunk_count <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    thumbnail_source: null
  };
}

function missingChunkIndexes(upload: MultipartUploadRecord, chunks: FileChunkRecord[]): number[] {
  const uploaded = new Set(chunks.map((chunk) => chunk.chunk_index));
  const missing: number[] = [];

  for (let index = 0; index < upload.chunk_count; index += 1) {
    if (!uploaded.has(index)) {
      missing.push(index);
    }
  }

  return missing;
}

function fileStorageBackend(file: FileRecord): "telegram_single" | "telegram_multipart" {
  if (file.storage_backend === "telegram_multipart" || file.telegram_file_id.startsWith("multipart:")) {
    return "telegram_multipart";
  }

  return "telegram_single";
}

function canDirectlyAccessFileRecord(file: FileRecord): boolean {
  const storageBackend = fileStorageBackend(file);

  if (storageBackend === "telegram_single") {
    return true;
  }

  return Number.isSafeInteger(file.chunk_count) &&
    Number(file.chunk_count) > 0 &&
    Number(file.chunk_count) <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
}

function canDirectlyAccessUploadResult(result: UploadResult): boolean {
  if (result.storageBackend === "telegram_single") {
    return true;
  }

  return Number.isSafeInteger(result.chunkCount) &&
    Number(result.chunkCount) > 0 &&
    Number(result.chunkCount) <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
}

function canDirectlyAccessMultipartPayload(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>
): boolean {
  return payload.chunk_count <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
}

function downloadStrategy(
  storageBackend: "telegram_single" | "telegram_multipart",
  directAccess: boolean
): "direct" | "direct_or_accelerated" | "accelerated" {
  if (storageBackend === "telegram_single") {
    return "direct";
  }

  return directAccess ? "direct_or_accelerated" : "accelerated";
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

function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} is required`);
  }

  return value.trim();
}

function positiveIntegerField(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be a positive integer`);
  }

  return parsed;
}

function normalizeMimeTypeField(value: unknown): string {
  if (typeof value !== "string") {
    return "application/octet-stream";
  }

  const normalized = value.split(";")[0]?.trim().toLowerCase();
  return normalized || "application/octet-stream";
}

function parseContentRange(value: string | null): { start: number; end: number; size: number } | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    end < start ||
    size <= 0
  ) {
    return undefined;
  }

  return { start, end, size };
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

function normalizeFileNameUpdate(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "InvalidFileName", "File name must be 1-180 characters");
  }

  const normalized = sanitizeFileName(value);

  if (!normalized || normalized === "file" && value.trim().length === 0) {
    throw new AppError(400, "InvalidFileName", "File name must be 1-180 characters");
  }

  return normalized;
}

function normalizeOptionalFileName(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeFileNameUpdate(value);
}

function normalizeDirectoryName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidDirectoryName", "Directory name is required");
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 80) {
    throw new AppError(400, "InvalidDirectoryName", "Directory name must be 1-80 characters");
  }

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AppError(400, "InvalidDirectoryName", "Directory name contains unsupported characters");
  }

  return normalized;
}

function normalizeDirectoryPath(value: unknown): string {
  if (typeof value !== "string") {
    return "/";
  }

  let normalized = value.trim();

  if (!normalized) {
    return "/";
  }

  if (normalized.length > 512) {
    throw new AppError(400, "InvalidDirectoryPath", "Directory path is too long");
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/g, "");
  }

  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (
      segment.length > 80 ||
      segment !== segment.trim() ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      throw new AppError(400, "InvalidDirectoryPath", "Directory path is invalid");
    }
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

async function requireReadableDirectory(db: D1Database, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const directory = await getDirectoryRecordByPath(db, path);
  if (!directory) {
    throw new AppError(404, "DirectoryNotFound", "Directory not found");
  }

  return directory;
}

async function requireWritableDirectory(db: D1Database, path: string): Promise<DirectoryRecord | null> {
  return requireReadableDirectory(db, path);
}

async function ensureWritableDirectory(db: D1Database, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const segments = path.split("/").filter(Boolean);
  let parentPath = "/";
  let current: DirectoryRecord | null = null;

  for (const segment of segments) {
    const currentPath = parentPath === "/" ? `/${segment}` : `${parentPath}/${segment}`;
    current = await getDirectoryRecordByPath(db, currentPath);

    if (!current) {
      try {
        current = await insertDirectoryRecord({
          db,
          parentPath,
          name: segment,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.error !== "DirectoryExists") {
          throw error;
        }

        current = await getDirectoryRecordByPath(db, currentPath);
        if (!current) {
          throw error;
        }
      }
    }

    parentPath = currentPath;
  }

  return current;
}

function normalizeFileIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", "file_ids must be an array");
  }

  const ids = Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))).filter(Boolean);

  if (ids.length === 0) {
    throw new AppError(400, "InvalidBody", "file_ids must not be empty");
  }

  if (ids.length > 100) {
    throw new AppError(400, "InvalidBody", "file_ids must contain at most 100 ids");
  }

  return ids;
}

function normalizeOptionalIdList(value: unknown, fieldName: "file_ids" | "directory_ids"): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be an array`);
  }

  const ids = Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))).filter(Boolean);

  if (ids.length > 100) {
    throw new AppError(400, "InvalidBody", `${fieldName} must contain at most 100 ids`);
  }

  return ids;
}

function requireEntrySelection(fileIds: string[], directoryIds: string[]): void {
  if (fileIds.length === 0 && directoryIds.length === 0) {
    throw new AppError(400, "InvalidBody", "file_ids or directory_ids must not be empty");
  }
}

async function requireFileRecords(db: D1Database, ids: string[]): Promise<FileRecord[]> {
  const records: FileRecord[] = [];

  for (const id of ids) {
    const file = await getFileRecord(db, id);
    if (!file) {
      throw new AppError(404, "NotFound", "File record not found");
    }
    records.push(file);
  }

  return records;
}

async function requireDirectoryRecords(db: D1Database, ids: string[]): Promise<DirectoryRecord[]> {
  const records: DirectoryRecord[] = [];

  for (const id of ids) {
    const directory = await getDirectoryRecord(db, id);
    if (!directory) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }
    records.push(directory);
  }

  return records;
}

function moveTargetParentPath(body: Record<string, unknown>): string {
  if (body.new_directory_name !== undefined) {
    return normalizeDirectoryPath(body.new_directory_parent_path ?? body.parent_path ?? body.directory_path ?? "/");
  }

  return normalizeDirectoryPath(body.directory_path ?? "/");
}

function validateEntryMoveParent(directories: DirectoryRecord[], parentPath: string): void {
  for (const directory of directories) {
    if (parentPath === directory.path || parentPath.startsWith(`${directory.path}/`)) {
      throw new AppError(400, "InvalidDirectoryMove", "Cannot move a directory into itself or its subdirectory");
    }
  }
}

async function validateEntryMoveTarget(
  db: D1Database,
  directories: DirectoryRecord[],
  parentPath: string
): Promise<void> {
  for (const directory of directories) {
    validateEntryMoveParent([directory], parentPath);

    const nextPath = parentPath === "/" ? `/${directory.name}` : `${parentPath}/${directory.name}`;
    if (nextPath === directory.path) {
      continue;
    }

    const conflict = await getDirectoryRecordByPath(db, nextPath);
    if (conflict && conflict.id !== directory.id) {
      throw new AppError(409, "DirectoryExists", "Target directory already contains a directory with the same name");
    }
  }
}

async function resolveMoveTargetDirectory(db: D1Database, body: Record<string, unknown>): Promise<string> {
  if (body.new_directory_name !== undefined) {
    const parentPath = normalizeDirectoryPath(
      body.new_directory_parent_path ?? body.parent_path ?? body.directory_path ?? "/"
    );
    const name = normalizeDirectoryName(body.new_directory_name);
    const directory = await insertDirectoryRecord({
      db,
      parentPath,
      name,
      createdAt: new Date().toISOString()
    });

    return directory.path;
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
  await requireWritableDirectory(db, directoryPath);
  return directoryPath;
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

function normalizeRemarkUpdate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "remark must be a string or null");
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1000) : null;
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
  const token = extractOptionalFileToken(pathname);

  if (!token) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  return token;
}

function extractMultipartChunkAccess(pathname: string): { token: string; chunkIndex: number } | null {
  const match = /^\/f\/([^/]+)\/chunks\/([^/]+)$/.exec(pathname);

  if (!match) {
    return null;
  }

  const token = match[1];
  const chunkIndex = Number(match[2]);
  if (!token) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index must be a non-negative integer");
  }

  return {
    token,
    chunkIndex
  };
}

function extractOptionalFileToken(pathname: string): string | undefined {
  const match = /^\/f\/([^/]+)(?:\/.*)?$/.exec(pathname);

  return match?.[1];
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);

  if (value) {
    target.set(name, value);
  }
}
