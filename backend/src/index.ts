import {
  createAdminSessionCookie,
  createExpiredAdminSessionCookie,
  requireAdminSession,
  requireAdminSessionInfo,
  validateAdminCredentials
} from "./admin-auth";
import { createSignedPayload, createSignedToken, TokenError, verifySignedPayload, verifySignedToken } from "./crypto";
import {
  attachHlsSegmentMultipartUpload,
  completeHlsInitSegmentSingle,
  completeHlsAssetWithFileRecord,
  completeHlsSegmentMultipart,
  completeHlsSegmentSingle,
  completeMultipartUploadRecord,
  completeMultipartUploadWithFileRecord,
  deleteHlsAssetTempData,
  deleteStaleHlsUploadData,
  deleteStaleMultipartUploadData,
  failHlsSegment,
  failHlsInitSegment,
  findReusableMagnetImportRecord,
  getDirectoryRecord,
  getDirectoryRecordByPath,
  getDirectoryUsageStats,
  findActiveApiKeyRecord,
  findActiveFileNameConflict,
  cancelMagnetImportRecord,
  getApiKeyRecord,
  getFileChunkRecord,
  getFileRecord,
  getGlobalFileUsageStats,
  getHlsAssetRecord,
  getHlsAssetRecordByFinalFileId,
  getHlsSegmentRecordByIndex,
  getMagnetImportFileRecord,
  getMagnetImportRecord,
  getMultipartUploadRecord,
  getTelegramChannelRecord,
  getTelegramChannelUsage,
  insertDirectoryRecord,
  insertApiKeyRecord,
  insertFileRecordWithConflictAction,
  insertHlsAssetRecord,
  insertHlsSegmentRecords,
  insertMagnetImportRecord,
  insertMultipartUploadRecord,
  insertTelegramChannelRecord,
  listActiveTelegramChannelRecords,
  listAllDirectoryRecords,
  listDirectoryChildren,
  listFileChunkRecords,
  listHlsSegmentRecords,
  listApiKeyRecords,
  listFileRecords,
  listMagnetImportFileRecords,
  listMagnetImportRecordsForAria2Cleanup,
  listProtectedMagnetImportRecordsForAria2Cleanup,
  listRestartableMagnetImportRecordsBySource,
  listTelegramChannelRecords,
  markMagnetImportDoneIfComplete,
  markMagnetImportDownloaded,
  markMagnetImportDownloading,
  markMagnetImportFailed,
  markMagnetImportImporting,
  moveFileRecords,
  moveDirectoryTree,
  renameDirectoryTree,
  replaceMagnetImportFiles,
  requireDb,
  markHlsInitSegmentImporting,
  markHlsAssetStatus,
  markHlsSegmentImporting,
  softDeleteApiKeyRecord,
  deleteDirectoryTree,
  deleteFileRecord,
  DEFAULT_UPLOAD_CONCURRENCY,
  touchApiKeyRecord,
  updateApiKeyRecord,
  updateFileRecordMetadata,
  updateMagnetImportFileStatus,
  updateTelegramChannelRecord,
  upsertFileChunkRecord,
  deleteTelegramChannelRecord,
  getUploadConcurrencySetting,
  setUploadConcurrencySetting,
  selectMagnetImportFiles,
  MIN_UPLOAD_CONCURRENCY,
  MAX_UPLOAD_CONCURRENCY,
  type ApiKeyRecord,
  type ApiKeyStatus,
  type DirectoryRecord,
  type FileChunkRecord,
  type FileNameConflictAction,
  type FileRecord,
  type FileTypeFilter,
  type HlsAssetRecord,
  type HlsSegmentRecord,
  type MagnetImportFileRecord,
  type MagnetImportRecord,
  type MultipartUploadRecord,
  type TelegramChannelRecord,
  type TelegramChannelStatus,
  type ThumbnailStatus
} from "./database";
import {
  aria2AddUri,
  aria2Forget,
  aria2TellStatus,
  requireAria2Config,
  resolveAria2DownloadConfig,
  type Aria2File,
  type Aria2Status
} from "./aria2";
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
import {
  buildRewrittenMediaPlaylist,
  hlsInitSegmentFileName,
  hlsFileNameFromUrl,
  hlsMimeTypeForInitSegment,
  hlsMimeTypeForSegment,
  hlsSegmentFileName,
  parseHlsPlaylist,
  type HlsByteRange,
  type HlsInitSegmentPlan,
  type HlsMediaPlan,
  type HlsPlaylistPlan,
  type HlsSegmentEncryption,
  type HlsVariantPlan
} from "./hls";
import { extensionForMimeType, mimeTypeForFileName, resolveStoredMimeType } from "./mime";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "./telegram";
import type { AppDatabase, AppEnv } from "./runtime";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";



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
  storageBackend: "telegram_single" | "telegram_multipart" | "hls_package";
  telegramChannelId?: string;
  chunkSize?: number | null;
  chunkCount?: number | null;
  thumbnail?: UploadedThumbnailResult;
}

interface HlsProbeResult {
  playlistUrl: string;
  fileName: string;
  plan: HlsPlaylistPlan;
  media?: HlsMediaPlan;
  selectedVariantId?: string;
}

interface HlsInitResult {
  asset: HlsAssetRecord;
  segments: HlsSegmentRecord[];
}

interface HlsSegmentImportResult {
  segment: HlsSegmentRecord;
  uploadedChunks: number[];
  missingChunks: number[];
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

interface MagnetImportRefreshResult {
  importRecord: MagnetImportRecord;
  files: MagnetImportFileRecord[];
  aria2Status?: Aria2Status;
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
  upload_id?: string;
  mime_type: string;
  kind: "image" | "video";
  size: number;
  exp: number;
}

type RemoteRequestHeaders = Record<string, string>;

interface ParsedByteRange {
  start: number;
  end: number;
  partial: boolean;
}

const TELEGRAM_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TELEGRAM_MULTIPART_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_TELEGRAM_MULTIPART_CHUNKS = Math.ceil(MAX_TELEGRAM_MULTIPART_BYTES / TELEGRAM_CHUNK_SIZE_BYTES);
const DIRECT_MULTIPART_ACCESS_MAX_CHUNKS = MAX_TELEGRAM_MULTIPART_CHUNKS;
const DIRECT_MULTIPART_ACCESS_MAX_BYTES = MAX_TELEGRAM_MULTIPART_BYTES;
const DEFAULT_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24;
const MIN_STALE_MULTIPART_UPLOAD_TTL_HOURS = 1;
const MAX_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24 * 30;
const MAX_THUMBNAIL_BYTES = 512 * 1024;
const THUMBNAIL_SOURCE_TOKEN_TTL_SECONDS = 10 * 60;
const IMAGE_THUMBNAIL_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_THUMBNAIL_SOURCE_MAX_BYTES = MAX_TELEGRAM_MULTIPART_BYTES;
const VIDEO_THUMBNAIL_PROXY_DEFAULT_RANGE_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_REQUEST_HEADER_COUNT = 32;
const MAX_REMOTE_REQUEST_HEADER_NAME_BYTES = 128;
const MAX_REMOTE_REQUEST_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_REMOTE_REQUEST_HEADERS_BYTES = 16 * 1024;
const ALLOWED_THUMBNAIL_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HLS_PLAYLIST_MIME_TYPE = "application/vnd.apple.mpegurl";
const HLS_PUBLIC_ROUTE_PREFIX = "/api/hls";
const HLS_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const HLS_AES_128_KEY_BYTES = 16;
const HLS_SEGMENT_IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const HLS_PREVIEW_SEGMENT_COUNT = 4;
const ARIA2_CACHE_DIRECTORY_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error);
    }

    if (error instanceof TokenError) {
      return errorResponse(new AppError(401, "InvalidFileToken", "Invalid or tampered file token"));
    }

    console.error("Unexpected server error", error);
    return errorResponse(new AppError(500, "InternalError", "Internal server error"));
  }
}

export async function runScheduledCleanup(env: AppEnv, nowMs = Date.now(), cron = "server"): Promise<void> {
  const result = await cleanupStaleUploads(env, nowMs);

  if (
    result.deletedMultipartUploads > 0 ||
    result.deletedMultipartChunks > 0 ||
    result.deletedHlsAssets > 0 ||
    result.deletedHlsSegments > 0 ||
    result.deletedHlsUploads > 0 ||
    result.deletedHlsChunks > 0 ||
    result.deletedAria2Dirs > 0
  ) {
    console.log("Stale upload cleanup completed", {
      cron,
      expired_before: result.expiredBefore,
      deleted_multipart_uploads: result.deletedMultipartUploads,
      deleted_multipart_chunks: result.deletedMultipartChunks,
      deleted_hls_assets: result.deletedHlsAssets,
      deleted_hls_segments: result.deletedHlsSegments,
      deleted_hls_uploads: result.deletedHlsUploads,
      deleted_hls_chunks: result.deletedHlsChunks,
      deleted_aria2_dirs: result.deletedAria2Dirs,
      deleted_aria2_bytes: result.deletedAria2Bytes,
      aria2_download_bytes: result.aria2DownloadBytes,
      skipped_aria2_dirs: result.skippedAria2Dirs
    });
  }
}

async function cleanupStaleUploads(
  env: AppEnv,
  nowMs: number
): Promise<{
  expiredBefore: string;
  deletedMultipartUploads: number;
  deletedMultipartChunks: number;
  deletedHlsAssets: number;
  deletedHlsSegments: number;
  deletedHlsUploads: number;
  deletedHlsChunks: number;
  deletedAria2Dirs: number;
  deletedAria2Bytes: number;
  aria2DownloadBytes: number;
  skippedAria2Dirs: number;
}> {
  const db = requireDb(env);
  const ttlMs = parseStaleMultipartUploadTtlMs(env.STALE_MULTIPART_UPLOAD_TTL_HOURS);
  const expiredBefore = new Date(nowMs - ttlMs).toISOString();
  const [multipart, hls] = await Promise.all([
    deleteStaleMultipartUploadData(db, expiredBefore),
    deleteStaleHlsUploadData(db, expiredBefore)
  ]);
  const aria2 = await cleanupAria2DownloadCache(env, db, nowMs);

  return {
    expiredBefore,
    deletedMultipartUploads: multipart.deletedUploads,
    deletedMultipartChunks: multipart.deletedChunks,
    deletedHlsAssets: hls.deletedAssets,
    deletedHlsSegments: hls.deletedSegments,
    deletedHlsUploads: hls.deletedUploads,
    deletedHlsChunks: hls.deletedChunks,
    deletedAria2Dirs: aria2.deletedDirs,
    deletedAria2Bytes: aria2.deletedBytes,
    aria2DownloadBytes: aria2.currentBytes,
    skippedAria2Dirs: aria2.skippedDirs
  };
}

async function cleanupAria2DownloadCache(
  env: AppEnv,
  db: AppDatabase,
  nowMs: number
): Promise<{ deletedDirs: number; deletedBytes: number; currentBytes: number; skippedDirs: number }> {
  if (!env.ARIA2_DOWNLOAD_DIR?.trim() && !env.ARIA2_RPC_URL?.trim() && !env.ARIA2_RPC_SECRET?.trim()) {
    return { deletedDirs: 0, deletedBytes: 0, currentBytes: 0, skippedDirs: 0 };
  }

  const config = resolveAria2DownloadConfig(env);
  await mkdir(config.downloadDir, { recursive: true });

  const expiredBefore = new Date(nowMs - config.downloadRetentionMs).toISOString();
  const protectedRecords = await listProtectedMagnetImportRecordsForAria2Cleanup(db, expiredBefore);
  const protectedDirs = new Set(
    protectedRecords
      .map((record) => safeAria2DownloadDir(config.downloadDir, record.download_dir))
      .filter((dir): dir is string => Boolean(dir))
  );
  const staleRecords = await listMagnetImportRecordsForAria2Cleanup(db, expiredBefore);
  let deletedDirs = 0;
  let deletedBytes = 0;
  let skippedDirs = 0;
  const deletedPaths = new Set<string>();

  for (const record of staleRecords) {
    const resolvedDir = safeAria2DownloadDir(config.downloadDir, record.download_dir);
    if (!resolvedDir || protectedDirs.has(resolvedDir) || deletedPaths.has(resolvedDir)) {
      skippedDirs += 1;
      continue;
    }

    await forceRemoveAria2MagnetTaskIfConfigured(env, record);
    const result = await deleteAria2DownloadDir(config.downloadDir, resolvedDir);
    if (result.deleted) {
      deletedDirs += 1;
      deletedBytes += result.bytes;
      deletedPaths.add(resolvedDir);
      if (record.status === "downloaded") {
        await cancelMagnetImportRecord(db, record.id, new Date(nowMs).toISOString());
      }
    } else {
      skippedDirs += 1;
    }
  }

  let currentBytes = await directorySizeBytes(config.downloadDir);
  if (config.downloadMaxBytes > 0 && currentBytes > config.downloadMaxBytes) {
    const candidates = await listAria2DownloadCacheCandidates(
      config.downloadDir,
      protectedDirs,
      deletedPaths,
      nowMs - config.downloadRetentionMs
    );
    for (const candidate of candidates) {
      if (currentBytes <= config.downloadMaxBytes) {
        break;
      }

      const result = await deleteAria2DownloadDir(config.downloadDir, candidate.path);
      if (result.deleted) {
        deletedDirs += 1;
        deletedBytes += result.bytes;
        currentBytes = Math.max(0, currentBytes - result.bytes);
        deletedPaths.add(candidate.path);
      } else {
        skippedDirs += 1;
      }
    }
  }

  return {
    deletedDirs,
    deletedBytes,
    currentBytes,
    skippedDirs
  };
}


async function cleanupStaleMultipartUploads(
  env: AppEnv,
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

function isReadRequest(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

async function routeRequest(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withSecurityHeaders() });
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

  if (url.pathname === "/api/admin/settings") {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminSettings(request, env));
  }

  if (url.pathname === "/api/v1/files" || url.pathname.startsWith("/api/v1/files/")) {
    return handleApiFiles(request, env);
  }

  if (url.pathname === "/api/v1/uploads" || url.pathname.startsWith("/api/v1/uploads/")) {
    return handleApiMultipartUploads(request, env);
  }

  if (isReadRequest(request) && url.pathname.startsWith("/f/")) {
    return handleFileAccess(request, env);
  }

  if (isReadRequest(request) && (url.pathname.startsWith("/hls/") || url.pathname.startsWith(`${HLS_PUBLIC_ROUTE_PREFIX}/`))) {
    return handleHlsAccess(request, env);
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return errorResponse(new AppError(404, "NotFound", "Route not found"));
  }

  if (url.pathname === "/f" || url.pathname === "/hls" || url.pathname.startsWith("/f/") || url.pathname.startsWith("/hls/")) {
    return errorResponse(new AppError(404, "NotFound", "Route not found"));
  }

  if (isReadRequest(request) && env.STATIC_ASSETS) {
    return env.STATIC_ASSETS.fetch(request);
  }

  return errorResponse(new AppError(404, "NotFound", "Route not found"));
}

async function handleApiFiles(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);
  await requireUploadApiKey(request, db);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/v1/files") {
    const { file, directoryPath, conflictAction } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    await requireFileNameWritable({
      db,
      directoryPath,
      fileName: sanitizeFileName(file.name),
      conflictAction
    });
    const result = await uploadAndRecordFile({
      request,
      env,
      file,
      db,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction
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
      file: await serializeFileRecord(file, getPublicBaseUrl(request, env), db)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "API file route not found"));
}

async function handleAdminLogin(request: Request, env: AppEnv): Promise<Response> {
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

async function handleAdminLogout(request: Request, env: AppEnv): Promise<Response> {
  await requireAdminSession(request, env);

  return jsonResponse(
    { ok: true },
    200,
    { "Set-Cookie": createExpiredAdminSessionCookie(request.url) }
  );
}

async function handleAuthenticatedAdminRequest(
  request: Request,
  env: AppEnv,
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

async function handleAdminSession(request: Request, env: AppEnv, username: string): Promise<Response> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const baseUrl = getPublicBaseUrl(request, env);
  const uploadConcurrency = env.DATABASE
    ? await getUploadConcurrencySetting(env.DATABASE)
    : DEFAULT_UPLOAD_CONCURRENCY;

  return jsonResponse({
    ok: true,
    username,
    max_file_bytes: maxFileBytes,
    multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    upload_concurrency: uploadConcurrency,
    upload_concurrency_min: MIN_UPLOAD_CONCURRENCY,
    upload_concurrency_max: MAX_UPLOAD_CONCURRENCY,
    base_url: baseUrl,
    config: {
      database: Boolean(env.DATABASE),
      telegram_bot_token: hasEnvValue(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: hasEnvValue(env.TELEGRAM_STORAGE_CHAT_ID),
      telegram_channels: Boolean(env.DATABASE),
      tg_channel_secret: hasEnvValue(env.TG_CHANNEL_SECRET || env.LINK_SIGNING_SECRET),
      link_signing_secret: hasEnvValue(env.LINK_SIGNING_SECRET),
      admin_username: hasEnvValue(env.ADMIN_USERNAME),
      admin_password: hasEnvValue(env.ADMIN_PASSWORD),
      admin_session_secret: hasEnvValue(env.ADMIN_SESSION_SECRET)
    },
    config_values: {
      database: env.DATABASE ? "已连接" : "未连接",
      telegram_bot_token: maskSecret(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: env.TELEGRAM_STORAGE_CHAT_ID?.trim() || "未配置",
      telegram_channels: env.DATABASE ? "设置页可配置" : "需要 SQLite 数据库",
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

async function handleAdminSettings(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const uploadConcurrency = positiveIntegerField(body.upload_concurrency, "upload_concurrency");
    const savedUploadConcurrency = await setUploadConcurrencySetting(db, uploadConcurrency, new Date().toISOString());
    return jsonResponse({
      ok: true,
      settings: {
        upload_concurrency: savedUploadConcurrency,
        upload_concurrency_min: MIN_UPLOAD_CONCURRENCY,
        upload_concurrency_max: MAX_UPLOAD_CONCURRENCY
      }
    });
  }

  return errorResponse(new AppError(405, "MethodNotAllowed", "Unsupported settings method"));
}

async function handleAdminFiles(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/files") {
    const listAll = url.searchParams.get("all") === "1" || url.searchParams.get("limit") === "all";
    const page = parsePositiveInteger(url.searchParams.get("page"), 1, 1, 100000);
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 24, 1, 100000);
    const type = normalizeFileTypeFilter(url.searchParams.get("type"));
    const createdFrom = normalizeDateTimeParam(url.searchParams.get("created_from"), "created_from");
    const createdTo = normalizeDateTimeParam(url.searchParams.get("created_to"), "created_to");
    const directoryPath = normalizeDirectoryPath(url.searchParams.get("dir") || "/");
    const currentDirectory = await requireReadableDirectory(db, directoryPath);
    const normalizedQuery = url.searchParams.get("q") || "";
    const queryParams = {
      db,
      query: normalizedQuery,
      directoryPath,
      ...(type ? { type } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {})
    };
    const result = listAll
      ? await listFileRecords(queryParams)
      : await listFileRecords({ ...queryParams, page, limit });
    const [directories, globalStats] = await Promise.all([
      listDirectoryChildren(db, directoryPath),
      getGlobalFileUsageStats(db)
    ]);
    const directoryStats = await getDirectoryUsageStats(db, directories);
    const baseUrl = getPublicBaseUrl(request, env);
    const files = await Promise.all(result.files.map((file) => serializeFileRecord(file, baseUrl, db)));

    return jsonResponse({
      ok: true,
      current_directory: serializeCurrentDirectory(currentDirectory, directoryPath),
      directories: directories.map((directory) => serializeDirectoryRecord(directory, directoryStats.get(directory.path))),
      search_scope: "current",
      files,
      pagination: {
        page: listAll ? 1 : page,
        limit: listAll ? result.total : limit,
        total: result.total,
        total_pages: listAll ? 1 : Math.max(1, Math.ceil(result.total / limit))
      },
      global_stats: globalStats,
      max_file_bytes: parseMaxFileBytes(env.MAX_FILE_BYTES),
      multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
      max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
      direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
      direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
    });
  }

  const hlsDownloadMatch = /^\/api\/admin\/files\/([^/]+)\/hls-download$/.exec(url.pathname);
  if (request.method === "GET" && hlsDownloadMatch?.[1]) {
    const file = await requireFileRecord(db, decodeURIComponent(hlsDownloadMatch[1]));

    return jsonResponse({
      ok: true,
      hls_download: await serializeHlsDownloadPlanForFile({
        request,
        env,
        db,
        file
      })
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/files") {
    const { file: formFile, remark, directoryPath, conflictAction } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    await requireFileNameWritable({
      db,
      directoryPath,
      fileName: sanitizeFileName(formFile.name),
      conflictAction
    });
    const result = await uploadAndRecordFile({
      request,
      env,
      file: formFile,
      db,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
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
      file: await serializeFileRecord(updated, getPublicBaseUrl(request, env), db)
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

async function handleAdminDirectories(request: Request, env: AppEnv): Promise<Response> {
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

async function handleAdminEntries(request: Request, env: AppEnv): Promise<Response> {
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

async function handleAdminMultipartUploads(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (url.pathname === "/api/admin/uploads/hls" || url.pathname.startsWith("/api/admin/uploads/hls/")) {
    return handleAdminHlsUploads(request, env, username);
  }

  if (url.pathname === "/api/admin/uploads/magnet" || url.pathname.startsWith("/api/admin/uploads/magnet/")) {
    return handleAdminMagnetUploads(request, env, username);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/preflight") {
    const body = await readJsonObject(request);
    const entries = normalizeUploadPreflightEntries(body.entries);
    const checked = await preflightUploadEntries(db, entries);
    const conflictCount = checked.filter((entry) => entry.status === "conflict").length;

    return jsonResponse({
      ok: true,
      entries: checked,
      summary: {
        total: checked.length,
        ready: checked.length - conflictCount,
        conflicts: conflictCount
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/init") {
    const body = await readJsonObject(request);
    const fileName = sanitizeFileName(stringField(body.file_name, "file_name"));
    const mimeType = normalizeMimeTypeField(body.mime_type);
    const size = positiveIntegerField(body.size, "size");
    const remark = normalizeRemark(body.remark) ?? null;
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
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
      conflictAction,
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
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
    const remark = normalizeRemark(body.remark) ?? null;
    const fileNameOverride = normalizeOptionalFileName(body.file_name);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES), {
      forceMultipart: true,
      ...(sourceHeaders ? { sourceHeaders } : {})
    });

    if (probe.mode === "single") {
      throw new AppError(500, "InternalError", "Forced URL multipart probe returned single mode");
    }

    const sourceHeadersJson = remoteRequestHeadersJson(sourceHeaders);
    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      ...(sourceHeadersJson ? { sourceHeadersJson } : {}),
      fileName: fileNameOverride ?? probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(remark ? { remark } : {})
    });
    const thumbnailSource = await createThumbnailSourceInfo({
      request,
      env,
      uploadId: result.id,
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
    const completeInput = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload,
      conflictAction: completeInput.conflictAction,
      ...(completeInput.thumbnail ? { thumbnail: completeInput.thumbnail } : {})
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

async function handleAdminHlsUploads(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/hls/probe") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
    const variantId = optionalTrimmedString(body.variant_id, 80);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const result = await probeHlsSource(sourceUrl, variantId, sourceHeaders);
    return jsonResponse({ ok: true, hls: serializeHlsProbeResult(result) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/hls/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createHlsUpload({
      db,
      sourceUrl,
      ...(sourceHeaders ? { sourceHeaders } : {}),
      selectedVariantId: optionalTrimmedString(body.variant_id, 80),
      fileNameOverride: normalizeOptionalFileName(body.file_name),
      conflictAction: normalizeFileNameConflictAction(body.on_conflict),
      remark: normalizeRemark(body.remark),
      uploadedBy: username,
      directoryId: directory?.id ?? null,
      directoryPath
    });

    return jsonResponse({
      ok: true,
      hls: await serializeHlsUploadResult(db, request, env, result)
    }, 201);
  }

  const statusMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const asset = await requireHlsAsset(db, decodeURIComponent(statusMatch[1]));
    const segments = await listHlsSegmentRecords(db, asset.id);

    return jsonResponse({
      ok: true,
      hls: await serializeHlsUploadResult(db, request, env, { asset, segments })
    });
  }

  const previewPlaylistMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/preview\.m3u8$/.exec(url.pathname);
  if (request.method === "GET" && previewPlaylistMatch?.[1]) {
    return handleAdminHlsPreviewPlaylist(request, env, decodeURIComponent(previewPlaylistMatch[1]));
  }

  const previewInitMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/preview-init(?:\/[^/]+)?$/.exec(url.pathname);
  if (request.method === "GET" && previewInitMatch?.[1]) {
    const asset = await requireHlsAsset(db, decodeURIComponent(previewInitMatch[1]));
    return serveStoredHlsInitSegment({
      env,
      db,
      asset,
      rangeHeader: request.headers.get("Range"),
      forceDownload: false
    });
  }

  const previewSegmentMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/preview-segments\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && previewSegmentMatch?.[1] && previewSegmentMatch?.[2]) {
    const asset = await requireHlsAsset(db, decodeURIComponent(previewSegmentMatch[1]));
    const segment = await requireHlsSegment(db, asset.id, normalizeHlsSegmentIndex(previewSegmentMatch[2], asset.segment_count));
    return serveStoredHlsSegment({
      env,
      db,
      segment,
      rangeHeader: request.headers.get("Range"),
      forceDownload: false
    });
  }

  const segmentImportMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/segments\/(\d+)\/import$/.exec(url.pathname);
  if (request.method === "POST" && segmentImportMatch?.[1] && segmentImportMatch?.[2]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(segmentImportMatch[1]));
    const segmentIndex = normalizeHlsSegmentIndex(segmentImportMatch[2], asset.segment_count);
    const result = await importHlsSegment({
      env,
      db,
      asset,
      segmentIndex
    });

    return jsonResponse({
      ok: true,
      segment: await serializeHlsSegment(db, result.segment),
      uploaded_chunks: result.uploadedChunks,
      missing_chunks: result.missingChunks
    });
  }

  const segmentChunkMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/segments\/(\d+)\/chunks\/(\d+)\/import$/.exec(url.pathname);
  if (request.method === "POST" && segmentChunkMatch?.[1] && segmentChunkMatch?.[2] && segmentChunkMatch?.[3]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(segmentChunkMatch[1]));
    const segmentIndex = normalizeHlsSegmentIndex(segmentChunkMatch[2], asset.segment_count);
    const result = await importHlsSegmentChunk({
      env,
      db,
      asset,
      segmentIndex,
      chunkIndexValue: segmentChunkMatch[3]
    });

    return jsonResponse({
      ok: true,
      segment: await serializeHlsSegment(db, result.segment),
      uploaded_chunks: result.uploadedChunks,
      missing_chunks: result.missingChunks
    });
  }

  const segmentCompleteMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/segments\/(\d+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && segmentCompleteMatch?.[1] && segmentCompleteMatch?.[2]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(segmentCompleteMatch[1]));
    const segmentIndex = normalizeHlsSegmentIndex(segmentCompleteMatch[2], asset.segment_count);
    const result = await completeHlsMultipartSegment({
      db,
      asset,
      segmentIndex
    });

    return jsonResponse({
      ok: true,
      segment: await serializeHlsSegment(db, result.segment),
      uploaded_chunks: result.uploadedChunks,
      missing_chunks: result.missingChunks
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const asset = await requireMutableHlsAsset(db, decodeURIComponent(completeMatch[1]));
    const completeInput = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeHlsUpload({
      request,
      env,
      db,
      asset,
      conflictAction: completeInput.conflictAction,
      ...(completeInput.thumbnail ? { thumbnail: completeInput.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  const deleteMatch = /^\/api\/admin\/uploads\/hls\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const cleanup = await deleteHlsAssetTempData(db, decodeURIComponent(deleteMatch[1]));
    return jsonResponse({ ok: true, cleanup });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin HLS upload route not found"));
}

async function handleAdminMagnetUploads(request: Request, env: AppEnv, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/magnet/probe") {
    const body = await readJsonObject(request);
    const magnetUri = normalizeMagnetUri(body.magnet ?? body.url);
    const result = await createMagnetImport({
      env,
      db,
      magnetUri,
      uploadedBy: username
    });

    return jsonResponse({
      ok: true,
      magnet: serializeMagnetImport(result.importRecord, result.files, result.aria2Status)
    }, 201);
  }

  const statusMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === "GET" && statusMatch?.[1]) {
    const result = await refreshMagnetImportStatus(env, db, decodeURIComponent(statusMatch[1]));
    return jsonResponse({
      ok: true,
      magnet: serializeMagnetImport(result.importRecord, result.files, result.aria2Status)
    });
  }

  const initMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/init$/.exec(url.pathname);
  if (request.method === "POST" && initMatch?.[1]) {
    const body = await readJsonObject(request);
    const importId = decodeURIComponent(initMatch[1]);
    const fileIndexes = normalizeMagnetFileIndexes(body.file_indexes ?? body.files);
    const fileOptions = normalizeMagnetFileUploadOptions(body.file_options, fileIndexes);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const remark = normalizeRemark(body.remark) ?? null;
    const result = await initMagnetImportSelection({
      env,
      db,
      importId,
      fileIndexes,
      fileOptions,
      directoryPath,
      conflictAction,
      remark,
      uploadedBy: username
    });

    return jsonResponse({
      ok: true,
      magnet: serializeMagnetImport(result.importRecord, result.files, result.aria2Status),
      uploads: result.uploads
    });
  }

  const thumbnailSourceMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/files\/(\d+)\/thumbnail-source$/.exec(url.pathname);
  if (request.method === "GET" && thumbnailSourceMatch?.[1] && thumbnailSourceMatch?.[2]) {
    return serveMagnetThumbnailSource({
      request,
      env,
      db,
      importId: decodeURIComponent(thumbnailSourceMatch[1]),
      fileIndex: parseMagnetFileIndex(thumbnailSourceMatch[2])
    });
  }

  const chunkMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/files\/(\d+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2] && chunkMatch?.[3]) {
    const importId = decodeURIComponent(chunkMatch[1]);
    const fileIndex = parseMagnetFileIndex(chunkMatch[2]);
    const chunkIndex = Number(chunkMatch[3]);
    const result = await importMagnetFileChunk({
      env,
      db,
      importId,
      fileIndex,
      chunkIndex
    });

    return jsonResponse({
      ok: true,
      chunk: serializeChunk(result.record),
      uploaded_chunks: (await listFileChunkRecords(db, result.upload.id)).length
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)\/files\/(\d+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1] && completeMatch?.[2]) {
    const importId = decodeURIComponent(completeMatch[1]);
    const fileIndex = parseMagnetFileIndex(completeMatch[2]);
    const input = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeMagnetFileUpload({
      request,
      env,
      db,
      importId,
      fileIndex,
      conflictAction: input.conflictAction,
      ...(input.thumbnail ? { thumbnail: input.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  const deleteMatch = /^\/api\/admin\/uploads\/magnet\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const importId = decodeURIComponent(deleteMatch[1]);
    const record = await requireMagnetImport(db, importId);
    const config = requireAria2Config(env);
    await forgetAria2MagnetTask(config, record);
    await cancelMagnetImportRecord(db, importId, new Date().toISOString());
    const cleanup = await deleteMagnetImportDownloadDir(config, record);
    return jsonResponse({ ok: true, cleanup });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin magnet upload route not found"));
}

async function createMagnetImport(params: {
  env: AppEnv;
  db: AppDatabase;
  magnetUri: string;
  uploadedBy: string;
}): Promise<MagnetImportRefreshResult> {
  const config = requireAria2Config(params.env);
  const infoHash = magnetInfoHash(params.magnetUri);
  const reusable = await findReusableMagnetImportRecord(params.db, params.magnetUri, infoHash);
  if (reusable) {
    return reusable.status === "probing"
      ? waitForMagnetMetadata(params.env, params.db, reusable.id)
      : refreshMagnetImportStatus(params.env, params.db, reusable.id);
  }

  await cleanupRestartableMagnetImportsBySource(params.env, params.db, params.magnetUri, infoHash);
  await ensureAria2DownloadCapacity({
    env: params.env,
    db: params.db,
    additionalBytes: 0
  });

  const id = crypto.randomUUID();
  const downloadDir = magnetDownloadDir(config.downloadDir, id);
  await mkdir(downloadDir, { recursive: true });
  const gid = await aria2AddUri(config, [params.magnetUri], aria2MagnetOptions(config, {
    dir: downloadDir,
    "bt-metadata-only": "true",
    "bt-save-metadata": "true",
    "follow-torrent": "false",
    "seed-time": "0"
  }));
  const now = new Date().toISOString();
  const importRecord = await insertMagnetImportRecord(params.db, {
    id,
    magnetUri: params.magnetUri,
    infoHash,
    aria2MetadataGid: gid,
    downloadDir,
    uploadedBy: params.uploadedBy,
    createdAt: now,
    updatedAt: now
  });

  return waitForMagnetMetadata(params.env, params.db, importRecord.id);
}

async function waitForMagnetMetadata(
  env: AppEnv,
  db: AppDatabase,
  importId: string
): Promise<MagnetImportRefreshResult> {
  const config = requireAria2Config(env);
  const deadline = Date.now() + config.metadataTimeoutMs;
  let result = await refreshMagnetImportStatus(env, db, importId);

  while (result.importRecord.status === "probing" && Date.now() < deadline) {
    await delay(900);
    result = await refreshMagnetImportStatus(env, db, importId);
  }

  return result;
}

async function refreshMagnetImportStatus(
  env: AppEnv,
  db: AppDatabase,
  importId: string
): Promise<MagnetImportRefreshResult> {
  const config = requireAria2Config(env);
  let importRecord = await requireMagnetImport(db, importId);
  let aria2Status: Aria2Status | undefined;

  if (importRecord.status === "probing" && importRecord.aria2_metadata_gid) {
    const status = await tellAria2StatusFollowing(config, importRecord.aria2_metadata_gid);
    aria2Status = status;
    await refreshMagnetMetadataFromStatus(db, importRecord, status);
    importRecord = await requireMagnetImport(db, importId);
  }

  if (
    (importRecord.status === "downloading" || importRecord.status === "importing") &&
    importRecord.aria2_download_gid
  ) {
    const status = await tellAria2StatusFollowing(config, importRecord.aria2_download_gid);
    aria2Status = status;
    if (status.status === "complete") {
      await markMagnetImportDownloaded(db, importRecord.id, new Date().toISOString());
      importRecord = await requireMagnetImport(db, importId);
    } else if (status.status === "error" || status.status === "removed") {
      await markMagnetImportFailed(db, importRecord.id, status.errorMessage || "aria2 下载磁力文件失败", new Date().toISOString());
      importRecord = await requireMagnetImport(db, importId);
    }
  }

  return {
    importRecord,
    files: await listMagnetImportFileRecords(db, importRecord.id),
    ...(aria2Status ? { aria2Status } : {})
  };
}

function aria2MagnetOptions(config: ReturnType<typeof requireAria2Config>, options: Record<string, string>): Record<string, string> {
  return config.btTrackers
    ? { ...options, "bt-tracker": config.btTrackers }
    : options;
}

async function cleanupRestartableMagnetImportsBySource(
  env: AppEnv,
  db: AppDatabase,
  magnetUri: string,
  infoHash: string | null
): Promise<void> {
  const records = await listRestartableMagnetImportRecordsBySource(db, magnetUri, infoHash);
  if (records.length === 0) {
    return;
  }

  const config = requireAria2Config(env);
  for (const record of records) {
    await forgetAria2MagnetTask(config, record);
    await deleteMagnetImportDownloadDir(config, record);
  }
}

async function forgetAria2MagnetTask(config: ReturnType<typeof requireAria2Config>, record: MagnetImportRecord): Promise<void> {
  for (const gid of [record.aria2_metadata_gid, record.aria2_download_gid]) {
    if (!gid) continue;
    await aria2Forget(config, gid).catch((error) => {
      console.warn("Failed to forget aria2 magnet task", {
        import_id: record.id,
        gid,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

async function refreshMagnetMetadataFromStatus(
  db: AppDatabase,
  importRecord: MagnetImportRecord,
  status: Aria2Status
): Promise<void> {
  if (status.status === "error" || status.status === "removed") {
    await markMagnetImportFailed(db, importRecord.id, status.errorMessage || "aria2 获取磁力元数据失败", new Date().toISOString());
    return;
  }

  const files = magnetFilesFromAria2Status(status, importRecord.download_dir);
  if (files.length === 0 && status.status === "complete") {
    const torrentFiles = await loadMagnetFilesFromSavedTorrent(importRecord.download_dir);
    if (torrentFiles && torrentFiles.length > 0) {
      const now = new Date().toISOString();
      await replaceMagnetImportFiles(
        db,
        importRecord.id,
        torrentFiles.map((file) => ({
          id: crypto.randomUUID(),
          importId: importRecord.id,
          fileIndex: file.fileIndex,
          path: file.relativePath,
          fileName: file.fileName,
          relativeDirectoryPath: file.relativeDirectoryPath,
          size: file.size,
          mimeType: file.mimeType,
          chunkSize: TELEGRAM_CHUNK_SIZE_BYTES,
          chunkCount: Math.ceil(file.size / TELEGRAM_CHUNK_SIZE_BYTES),
          createdAt: now,
          updatedAt: now
        })),
        {
          infoHash: magnetInfoHash(importRecord.magnet_uri),
          name: status.bittorrent?.info?.name ?? null,
          totalSize: torrentFiles.reduce((total, file) => total + file.size, 0),
          updatedAt: now
        }
      );
    }
    return;
  }
  if (files.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  await replaceMagnetImportFiles(
    db,
    importRecord.id,
    files.map((file) => ({
      id: crypto.randomUUID(),
      importId: importRecord.id,
      fileIndex: file.fileIndex,
      path: file.relativePath,
      fileName: file.fileName,
      relativeDirectoryPath: file.relativeDirectoryPath,
      size: file.size,
      mimeType: file.mimeType,
      chunkSize: TELEGRAM_CHUNK_SIZE_BYTES,
      chunkCount: Math.ceil(file.size / TELEGRAM_CHUNK_SIZE_BYTES),
      createdAt: now,
      updatedAt: now
    })),
    {
      infoHash: magnetInfoHash(importRecord.magnet_uri),
      name: status.bittorrent?.info?.name ?? null,
      totalSize: files.reduce((total, file) => total + file.size, 0),
      updatedAt: now
    }
  );
}

interface MagnetFileUploadOption {
  fileName?: string;
  conflictAction?: FileNameConflictAction;
}

interface MagnetImportSelectionParams {
  env: AppEnv;
  db: AppDatabase;
  importId: string;
  fileIndexes: number[];
  fileOptions: Map<number, MagnetFileUploadOption>;
  directoryPath: string;
  conflictAction: FileNameConflictAction;
  remark: string | null;
  uploadedBy: string;
}

async function initMagnetImportSelection(params: MagnetImportSelectionParams): Promise<MagnetImportRefreshResult & {
  uploads: Array<{ file_index: number; upload: Record<string, unknown>; target_directory_path: string }>;
}> {
  const refreshed = await refreshMagnetImportStatus(params.env, params.db, params.importId);
  const importRecord = refreshed.importRecord;
  if (isInitializedMagnetImportStatus(importRecord.status)) {
    return resumeInitializedMagnetImportSelection(params, refreshed);
  }

  if (importRecord.status !== "ready") {
    throw new AppError(409, "MagnetMetadataNotReady", "磁力链接文件列表尚未解析完成");
  }

  const selectedSet = new Set(params.fileIndexes);
  const files = refreshed.files.filter((file) => selectedSet.has(file.file_index));
  if (files.length !== selectedSet.size) {
    throw new AppError(400, "InvalidMagnetFileSelection", "选择的磁力文件不存在");
  }

  await ensureAria2DownloadCapacity({
    env: params.env,
    db: params.db,
    additionalBytes: files.reduce((total, file) => total + file.size, 0)
  });

  const uploadByFileIndex = new Map<number, string>();
  const uploads: Array<{ file_index: number; upload: Record<string, unknown>; target_directory_path: string }> = [];
  for (const file of files) {
    validateMultipartFileSize(file.size);
    const fileOption = params.fileOptions.get(file.file_index);
    const targetFileName = fileOption?.fileName ?? file.file_name;
    const targetConflictAction = fileOption?.conflictAction ?? params.conflictAction;
    const targetDirectoryPath = targetDirectoryForMagnetFile(params.directoryPath, file);
    const directory = await ensureWritableDirectory(params.db, targetDirectoryPath);
    const upload = await createMultipartUpload({
      db: params.db,
      sourceKind: "magnet",
      sourceUrl: importRecord.magnet_uri,
      fileName: targetFileName,
      mimeType: file.mime_type,
      size: file.size,
      uploadedBy: params.uploadedBy,
      directoryId: directory?.id ?? null,
      directoryPath: targetDirectoryPath,
      conflictAction: targetConflictAction,
      ...(params.remark ? { remark: params.remark } : {})
    });
    uploadByFileIndex.set(file.file_index, upload.id);
    uploads.push({
      file_index: file.file_index,
      upload: serializeMultipartInit(upload),
      target_directory_path: targetDirectoryPath
    });
  }

  const config = requireAria2Config(params.env);
  if (importRecord.aria2_metadata_gid) {
    await aria2Forget(config, importRecord.aria2_metadata_gid);
  }

  const gid = await aria2AddUri(config, [importRecord.magnet_uri], aria2MagnetOptions(config, {
    dir: importRecord.download_dir,
    "select-file": params.fileIndexes.join(","),
    "bt-save-metadata": "true",
    "seed-time": "0",
    "max-upload-limit": "64K"
  }));
  const now = new Date().toISOString();
  await selectMagnetImportFiles({
    db: params.db,
    importId: importRecord.id,
    fileIndexes: params.fileIndexes,
    uploadByFileIndex,
    updatedAt: now
  });
  await markMagnetImportDownloading({
    db: params.db,
    id: importRecord.id,
    aria2DownloadGid: gid,
    selectedIndexesJson: JSON.stringify(params.fileIndexes),
    updatedAt: now
  });

  return {
    importRecord: await requireMagnetImport(params.db, importRecord.id),
    files: await listMagnetImportFileRecords(params.db, importRecord.id),
    uploads
  };
}

async function resumeInitializedMagnetImportSelection(
  params: MagnetImportSelectionParams,
  refreshed: MagnetImportRefreshResult
): Promise<MagnetImportRefreshResult & {
  uploads: Array<{ file_index: number; upload: Record<string, unknown>; target_directory_path: string }>;
}> {
  const existingIndexes = selectedMagnetFileIndexes(refreshed.importRecord, refreshed.files);
  if (!sameNumberSet(existingIndexes, params.fileIndexes)) {
    throw new AppError(409, "MagnetImportAlreadyStarted", "磁力任务已经开始下载，不能更改文件选择", {
      selected_indexes: existingIndexes
    });
  }

  const selectedSet = new Set(params.fileIndexes);
  const files = refreshed.files.filter((file) => selectedSet.has(file.file_index));
  if (files.length !== selectedSet.size) {
    throw new AppError(400, "InvalidMagnetFileSelection", "选择的磁力文件不存在");
  }

  const uploads: Array<{ file_index: number; upload: Record<string, unknown>; target_directory_path: string }> = [];
  for (const file of files) {
    if (!file.upload_id || file.selected !== 1) {
      throw new AppError(409, "MagnetUploadSessionMissing", "磁力任务缺少可恢复的上传会话，请取消后重新开始");
    }

    const upload = await requireMultipartUpload(params.db, file.upload_id, "magnet");
    uploads.push({
      file_index: file.file_index,
      upload: serializeMultipartInit(multipartInitResultFromUploadRecord(upload)),
      target_directory_path: upload.directory_path ?? targetDirectoryForMagnetFile(params.directoryPath, file)
    });
  }

  return {
    ...refreshed,
    uploads
  };
}

function isInitializedMagnetImportStatus(status: MagnetImportRecord["status"]): boolean {
  return status === "downloading" || status === "downloaded" || status === "importing" || status === "done";
}

function selectedMagnetFileIndexes(record: MagnetImportRecord, files: MagnetImportFileRecord[]): number[] {
  const fromRecord = parseSelectedMagnetIndexes(record.selected_indexes_json);
  if (fromRecord.length > 0) {
    return fromRecord;
  }

  return files
    .filter((file) => file.selected === 1)
    .map((file) => file.file_index)
    .sort((left, right) => left - right);
}

function parseSelectedMagnetIndexes(value: string | null): number[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return Array.from(new Set(parsed.map((item) => Number(item))))
      .filter((item) => Number.isSafeInteger(item) && item > 0)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function sameNumberSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort((a, b) => a - b);
  const normalizedRight = [...right].sort((a, b) => a - b);
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

async function importMagnetFileChunk(params: {
  env: AppEnv;
  db: AppDatabase;
  importId: string;
  fileIndex: number;
  chunkIndex: number;
}): Promise<{ record: Awaited<ReturnType<typeof uploadChunkToTelegram>>; upload: MultipartUploadRecord }> {
  const refreshed = await refreshMagnetImportStatus(params.env, params.db, params.importId);
  if (refreshed.importRecord.status !== "downloaded" && refreshed.importRecord.status !== "importing") {
    throw new AppError(409, "MagnetDownloadNotReady", "磁力文件尚未下载完成，暂不能导入分片");
  }

  const file = await requireMagnetImportFile(params.db, params.importId, params.fileIndex);
  if (!file.upload_id || file.selected !== 1) {
    throw new AppError(400, "MagnetFileNotSelected", "磁力文件尚未初始化上传会话");
  }

  const upload = await requireMultipartUpload(params.db, file.upload_id, "magnet");
  const chunkIndex = normalizeChunkIndex(String(params.chunkIndex), upload);
  await markMagnetImportImporting(params.db, params.importId, new Date().toISOString());
  await updateMagnetImportFileStatus({
    db: params.db,
    importId: params.importId,
    fileIndex: params.fileIndex,
    status: "uploading",
    updatedAt: new Date().toISOString()
  });

  try {
    const chunk = await readMagnetFileChunk(refreshed.importRecord, file, upload, chunkIndex);
    const record = await uploadChunkToTelegram({
      env: params.env,
      db: params.db,
      upload,
      chunk,
      chunkIndex
    });
    await upsertFileChunkRecord(params.db, record);
    return { record, upload };
  } catch (error) {
    await updateMagnetImportFileStatus({
      db: params.db,
      importId: params.importId,
      fileIndex: params.fileIndex,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "磁力文件分片导入失败",
      updatedAt: new Date().toISOString()
    });
    throw error;
  }
}

async function completeMagnetFileUpload(params: {
  request: Request;
  env: AppEnv;
  db: AppDatabase;
  importId: string;
  fileIndex: number;
  conflictAction?: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
}): Promise<UploadResult> {
  const file = await requireMagnetImportFile(params.db, params.importId, params.fileIndex);
  if (!file.upload_id || file.selected !== 1) {
    throw new AppError(400, "MagnetFileNotSelected", "磁力文件尚未初始化上传会话");
  }

  const upload = await requireMultipartUpload(params.db, file.upload_id, "magnet");
  const result = await completeMultipartUpload({
    request: params.request,
    env: params.env,
    db: params.db,
    upload,
    ...(params.conflictAction ? { conflictAction: params.conflictAction } : {}),
    ...(params.thumbnail ? { thumbnail: params.thumbnail } : {})
  });
  const now = new Date().toISOString();
  await updateMagnetImportFileStatus({
    db: params.db,
    importId: params.importId,
    fileIndex: params.fileIndex,
    status: "done",
    updatedAt: now
  });
  await markMagnetImportDoneIfComplete(params.db, params.importId, now);
  const latest = await requireMagnetImport(params.db, params.importId);
  if (latest.status === "done") {
    const config = requireAria2Config(params.env);
    await forgetAria2MagnetTask(config, latest);
    await deleteMagnetImportDownloadDir(config, latest);
  }
  return result;
}

async function tellAria2StatusFollowing(config: ReturnType<typeof requireAria2Config>, gid: string): Promise<Aria2Status> {
  const status = await aria2TellStatus(config, gid);
  const followedBy = status.followedBy?.[0];
  if (followedBy) {
    return aria2TellStatus(config, followedBy);
  }
  return status;
}

function magnetFilesFromAria2Status(status: Aria2Status, downloadDir: string): Array<{
  fileIndex: number;
  relativePath: string;
  fileName: string;
  relativeDirectoryPath: string | null;
  size: number;
  mimeType: string;
}> {
  const files = status.files ?? [];
  return files
    .map((file) => magnetFileFromAria2File(file, downloadDir))
    .filter((file): file is NonNullable<ReturnType<typeof magnetFileFromAria2File>> => Boolean(file));
}

function magnetFileFromAria2File(file: Aria2File, downloadDir: string): {
  fileIndex: number;
  relativePath: string;
  fileName: string;
  relativeDirectoryPath: string | null;
  size: number;
  mimeType: string;
} | null {
  const fileIndex = Number(file.index);
  const size = Number(file.length);
  if (!Number.isSafeInteger(fileIndex) || fileIndex <= 0 || !Number.isSafeInteger(size) || size <= 0) {
    return null;
  }

  const sourcePath = file.path || "";
  const rawRelativePath = path.isAbsolute(sourcePath) ? path.relative(downloadDir, sourcePath) : sourcePath;
  const relativePath = normalizeTorrentRelativePath(rawRelativePath);
  if (!relativePath || relativePath.endsWith(".torrent")) {
    return null;
  }

  const segments = relativePath.split("/").filter(Boolean);
  const rawFileName = segments.at(-1) ?? "";
  if (isAria2MetadataPlaceholderFile(rawFileName)) {
    return null;
  }

  const fileName = sanitizeFileName(segments.at(-1) ?? "file");
  const relativeDirectoryPath = segments.length > 1
    ? segments.slice(0, -1).map((segment) => sanitizeDirectorySegment(segment)).filter(Boolean).join("/") || null
    : null;

  return {
    fileIndex,
    relativePath: relativeDirectoryPath ? `${relativeDirectoryPath}/${fileName}` : fileName,
    fileName,
    relativeDirectoryPath,
    size,
    mimeType: mimeTypeForMagnetFileName(fileName)
  };
}

function isAria2MetadataPlaceholderFile(fileName: string): boolean {
  return fileName.startsWith("[METADATA]");
}

async function loadMagnetFilesFromSavedTorrent(
  downloadDir: string
): Promise<Array<{
  fileIndex: number;
  relativePath: string;
  fileName: string;
  relativeDirectoryPath: string | null;
  size: number;
  mimeType: string;
}> | null> {
  const entries = await readdir(downloadDir).catch(() => []);
  const torrentFile = entries.find((entry) => entry.toLowerCase().endsWith(".torrent"));
  if (!torrentFile) {
    return null;
  }

  const bytes = await readFile(path.join(downloadDir, torrentFile));
  return torrentFilesFromBencodedTorrent(bytes);
}

function torrentFilesFromBencodedTorrent(bytes: Uint8Array): Array<{
  fileIndex: number;
  relativePath: string;
  fileName: string;
  relativeDirectoryPath: string | null;
  size: number;
  mimeType: string;
}> {
  const root = parseBencode(bytes);
  const info = bencodeDictValue(root, "info");
  const name = sanitizeDirectorySegment(bencodeStringValue(info.get("name")) || "torrent");
  const files = bencodeListValue(info.get("files"));

  if (files) {
    const parsed: Array<{
      fileIndex: number;
      relativePath: string;
      fileName: string;
      relativeDirectoryPath: string | null;
      size: number;
      mimeType: string;
    }> = [];
    files.forEach((item, index) => {
      if (!(item instanceof Map)) return;
      const size = bencodeNumberValue(item.get("length"));
      const pathParts = bencodeListValue(item.get("path"))
        ?.map((part) => sanitizeDirectorySegment(bencodeStringValue(part) || ""))
        .filter(Boolean) ?? [];
      if (!Number.isSafeInteger(size) || size <= 0 || pathParts.length === 0) return;
      const fileName = sanitizeFileName(pathParts.at(-1) ?? "file");
      const relativeDirectoryPath = [name, ...pathParts.slice(0, -1)].filter(Boolean).join("/") || null;
      parsed.push({
        fileIndex: index + 1,
        relativePath: relativeDirectoryPath ? `${relativeDirectoryPath}/${fileName}` : fileName,
        fileName,
        relativeDirectoryPath,
        size,
        mimeType: mimeTypeForMagnetFileName(fileName)
      });
    });
    return parsed;
  }

  const size = bencodeNumberValue(info.get("length"));
  if (!Number.isSafeInteger(size) || size <= 0) {
    return [];
  }

  const fileName = sanitizeFileName(name || "torrent");
  return [{
    fileIndex: 1,
    relativePath: fileName,
    fileName,
    relativeDirectoryPath: null,
    size,
    mimeType: mimeTypeForMagnetFileName(fileName)
  }];
}

function mimeTypeForMagnetFileName(fileName: string): string {
  return mimeTypeForFileName(fileName) ?? "application/octet-stream";
}

async function serveMagnetThumbnailSource(params: {
  request: Request;
  env: AppEnv;
  db: AppDatabase;
  importId: string;
  fileIndex: number;
}): Promise<Response> {
  const refreshed = await refreshMagnetImportStatus(params.env, params.db, params.importId);
  if (
    refreshed.importRecord.status !== "downloaded" &&
    refreshed.importRecord.status !== "importing" &&
    refreshed.importRecord.status !== "done"
  ) {
    throw new AppError(409, "MagnetDownloadNotReady", "磁力文件尚未下载完成，暂不能生成缩略图源");
  }

  const file = await requireMagnetImportFile(params.db, params.importId, params.fileIndex);
  if (thumbnailSourceKind(file.mime_type) !== "video") {
    throw new AppError(400, "UnsupportedMagnetThumbnailSource", "仅支持为视频磁力文件生成缩略图源");
  }

  const absolutePath = safeMagnetFilePath(refreshed.importRecord.download_dir, file.path);
  const stats = await lstat(absolutePath).catch(() => {
    throw new AppError(409, "MagnetFileNotReady", "磁力文件尚未落盘完成");
  });

  if (!stats.isFile() || stats.size < file.size) {
    throw new AppError(409, "MagnetFileNotReady", "磁力文件尚未下载完成，暂不能读取视频帧");
  }

  const range = parseByteRange(params.request.headers.get("Range"), file.size);
  if (!range) {
    return rangeNotSatisfiableResponse(file.size);
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", file.mime_type);
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=600");
  headers.set("Content-Disposition", contentDispositionInline(file.file_name));
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
  }

  const stream = Readable.toWeb(createReadStream(absolutePath, {
    start: range.start,
    end: range.end
  })) as ReadableStream;

  return new Response(stream, {
    status: range.partial ? 206 : 200,
    headers
  });
}

async function readMagnetFileChunk(
  importRecord: MagnetImportRecord,
  file: MagnetImportFileRecord,
  upload: MultipartUploadRecord,
  chunkIndex: number
): Promise<Blob> {
  const expectedSize = expectedChunkSize(upload, chunkIndex);
  const start = chunkIndex * upload.chunk_size;
  const absolutePath = safeMagnetFilePath(importRecord.download_dir, file.path);
  const handle = await open(absolutePath, "r").catch(() => {
    throw new AppError(409, "MagnetFileNotReady", "磁力文件尚未落盘完成");
  });

  try {
    const buffer = new Uint8Array(expectedSize);
    const { bytesRead } = await handle.read(buffer, 0, expectedSize, start);
    if (bytesRead !== expectedSize) {
      throw new AppError(409, "MagnetFileNotReady", "磁力文件分片尚未下载完成");
    }
    return new Blob([buffer], { type: upload.mime_type });
  } finally {
    await handle.close();
  }
}

function safeMagnetFilePath(downloadDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(downloadDir);
  const resolved = path.resolve(downloadDir, relativePath);
  if (resolved !== resolvedBase && resolved.startsWith(`${resolvedBase}${path.sep}`)) {
    return resolved;
  }
  throw new AppError(400, "InvalidMagnetFilePath", "磁力文件路径无效");
}

async function deleteMagnetImportDownloadDir(
  config: ReturnType<typeof requireAria2Config>,
  importRecord: MagnetImportRecord
): Promise<{ deleted: boolean; path?: string; skipped?: string }> {
  const resolvedDir = safeAria2DownloadDir(config.downloadDir, importRecord.download_dir);
  if (!resolvedDir) {
    return { deleted: false, skipped: "download_dir_outside_base" };
  }

  const result = await deleteAria2DownloadDir(config.downloadDir, resolvedDir);
  if (!result.deleted) {
    return { deleted: false, skipped: "download_dir_missing" };
  }
  return { deleted: true, path: importRecord.download_dir };
}

async function ensureAria2DownloadCapacity(params: {
  env: AppEnv;
  db: AppDatabase;
  additionalBytes: number;
}): Promise<void> {
  const config = resolveAria2DownloadConfig(params.env);
  const additionalBytes = Math.max(0, params.additionalBytes);
  const cleanup = await cleanupAria2DownloadCache(params.env, params.db, Date.now());
  const projectedBytes = cleanup.currentBytes + additionalBytes;

  if (config.downloadMaxBytes > 0 && projectedBytes > config.downloadMaxBytes) {
    throw new AppError(507, "Aria2DownloadStorageLimitExceeded", "aria2 下载目录容量不足，无法开始新的磁力下载", {
      download_dir: config.downloadDir,
      current_bytes: cleanup.currentBytes,
      required_bytes: additionalBytes,
      projected_bytes: projectedBytes,
      max_bytes: config.downloadMaxBytes,
      deleted_bytes: cleanup.deletedBytes
    });
  }

  if (config.downloadMinFreeBytes > 0) {
    const freeBytes = await availableDiskBytes(config.downloadDir);
    if (freeBytes - additionalBytes < config.downloadMinFreeBytes) {
      throw new AppError(507, "Aria2DownloadDiskFreeSpaceTooLow", "磁盘剩余空间不足，无法开始新的磁力下载", {
        download_dir: config.downloadDir,
        free_bytes: freeBytes,
        required_bytes: additionalBytes,
        min_free_bytes: config.downloadMinFreeBytes
      });
    }
  }
}

async function forceRemoveAria2MagnetTaskIfConfigured(env: AppEnv, record: MagnetImportRecord): Promise<void> {
  if (!env.ARIA2_RPC_URL?.trim() || !env.ARIA2_RPC_SECRET?.trim()) {
    return;
  }

  const config = requireAria2Config(env);
  await forgetAria2MagnetTask(config, record);
}

function safeAria2DownloadDir(baseDir: string, targetDir: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedDir = path.resolve(path.isAbsolute(targetDir) ? targetDir : path.join(baseDir, targetDir));

  if (resolvedDir !== resolvedBase && resolvedDir.startsWith(`${resolvedBase}${path.sep}`)) {
    return resolvedDir;
  }

  return null;
}

async function deleteAria2DownloadDir(
  baseDir: string,
  targetDir: string
): Promise<{ deleted: boolean; bytes: number }> {
  const resolvedDir = safeAria2DownloadDir(baseDir, targetDir);
  if (!resolvedDir) {
    return { deleted: false, bytes: 0 };
  }

  const targetStat = await lstat(resolvedDir).catch(() => null);
  if (!targetStat?.isDirectory()) {
    return { deleted: false, bytes: 0 };
  }

  const bytes = await directorySizeBytes(resolvedDir);
  await rm(resolvedDir, { recursive: true, force: true });
  return { deleted: true, bytes };
}

async function directorySizeBytes(rootDir: string): Promise<number> {
  const rootStat = await lstat(rootDir).catch(() => null);
  if (!rootStat) {
    return 0;
  }
  if (!rootStat.isDirectory()) {
    return rootStat.isFile() ? rootStat.size : 0;
  }

  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      total += (await lstat(entryPath).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

async function availableDiskBytes(targetDir: string): Promise<number> {
  await mkdir(targetDir, { recursive: true });
  const stats = await statfs(targetDir);
  return stats.bavail * stats.bsize;
}

async function listAria2DownloadCacheCandidates(
  downloadDir: string,
  protectedDirs: Set<string>,
  ignoredDirs: Set<string>,
  olderThanMs: number
): Promise<Array<{ path: string; mtimeMs: number; bytes: number }>> {
  const entries = await readdir(downloadDir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ path: string; mtimeMs: number; bytes: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !ARIA2_CACHE_DIRECTORY_NAME_PATTERN.test(entry.name)) {
      continue;
    }

    const entryPath = path.resolve(downloadDir, entry.name);
    if (protectedDirs.has(entryPath) || ignoredDirs.has(entryPath)) {
      continue;
    }

    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat?.isDirectory()) {
      continue;
    }
    if (entryStat.mtimeMs > olderThanMs) {
      continue;
    }

    candidates.push({
      path: entryPath,
      mtimeMs: entryStat.mtimeMs,
      bytes: await directorySizeBytes(entryPath)
    });
  }

  return candidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) {
      return left.mtimeMs - right.mtimeMs;
    }
    return right.bytes - left.bytes;
  });
}

function targetDirectoryForMagnetFile(baseDirectoryPath: string, file: MagnetImportFileRecord): string {
  const relativeDirectoryPath = file.relative_directory_path?.trim();
  if (!relativeDirectoryPath) {
    return baseDirectoryPath;
  }

  return normalizeDirectoryPath(`${baseDirectoryPath.replace(/\/+$/g, "")}/${relativeDirectoryPath}`);
}

async function requireMagnetImport(db: AppDatabase, id: string): Promise<MagnetImportRecord> {
  const record = await getMagnetImportRecord(db, id);
  if (!record) {
    throw new AppError(404, "MagnetImportNotFound", "Magnet import task not found");
  }
  return record;
}

async function requireMagnetImportFile(db: AppDatabase, importId: string, fileIndex: number): Promise<MagnetImportFileRecord> {
  const file = await getMagnetImportFileRecord(db, importId, fileIndex);
  if (!file) {
    throw new AppError(404, "MagnetImportFileNotFound", "Magnet import file not found");
  }
  return file;
}

function serializeMagnetImport(
  record: MagnetImportRecord,
  files: MagnetImportFileRecord[],
  aria2Status?: Aria2Status
): Record<string, unknown> {
  const download = magnetDownloadRuntimeStatus(record, aria2Status);
  return {
    id: record.id,
    magnet_uri: record.magnet_uri,
    info_hash: record.info_hash,
    name: record.name,
    status: record.status,
    file_count: record.file_count,
    total_size: record.total_size,
    error_message: record.error_message,
    created_at: record.created_at,
    updated_at: record.updated_at,
    metadata_completed_at: record.metadata_completed_at,
    download_started_at: record.download_started_at,
    download_completed_at: record.download_completed_at,
    completed_at: record.completed_at,
    aria2_status: download.aria2Status,
    download_completed_bytes: download.completedBytes,
    download_total_bytes: download.totalBytes,
    download_progress: download.progress,
    download_speed_bytes_per_second: download.speedBytesPerSecond,
    files: files.map((file) => ({
      id: file.id,
      file_index: file.file_index,
      path: file.path,
      file_name: file.file_name,
      relative_directory_path: file.relative_directory_path,
      size: file.size,
      mime_type: file.mime_type,
      chunk_size: file.chunk_size,
      chunk_count: file.chunk_count,
      upload_id: file.upload_id,
      selected: file.selected === 1,
      status: file.status,
      error_message: file.error_message
    }))
  };
}

function magnetDownloadRuntimeStatus(
  record: MagnetImportRecord,
  status: Aria2Status | undefined
): {
  aria2Status: Aria2Status["status"] | null;
  completedBytes: number | null;
  totalBytes: number | null;
  progress: number | null;
  speedBytesPerSecond: number | null;
} {
  const totalBytes = aria2NumericValue(status?.totalLength) ?? record.total_size ?? null;
  let completedBytes = aria2NumericValue(status?.completedLength);
  if (
    completedBytes === null &&
    totalBytes !== null &&
    (record.status === "downloaded" || record.status === "importing" || record.status === "done")
  ) {
    completedBytes = totalBytes;
  }

  if (status?.status === "complete" && totalBytes !== null) {
    completedBytes = totalBytes;
  }

  const progress = totalBytes !== null && totalBytes > 0 && completedBytes !== null
    ? Math.min(1, Math.max(0, completedBytes / totalBytes))
    : null;

  return {
    aria2Status: status?.status ?? null,
    completedBytes,
    totalBytes,
    progress,
    speedBytesPerSecond: aria2NumericValue(status?.downloadSpeed)
  };
}

function aria2NumericValue(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeMagnetUri(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "MissingMagnet", "JSON field 'magnet' is required");
  }

  const normalized = value.trim();
  if (!normalized.toLowerCase().startsWith("magnet:?")) {
    throw new AppError(400, "InvalidMagnet", "仅支持 magnet:? 磁力链接");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AppError(400, "InvalidMagnet", "磁力链接格式无效");
  }

  if (parsed.protocol !== "magnet:" || !parsed.searchParams.get("xt")) {
    throw new AppError(400, "InvalidMagnet", "磁力链接缺少 xt 参数");
  }

  return normalized;
}

function normalizeMagnetFileIndexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, "InvalidMagnetFileSelection", "file_indexes must be a non-empty array");
  }

  const indexes = Array.from(new Set(value.map((item) => Number(item))));
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index <= 0) {
      throw new AppError(400, "InvalidMagnetFileSelection", "file_indexes contains an invalid file index");
    }
  }

  return indexes.sort((left, right) => left - right);
}

function normalizeMagnetFileUploadOptions(
  value: unknown,
  selectedIndexes: number[]
): Map<number, MagnetFileUploadOption> {
  const options = new Map<number, MagnetFileUploadOption>();

  if (value === undefined || value === null) {
    return options;
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidMagnetFileOptions", "file_options must be an array");
  }

  const selectedSet = new Set(selectedIndexes);
  for (const [position, item] of value.entries()) {
    if (!isPlainRecord(item)) {
      throw new AppError(400, "InvalidMagnetFileOptions", `file_options[${position}] must be an object`);
    }

    const fileIndex = positiveIntegerField(item.file_index, `file_options[${position}].file_index`);
    if (!selectedSet.has(fileIndex)) {
      throw new AppError(400, "InvalidMagnetFileOptions", `file_options[${position}].file_index is not selected`);
    }

    const option: MagnetFileUploadOption = {};
    const fileName = normalizeOptionalFileName(item.file_name);
    if (fileName) {
      option.fileName = fileName;
    }

    if (item.on_conflict !== undefined) {
      option.conflictAction = normalizeFileNameConflictAction(item.on_conflict);
    }

    if (option.fileName || option.conflictAction) {
      options.set(fileIndex, option);
    }
  }

  return options;
}

function parseMagnetFileIndex(value: string): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new AppError(400, "InvalidMagnetFileIndex", "Magnet file index is invalid");
  }
  return index;
}

function magnetDownloadDir(baseDir: string, importId: string): string {
  return path.join(baseDir, importId);
}

function magnetInfoHash(magnetUri: string): string | null {
  try {
    const xt = new URL(magnetUri).searchParams.get("xt");
    const match = /^urn:btih:([a-z0-9]+)$/i.exec(xt || "");
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function normalizeTorrentRelativePath(value: string): string | null {
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment, index, all) => index === all.length - 1 ? sanitizeFileName(segment) : sanitizeDirectorySegment(segment))
    .filter(Boolean);

  return segments.length > 0 ? segments.join("/") : null;
}

function sanitizeDirectorySegment(value: string | undefined): string {
  const cleaned = sanitizeFileName(value)
    .replace(/[\\/]/g, "")
    .trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "folder";
  }

  return cleaned.slice(0, 80);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BValue = number | Uint8Array | BValue[] | Map<string, BValue>;

function parseBencode(bytes: Uint8Array): Map<string, BValue> {
  let offset = 0;

  const parseValue = (): BValue => {
    const byte = bytes[offset];
    if (byte === undefined) {
      throw new AppError(400, "InvalidTorrentMetadata", "Torrent metadata is truncated");
    }

    if (byte === 0x69) {
      offset += 1;
      const end = bytes.indexOf(0x65, offset);
      if (end < 0) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent integer is invalid");
      }
      const text = new TextDecoder().decode(bytes.slice(offset, end));
      offset = end + 1;
      const value = Number(text);
      if (!Number.isSafeInteger(value)) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent integer is out of range");
      }
      return value;
    }

    if (byte === 0x6c) {
      offset += 1;
      const values: BValue[] = [];
      while (bytes[offset] !== 0x65) {
        values.push(parseValue());
      }
      offset += 1;
      return values;
    }

    if (byte === 0x64) {
      offset += 1;
      const values = new Map<string, BValue>();
      while (bytes[offset] !== 0x65) {
        const key = parseValue();
        if (!(key instanceof Uint8Array)) {
          throw new AppError(400, "InvalidTorrentMetadata", "Torrent dictionary key is invalid");
        }
        values.set(new TextDecoder().decode(key), parseValue());
      }
      offset += 1;
      return values;
    }

    if (byte >= 0x30 && byte <= 0x39) {
      let colon = offset;
      while (bytes[colon] !== 0x3a) {
        colon += 1;
        if (colon >= bytes.length) {
          throw new AppError(400, "InvalidTorrentMetadata", "Torrent byte string is invalid");
        }
      }
      const length = Number(new TextDecoder().decode(bytes.slice(offset, colon)));
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent byte string length is invalid");
      }
      offset = colon + 1;
      const end = offset + length;
      if (end > bytes.length) {
        throw new AppError(400, "InvalidTorrentMetadata", "Torrent byte string is truncated");
      }
      const value = bytes.slice(offset, end);
      offset = end;
      return value;
    }

    throw new AppError(400, "InvalidTorrentMetadata", "Torrent metadata is invalid");
  };

  const root = parseValue();
  if (!(root instanceof Map)) {
    throw new AppError(400, "InvalidTorrentMetadata", "Torrent root must be a dictionary");
  }
  return root;
}

function bencodeDictValue(root: Map<string, BValue>, key: string): Map<string, BValue> {
  const value = root.get(key);
  if (!(value instanceof Map)) {
    throw new AppError(400, "InvalidTorrentMetadata", `Torrent metadata missing ${key}`);
  }
  return value;
}

function bencodeListValue(value: BValue | undefined): BValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function bencodeStringValue(value: BValue | undefined): string | undefined {
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
}

function bencodeNumberValue(value: BValue | undefined): number {
  return typeof value === "number" ? value : Number.NaN;
}

async function handleApiMultipartUploads(request: Request, env: AppEnv): Promise<Response> {
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
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createMultipartUpload({
      db,
      sourceKind: "local",
      fileName,
      mimeType,
      size,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
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
    const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
    const remark = normalizeRemark(body.remark);
    const fileNameOverride = normalizeOptionalFileName(body.file_name);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES), {
      forceMultipart: true,
      ...(sourceHeaders ? { sourceHeaders } : {})
    });

    if (probe.mode === "single") {
      throw new AppError(500, "InternalError", "Forced URL multipart probe returned single mode");
    }

    const sourceHeadersJson = remoteRequestHeadersJson(sourceHeaders);
    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      ...(sourceHeadersJson ? { sourceHeadersJson } : {}),
      fileName: fileNameOverride ?? probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      directoryPath,
      directoryId: directory?.id ?? null,
      conflictAction,
      ...(remark ? { remark } : {})
    });
    const thumbnailSource = await createThumbnailSourceInfo({
      request,
      env,
      uploadId: result.id,
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
    const completeInput = await readCompleteUploadInput(request, url.searchParams);
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload,
      conflictAction: completeInput.conflictAction,
      ...(completeInput.thumbnail ? { thumbnail: completeInput.thumbnail } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, null)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "API multipart upload route not found"));
}

async function probeHlsSource(
  sourceUrl: URL,
  selectedVariantId: string | undefined,
  sourceHeaders?: RemoteRequestHeaders
): Promise<HlsProbeResult> {
  const plan = await fetchHlsPlaylistPlan(sourceUrl, sourceHeaders);
  const fileName = hlsFileNameFromUrl(sourceUrl);

  if (plan.kind === "media") {
    return {
      playlistUrl: sourceUrl.toString(),
      fileName,
      plan,
      media: plan
    };
  }

  if (!selectedVariantId) {
    return {
      playlistUrl: sourceUrl.toString(),
      fileName,
      plan
    };
  }

  const variant = selectHlsVariant(plan.variants, selectedVariantId);
  const mediaPlan = await fetchHlsMediaPlaylist(new URL(variant.uri), sourceHeaders);

  return {
    playlistUrl: sourceUrl.toString(),
    fileName: hlsFileNameFromUrl(new URL(mediaPlan.playlistUrl)),
    plan,
    media: mediaPlan,
    selectedVariantId: variant.id
  };
}

async function createHlsUpload(params: {
  db: AppDatabase;
  sourceUrl: URL;
  sourceHeaders?: RemoteRequestHeaders;
  selectedVariantId: string | undefined;
  fileNameOverride: string | undefined;
  conflictAction: FileNameConflictAction;
  remark: string | undefined;
  uploadedBy: string;
  directoryId: string | null;
  directoryPath: string;
}): Promise<HlsInitResult> {
  const resolved = await resolveHlsMediaPlan(params.sourceUrl, params.selectedVariantId, params.sourceHeaders);
  const fileName = params.fileNameOverride ?? hlsFileNameFromUrl(new URL(resolved.mediaPlan.playlistUrl));

  await requireFileNameWritable({
    db: params.db,
    directoryPath: params.directoryPath,
    fileName,
    conflictAction: params.conflictAction
  });

  const now = new Date().toISOString();
  const assetId = crypto.randomUUID();
  const sourceHeadersJson = remoteRequestHeadersJson(params.sourceHeaders);
  const asset = await insertHlsAssetRecord(params.db, {
    id: assetId,
    sourceUrl: params.sourceUrl.toString(),
    ...(sourceHeadersJson ? { sourceHeadersJson } : {}),
    mediaPlaylistUrl: resolved.mediaPlan.playlistUrl,
    fileName,
    mimeType: HLS_PLAYLIST_MIME_TYPE,
    directoryId: params.directoryId,
    directoryPath: params.directoryPath,
    status: "pending",
    selectedVariantId: resolved.selectedVariantId ?? null,
    targetDurationSeconds: resolved.mediaPlan.targetDuration,
    durationSeconds: resolved.mediaPlan.duration,
    segmentCount: resolved.mediaPlan.segments.length,
    playlistText: resolved.mediaPlan.playlistText,
    ...(resolved.mediaPlan.initSegment ? {
      initSourceUrl: resolved.mediaPlan.initSegment.uri,
      initByteRangeStart: resolved.mediaPlan.initSegment.byteRange?.offset ?? null,
      initByteRangeLength: resolved.mediaPlan.initSegment.byteRange?.length ?? null,
      initMimeType: hlsMimeTypeForInitSegment(new URL(resolved.mediaPlan.initSegment.uri))
    } : {}),
    createdAt: now,
    updatedAt: now,
    ...(params.remark ? { remark: params.remark } : {}),
    ...(params.uploadedBy ? { uploadedBy: params.uploadedBy } : {})
  });

  await insertHlsSegmentRecords(params.db, resolved.mediaPlan.segments.map((segment) => {
    const segmentUrl = new URL(segment.uri);
    return {
      id: crypto.randomUUID(),
      assetId,
      variantId: resolved.selectedVariantId ?? "media",
      segmentIndex: segment.index,
      sourceUrl: segment.uri,
      byteRangeStart: segment.byteRange?.offset ?? null,
      byteRangeLength: segment.byteRange?.length ?? null,
      durationSeconds: segment.duration,
      mimeType: hlsMimeTypeForSegment(segmentUrl),
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
  }));

  return {
    asset,
    segments: await listHlsSegmentRecords(params.db, asset.id)
  };
}

async function importHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  segmentIndex: number;
}): Promise<HlsSegmentImportResult> {
  const segment = await requireHlsSegment(params.db, params.asset.id, params.segmentIndex);

  if (segment.status === "done") {
    await ensureHlsInitSegmentImported({
      env: params.env,
      db: params.db,
      asset: params.asset
    });
    return hlsSegmentImportResult(params.db, segment);
  }

  await markHlsAssetStatus(params.db, params.asset.id, "importing", new Date().toISOString());
  await markHlsSegmentImporting(params.db, segment.id, new Date().toISOString());

  try {
    const asset = await ensureHlsInitSegmentImported({
      env: params.env,
      db: params.db,
      asset: params.asset
    });
    const sourceUrl = new URL(segment.source_url);
    const sourceHeaders = storedRemoteRequestHeaders(asset.source_headers_json);
    const byteRange = hlsSegmentByteRange(segment);
    const encryption = hlsSegmentEncryptionForAsset(asset, params.segmentIndex);
    const probe = await probeHlsSegmentSource(sourceUrl, sourceHeaders, byteRange);
    const mimeType = hlsMimeTypeForSegment(sourceUrl, probe.contentType);

    if (probe.size !== undefined && probe.size > MAX_TELEGRAM_MULTIPART_BYTES) {
      throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, probe.size);
    }

    if (encryption) {
      if (probe.size !== undefined && probe.size > TELEGRAM_CHUNK_SIZE_BYTES + HLS_AES_128_KEY_BYTES) {
        throw new AppError(
          400,
          "EncryptedHlsSegmentTooLarge",
          `加密 HLS segment 目前最大支持 ${formatHumanFileSize(TELEGRAM_CHUNK_SIZE_BYTES)} 明文大小`
        );
      }

      const encryptedBlob = await downloadHlsSegmentBlob(
        sourceUrl,
        TELEGRAM_CHUNK_SIZE_BYTES + HLS_AES_128_KEY_BYTES,
        probe.size,
        sourceHeaders,
        byteRange
      );
      const blob = await decryptHlsSegmentBlob(encryptedBlob, encryption, sourceHeaders);
      if (blob.size > TELEGRAM_CHUNK_SIZE_BYTES) {
        throw new AppError(
          400,
          "EncryptedHlsSegmentTooLarge",
          `解密后的 HLS segment 目前最大支持 ${formatHumanFileSize(TELEGRAM_CHUNK_SIZE_BYTES)}`
        );
      }

      const fileName = hlsSegmentFileName(sourceUrl, segment.segment_index);
      const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
        env: params.env,
        db: params.db,
        file: blob,
        fileName,
        preferredChannelIndex: segment.segment_index
      });
      const completedAt = new Date().toISOString();

      await completeHlsSegmentSingle({
        db: params.db,
        id: segment.id,
        mimeType,
        size: telegramDocument.file_size ?? blob.size,
        telegramFileId: telegramDocument.file_id,
        telegramChannelId: channel.id,
        completedAt,
        ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {})
      });

      return hlsSegmentImportResult(params.db, await requireHlsSegment(params.db, params.asset.id, params.segmentIndex));
    }

    if (probe.size !== undefined && probe.size > TELEGRAM_CHUNK_SIZE_BYTES) {
      if (!probe.supportsRange) {
        throw new AppError(400, "RangeNotSupported", "较大的 HLS segment 必须支持 Range 请求");
      }

      const upload = await ensureHlsSegmentMultipartUpload({
        db: params.db,
        asset: params.asset,
        segment,
        mimeType,
        size: probe.size
      });
      const refreshed = await requireHlsSegment(params.db, params.asset.id, params.segmentIndex);
      const chunks = await listFileChunkRecords(params.db, upload.id);

      return {
        segment: refreshed,
        uploadedChunks: chunks.map((chunk) => chunk.chunk_index),
        missingChunks: missingChunkIndexes(upload, chunks)
      };
    }

    const blob = await downloadHlsSegmentBlob(sourceUrl, TELEGRAM_CHUNK_SIZE_BYTES, probe.size, sourceHeaders, byteRange);
    const fileName = hlsSegmentFileName(sourceUrl, segment.segment_index);
    const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
      env: params.env,
      db: params.db,
      file: blob,
      fileName,
      preferredChannelIndex: segment.segment_index
    });
    const completedAt = new Date().toISOString();

    await completeHlsSegmentSingle({
      db: params.db,
      id: segment.id,
      mimeType,
      size: telegramDocument.file_size ?? blob.size,
      telegramFileId: telegramDocument.file_id,
      telegramChannelId: channel.id,
      completedAt,
      ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {})
    });

    return hlsSegmentImportResult(params.db, await requireHlsSegment(params.db, params.asset.id, params.segmentIndex));
  } catch (error) {
    await failHlsSegment(params.db, segment.id, errorMessageForServer(error), new Date().toISOString());
    await markHlsAssetStatus(params.db, params.asset.id, "failed", new Date().toISOString());
    throw error;
  }
}

async function ensureHlsInitSegmentImported(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
}): Promise<HlsAssetRecord> {
  if (!params.asset.init_source_url) {
    return params.asset;
  }

  if (
    params.asset.init_status === "done" &&
    params.asset.init_storage_backend === "telegram_single" &&
    params.asset.init_telegram_file_id &&
    Number.isSafeInteger(params.asset.init_size)
  ) {
    return params.asset;
  }

  const startedAt = new Date().toISOString();
  await markHlsInitSegmentImporting(params.db, params.asset.id, startedAt);

  try {
    const sourceUrl = new URL(params.asset.init_source_url);
    const sourceHeaders = storedRemoteRequestHeaders(params.asset.source_headers_json);
    const initPlan = hlsInitSegmentPlanForAsset(params.asset);
    const byteRange = initPlan?.byteRange ?? hlsInitByteRange(params.asset);
    const encryption = initPlan?.encryption ?? null;
    const probe = await probeHlsSegmentSource(sourceUrl, sourceHeaders, byteRange);
    const mimeType = hlsMimeTypeForInitSegment(sourceUrl, probe.contentType ?? params.asset.init_mime_type);

    if (probe.size !== undefined && probe.size > MAX_TELEGRAM_MULTIPART_BYTES) {
      throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, probe.size);
    }

    const maxInitBytes = encryption
      ? TELEGRAM_CHUNK_SIZE_BYTES + HLS_AES_128_KEY_BYTES
      : TELEGRAM_CHUNK_SIZE_BYTES;
    if (probe.size !== undefined && probe.size > maxInitBytes) {
      throw new AppError(
        400,
        "HlsInitSegmentTooLarge",
        `fMP4 init segment 目前最大支持 ${formatHumanFileSize(TELEGRAM_CHUNK_SIZE_BYTES)}`
      );
    }

    const sourceBlob = await downloadHlsSegmentBlob(sourceUrl, maxInitBytes, probe.size, sourceHeaders, byteRange);
    const blob = encryption
      ? await decryptHlsSegmentBlob(sourceBlob, encryption, sourceHeaders)
      : sourceBlob;
    if (blob.size > TELEGRAM_CHUNK_SIZE_BYTES) {
      throw new AppError(
        400,
        "HlsInitSegmentTooLarge",
        `fMP4 init segment 目前最大支持 ${formatHumanFileSize(TELEGRAM_CHUNK_SIZE_BYTES)}`
      );
    }

    const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
      env: params.env,
      db: params.db,
      file: blob,
      fileName: hlsInitSegmentFileName(sourceUrl),
      preferredChannelIndex: 0
    });
    const completedAt = new Date().toISOString();

    await completeHlsInitSegmentSingle({
      db: params.db,
      assetId: params.asset.id,
      mimeType,
      size: telegramDocument.file_size ?? blob.size,
      telegramFileId: telegramDocument.file_id,
      telegramChannelId: channel.id,
      completedAt,
      ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {})
    });

    return await requireHlsAsset(params.db, params.asset.id);
  } catch (error) {
    await failHlsInitSegment(params.db, params.asset.id, errorMessageForServer(error), new Date().toISOString());
    await markHlsAssetStatus(params.db, params.asset.id, "failed", new Date().toISOString());
    throw error;
  }
}

async function importHlsSegmentChunk(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  segmentIndex: number;
  chunkIndexValue: string;
}): Promise<HlsSegmentImportResult> {
  const segment = await requireHlsSegment(params.db, params.asset.id, params.segmentIndex);
  const upload = await requireHlsSegmentMultipartUpload(params.db, segment);
  const chunkIndex = normalizeChunkIndex(params.chunkIndexValue, upload);

  await markHlsAssetStatus(params.db, params.asset.id, "importing", new Date().toISOString());
  await markHlsSegmentImporting(params.db, segment.id, new Date().toISOString());

  try {
    const record = await downloadAndUploadRemoteChunk({
      env: params.env,
      db: params.db,
      upload,
      chunkIndex
    });

    await upsertFileChunkRecord(params.db, record);
    return hlsSegmentImportResult(params.db, await requireHlsSegment(params.db, params.asset.id, params.segmentIndex));
  } catch (error) {
    await failHlsSegment(params.db, segment.id, errorMessageForServer(error), new Date().toISOString());
    await markHlsAssetStatus(params.db, params.asset.id, "failed", new Date().toISOString());
    throw error;
  }
}

async function completeHlsMultipartSegment(params: {
  db: AppDatabase;
  asset: HlsAssetRecord;
  segmentIndex: number;
}): Promise<HlsSegmentImportResult> {
  const segment = await requireHlsSegment(params.db, params.asset.id, params.segmentIndex);
  const upload = await requireHlsSegmentMultipartUpload(params.db, segment);
  const chunks = await listFileChunkRecords(params.db, upload.id);

  validateCompleteChunks(upload, chunks);
  const completedAt = new Date().toISOString();
  await completeMultipartUploadRecord(params.db, upload.id, completedAt);
  await completeHlsSegmentMultipart({
    db: params.db,
    id: segment.id,
    multipartUploadId: upload.id,
    chunkSize: upload.chunk_size,
    chunkCount: upload.chunk_count,
    completedAt
  });

  return hlsSegmentImportResult(params.db, await requireHlsSegment(params.db, params.asset.id, params.segmentIndex));
}

async function completeHlsUpload(params: {
  request: Request;
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  conflictAction?: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
}): Promise<UploadResult> {
  const segments = await listHlsSegmentRecords(params.db, params.asset.id);
  validateCompleteHlsSegments(params.asset, segments);
  const totalSize = hlsInitSegmentSize(params.asset) +
    segments.reduce((total, segment) => total + requireHlsSegmentSize(segment), 0);

  await requireFileNameWritable({
    db: params.db,
    directoryPath: params.asset.directory_path ?? "/",
    fileName: params.asset.file_name,
    excludeId: params.asset.id,
    conflictAction: params.conflictAction ?? "error"
  });

  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const createdAt = new Date().toISOString();
  const token = await createSignedToken(
    {
      v: 4,
      hls_asset_id: params.asset.id,
      file_record_id: params.asset.id,
      name: params.asset.file_name,
      mime_type: HLS_PLAYLIST_MIME_TYPE,
      size: totalSize,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );
  const filePath = hlsPublicFilePath(token, params.asset.file_name);
  const publicUrl = `${getPublicBaseUrl(params.request, params.env)}${filePath}`;
  const thumbnail = await uploadOptionalThumbnail({
    request: params.request,
    env: params.env,
    db: params.db,
    originalFileName: params.asset.file_name,
    thumbnail: params.thumbnail
  });
  const md5 = `hls:${params.asset.id}:${segments.length}:${totalSize}`;

  await completeHlsAssetWithFileRecord({
    db: params.db,
    assetId: params.asset.id,
    completedAt: createdAt,
    conflictAction: params.conflictAction ?? "error",
    file: {
      id: params.asset.id,
      fileName: params.asset.file_name,
      mimeType: HLS_PLAYLIST_MIME_TYPE,
      size: totalSize,
      md5,
      telegramFileId: `hls:${params.asset.id}`,
      telegramChannelId: segments[0]?.telegram_channel_id ?? "default",
      filePath,
      createdAt,
      storageBackend: "hls_package",
      directoryId: params.asset.directory_id ?? null,
      directoryPath: params.asset.directory_path ?? "/",
      ...thumbnailFileRecordFields(thumbnail),
      ...(params.asset.remark ? { remark: params.asset.remark } : {}),
      ...(params.asset.uploaded_by ? { uploadedBy: params.asset.uploaded_by } : {})
    }
  });

  return {
    id: params.asset.id,
    name: params.asset.file_name,
    size: totalSize,
    mimeType: HLS_PLAYLIST_MIME_TYPE,
    md5,
    filePath,
    publicUrl,
    telegramFileId: `hls:${params.asset.id}`,
    telegramChannelId: segments[0]?.telegram_channel_id ?? "default",
    ...(params.asset.remark ? { remark: params.asset.remark } : {}),
    createdAt,
    directoryId: params.asset.directory_id ?? null,
    directoryPath: params.asset.directory_path ?? "/",
    storageBackend: "hls_package",
    chunkSize: null,
    chunkCount: null,
    ...(thumbnail ? { thumbnail } : {})
  };
}

async function fetchHlsPlaylistPlan(sourceUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<HlsPlaylistPlan> {
  return parseHlsPlaylist(await fetchHlsPlaylistText(sourceUrl, sourceHeaders), sourceUrl);
}

async function fetchHlsMediaPlaylist(sourceUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<HlsMediaPlan> {
  const plan = await fetchHlsPlaylistPlan(sourceUrl, sourceHeaders);
  if (plan.kind !== "media") {
    throw new AppError(400, "InvalidHlsPlaylist", "variant URI 必须指向 media playlist");
  }
  return plan;
}

async function fetchHlsPlaylistText(sourceUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<string> {
  let response: Response;
  try {
    response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, {
        Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
      })
    });
  } catch {
    throw new AppError(502, "HlsPlaylistFetchFailed", "m3u8 文件获取失败");
  }

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "HlsPlaylistFetchFailed",
      `m3u8 文件返回 ${response.status}`,
      { source_status: response.status }
    );
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength > HLS_MAX_PLAYLIST_BYTES) {
    throw fileTooLargeError(HLS_MAX_PLAYLIST_BYTES, contentLength);
  }

  const text = await response.text().catch(() => {
    throw new AppError(502, "HlsPlaylistReadFailed", "m3u8 文件读取失败");
  });

  if (new TextEncoder().encode(text).byteLength > HLS_MAX_PLAYLIST_BYTES) {
    throw fileTooLargeError(HLS_MAX_PLAYLIST_BYTES, new TextEncoder().encode(text).byteLength);
  }

  return text;
}

async function resolveHlsMediaPlan(
  sourceUrl: URL,
  selectedVariantId: string | undefined,
  sourceHeaders?: RemoteRequestHeaders
): Promise<{ sourcePlan: HlsPlaylistPlan; mediaPlan: HlsMediaPlan; selectedVariantId?: string }> {
  const sourcePlan = await fetchHlsPlaylistPlan(sourceUrl, sourceHeaders);

  if (sourcePlan.kind === "media") {
    return { sourcePlan, mediaPlan: sourcePlan };
  }

  if (!selectedVariantId && sourcePlan.variants.length > 1) {
    throw new AppError(400, "MissingHlsVariant", "master playlist 需要选择一个 variant 后再导入", {
      variants: sourcePlan.variants.map(serializeHlsVariant)
    });
  }

  const variant = selectHlsVariant(sourcePlan.variants, selectedVariantId ?? sourcePlan.variants[0]?.id ?? "");
  const mediaPlan = await fetchHlsMediaPlaylist(new URL(variant.uri), sourceHeaders);
  return { sourcePlan, mediaPlan, selectedVariantId: variant.id };
}

function selectHlsVariant(variants: HlsVariantPlan[], selectedVariantId: string): HlsVariantPlan {
  const variant = variants.find((item) => item.id === selectedVariantId || item.uri === selectedVariantId);
  if (!variant) {
    throw new AppError(400, "InvalidHlsVariant", "选择的 HLS variant 不存在");
  }
  return variant;
}

async function probeHlsSegmentSource(sourceUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<{
  size?: number;
  contentType?: string | null;
  supportsRange: boolean;
}>;
async function probeHlsSegmentSource(
  sourceUrl: URL,
  sourceHeaders: RemoteRequestHeaders | undefined,
  byteRange: HlsByteRange | null
): Promise<{
  size?: number;
  contentType?: string | null;
  supportsRange: boolean;
}>;
async function probeHlsSegmentSource(
  sourceUrl: URL,
  sourceHeaders?: RemoteRequestHeaders,
  byteRange: HlsByteRange | null = null
): Promise<{
  size?: number;
  contentType?: string | null;
  supportsRange: boolean;
}> {
  const head = await fetchRemoteHead(sourceUrl, sourceHeaders);
  const contentType = head?.headers.get("Content-Type") ?? null;
  if (byteRange) {
    return {
      size: byteRange.length,
      contentType,
      supportsRange: true
    };
  }

  const size = parseContentLength(head?.headers.get("Content-Length") ?? null);
  const headSupportsRange = (head?.headers.get("Accept-Ranges") ?? "").toLowerCase().includes("bytes");

  if (size !== undefined && size <= TELEGRAM_CHUNK_SIZE_BYTES) {
    return { size, contentType, supportsRange: headSupportsRange };
  }

  try {
    const rangeProbe = await fetchRemoteRange(sourceUrl, 0, 0, sourceHeaders);
    if (rangeProbe.status === 206) {
      const contentRange = parseContentRange(rangeProbe.headers.get("Content-Range"));
      const probedSize = contentRange?.size ?? size;
      return {
        contentType: rangeProbe.headers.get("Content-Type") ?? contentType,
        supportsRange: true,
        ...(probedSize !== undefined ? { size: probedSize } : {})
      };
    }
  } catch {
    if (size !== undefined) {
      return { size, contentType, supportsRange: headSupportsRange };
    }
  }

  return { ...(size !== undefined ? { size } : {}), contentType, supportsRange: headSupportsRange };
}

async function downloadHlsSegmentBlob(
  sourceUrl: URL,
  maxBytes: number,
  expectedSize: number | undefined,
  sourceHeaders?: RemoteRequestHeaders,
  byteRange: HlsByteRange | null = null
): Promise<Blob> {
  if (byteRange) {
    if (byteRange.length > maxBytes) {
      throw new AppError(400, "RangeNotSupported", "较大的 HLS segment 必须支持 Range 请求");
    }

    const response = await fetchRemoteRange(sourceUrl, byteRange.offset, byteRange.offset + byteRange.length - 1, sourceHeaders);
    validateHlsRangeResponse(response, byteRange);

    const blob = await response.blob().catch(() => {
      throw new AppError(502, "HlsSegmentReadFailed", "HLS segment 读取失败");
    });
    if (blob.size !== byteRange.length) {
      throw new AppError(400, "InvalidChunkSize", `HLS byte-range 大小必须为 ${formatHumanFileSize(byteRange.length)}（当前 ${formatHumanFileSize(blob.size)}）`, {
        expected_chunk_bytes: byteRange.length,
        actual_chunk_bytes: blob.size
      });
    }

    return blob;
  }

  let response: Response;
  try {
    response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, { Accept: "video/*, audio/*, application/octet-stream, */*" })
    });
  } catch {
    throw new AppError(502, "HlsSegmentFetchFailed", "HLS segment 获取失败");
  }

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "HlsSegmentFetchFailed",
      `HLS segment 返回 ${response.status}`,
      { source_status: response.status }
    );
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  const sizeHint = contentLength ?? expectedSize;
  if (sizeHint !== undefined && sizeHint > maxBytes) {
    throw new AppError(400, "RangeNotSupported", "较大的 HLS segment 必须支持 Range 请求");
  }

  const blob = await response.blob().catch(() => {
    throw new AppError(502, "HlsSegmentReadFailed", "HLS segment 读取失败");
  });

  if (blob.size > maxBytes) {
    throw new AppError(400, "RangeNotSupported", "较大的 HLS segment 必须支持 Range 请求");
  }

  return blob;
}

function validateHlsRangeResponse(response: Response, byteRange: HlsByteRange): void {
  if (response.status !== 206) {
    throw new AppError(400, "RangeNotSupported", "HLS byte-range source must return 206");
  }

  const contentRange = parseContentRange(response.headers.get("Content-Range"));
  if (!contentRange) {
    throw new AppError(400, "RangeNotSupported", "HLS byte-range source must include Content-Range");
  }

  const expectedEnd = byteRange.offset + byteRange.length - 1;
  if (contentRange.start !== byteRange.offset || contentRange.end !== expectedEnd || contentRange.size < expectedEnd + 1) {
    throw new AppError(400, "InvalidChunkRange", "HLS byte-range source returned an unexpected range", {
      expected_start: byteRange.offset,
      expected_end: expectedEnd,
      actual_start: contentRange.start,
      actual_end: contentRange.end,
      actual_total_bytes: contentRange.size
    });
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength !== byteRange.length) {
    throw new AppError(400, "InvalidChunkSize", `HLS byte-range 大小必须为 ${formatHumanFileSize(byteRange.length)}（当前 ${formatHumanFileSize(contentLength)}）`, {
      expected_chunk_bytes: byteRange.length,
      actual_chunk_bytes: contentLength
    });
  }
}

function hlsSegmentEncryptionForAsset(asset: HlsAssetRecord, segmentIndex: number): HlsSegmentEncryption | null {
  const plan = parseHlsPlaylist(asset.playlist_text, new URL(asset.media_playlist_url));
  if (plan.kind !== "media") {
    throw new AppError(400, "InvalidHlsPlaylist", "HLS media playlist 无效");
  }

  return plan.segments[segmentIndex]?.encryption ?? null;
}

function hlsInitSegmentPlanForAsset(asset: HlsAssetRecord): HlsInitSegmentPlan | null {
  if (!asset.init_source_url) {
    return null;
  }

  const plan = parseHlsPlaylist(asset.playlist_text, new URL(asset.media_playlist_url));
  if (plan.kind !== "media") {
    throw new AppError(400, "InvalidHlsPlaylist", "HLS media playlist 无效");
  }

  return plan.initSegment ?? {
    uri: asset.init_source_url,
    rawUri: asset.init_source_url,
    byteRange: hlsInitByteRange(asset),
    encryption: null
  };
}

function hlsSegmentByteRange(segment: HlsSegmentRecord): HlsByteRange | null {
  return hlsByteRangeFromRecord(segment.byte_range_start, segment.byte_range_length, "HLS segment byte-range");
}

function hlsInitByteRange(asset: HlsAssetRecord): HlsByteRange | null {
  return hlsByteRangeFromRecord(asset.init_byte_range_start, asset.init_byte_range_length, "HLS init byte-range");
}

function hlsByteRangeFromRecord(
  start: number | null | undefined,
  length: number | null | undefined,
  label: string
): HlsByteRange | null {
  if (start === null || start === undefined || length === null || length === undefined) {
    return null;
  }

  if (
    !Number.isSafeInteger(start) ||
    Number(start) < 0 ||
    !Number.isSafeInteger(length) ||
    Number(length) <= 0
  ) {
    throw new AppError(409, "InvalidHlsByteRange", `${label} 无效`);
  }

  return {
    offset: Number(start),
    length: Number(length)
  };
}

async function decryptHlsSegmentBlob(
  blob: Blob,
  encryption: HlsSegmentEncryption,
  sourceHeaders?: RemoteRequestHeaders
): Promise<Blob> {
  const [keyBytes, encryptedBytes] = await Promise.all([
    fetchHlsAes128Key(new URL(encryption.keyUri), sourceHeaders),
    blob.arrayBuffer().catch(() => {
      throw new AppError(502, "HlsSegmentReadFailed", "HLS segment 读取失败");
    })
  ]);

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
  } catch {
    throw new AppError(400, "InvalidHlsKey", "HLS AES-128 key 无效");
  }

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: hexToArrayBuffer(encryption.ivHex) },
      cryptoKey,
      encryptedBytes
    );
  } catch {
    throw new AppError(400, "HlsSegmentDecryptFailed", "HLS segment 解密失败");
  }

  return new Blob([decrypted], { type: blob.type || "video/mp2t" });
}

async function fetchHlsAes128Key(keyUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(keyUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, { Accept: "application/octet-stream, */*" })
    });
  } catch {
    throw new AppError(502, "HlsKeyFetchFailed", "HLS key 获取失败");
  }

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "HlsKeyFetchFailed",
      `HLS key 返回 ${response.status}`,
      { source_status: response.status }
    );
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength !== HLS_AES_128_KEY_BYTES) {
    throw new AppError(400, "InvalidHlsKey", "HLS AES-128 key 必须是 16 字节");
  }

  const keyBytes = await response.arrayBuffer().catch(() => {
    throw new AppError(502, "HlsKeyReadFailed", "HLS key 读取失败");
  });

  if (keyBytes.byteLength !== HLS_AES_128_KEY_BYTES) {
    throw new AppError(400, "InvalidHlsKey", "HLS AES-128 key 必须是 16 字节");
  }

  return keyBytes;
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new AppError(400, "InvalidHlsPlaylist", "HLS IV 必须是 16 字节十六进制值");
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function ensureHlsSegmentMultipartUpload(params: {
  db: AppDatabase;
  asset: HlsAssetRecord;
  segment: HlsSegmentRecord;
  mimeType: string;
  size: number;
}): Promise<MultipartUploadRecord> {
  if (params.segment.multipart_upload_id) {
    const existing = await getMultipartUploadRecord(params.db, params.segment.multipart_upload_id);
    if (existing) {
      if (existing.size !== params.size) {
        throw new AppError(409, "HlsSegmentSizeChanged", "HLS segment 大小发生变化，请取消后重新导入");
      }
      return existing;
    }
  }

  validateMultipartFileSize(params.size);
  const chunkCount = Math.ceil(params.size / TELEGRAM_CHUNK_SIZE_BYTES);
  const now = new Date().toISOString();
  const sourceUrl = new URL(params.segment.source_url);
  const byteRange = hlsSegmentByteRange(params.segment);
  const upload = await insertMultipartUploadRecord(params.db, {
    id: crypto.randomUUID(),
    sourceKind: "url",
    sourceUrl: params.segment.source_url,
    ...(params.asset.source_headers_json ? { sourceHeadersJson: params.asset.source_headers_json } : {}),
    ...(byteRange ? { sourceRangeStart: byteRange.offset } : {}),
    fileName: hlsSegmentFileName(sourceUrl, params.segment.segment_index),
    mimeType: params.mimeType,
    size: params.size,
    chunkSize: TELEGRAM_CHUNK_SIZE_BYTES,
    chunkCount,
    directoryId: params.asset.directory_id ?? null,
    directoryPath: params.asset.directory_path ?? "/",
    createdAt: now,
    ...(params.asset.uploaded_by ? { uploadedBy: params.asset.uploaded_by } : {})
  });

  await attachHlsSegmentMultipartUpload({
    db: params.db,
    id: params.segment.id,
    multipartUploadId: upload.id,
    mimeType: params.mimeType,
    size: params.size,
    chunkSize: TELEGRAM_CHUNK_SIZE_BYTES,
    chunkCount,
    updatedAt: now
  });

  return upload;
}

async function hlsSegmentImportResult(db: AppDatabase, segment: HlsSegmentRecord): Promise<HlsSegmentImportResult> {
  if (!segment.multipart_upload_id) {
    return {
      segment,
      uploadedChunks: [],
      missingChunks: []
    };
  }

  const upload = await getMultipartUploadRecord(db, segment.multipart_upload_id);
  const chunks = await listFileChunkRecords(db, segment.multipart_upload_id);
  return {
    segment,
    uploadedChunks: chunks.map((chunk) => chunk.chunk_index),
    missingChunks: upload ? missingChunkIndexes(upload, chunks) : []
  };
}

async function requireHlsAsset(db: AppDatabase, assetId: string): Promise<HlsAssetRecord> {
  const asset = await getHlsAssetRecord(db, assetId);
  if (!asset) {
    throw new AppError(404, "HlsAssetNotFound", "HLS 上传任务不存在");
  }
  return asset;
}

async function requireMutableHlsAsset(db: AppDatabase, assetId: string): Promise<HlsAssetRecord> {
  const asset = await requireHlsAsset(db, assetId);
  if (asset.status === "done" || asset.status === "cancelled" || asset.final_file_id) {
    throw new AppError(409, "HlsAssetClosed", "HLS 上传任务已结束");
  }
  return asset;
}

async function requireHlsSegment(db: AppDatabase, assetId: string, segmentIndex: number): Promise<HlsSegmentRecord> {
  const segment = await getHlsSegmentRecordByIndex(db, assetId, segmentIndex);
  if (!segment) {
    throw new AppError(404, "HlsSegmentNotFound", "HLS segment 不存在");
  }
  return segment;
}

async function requireHlsSegmentMultipartUpload(db: AppDatabase, segment: HlsSegmentRecord): Promise<MultipartUploadRecord> {
  if (segment.storage_backend !== "telegram_multipart" || !segment.multipart_upload_id) {
    throw new AppError(400, "HlsSegmentNotMultipart", "该 HLS segment 不是大 segment 分片任务");
  }

  const upload = await getMultipartUploadRecord(db, segment.multipart_upload_id);
  if (!upload) {
    throw new AppError(404, "UploadNotFound", "HLS segment 分片会话不存在");
  }
  return upload;
}

function normalizeHlsSegmentIndex(value: string, segmentCount: number): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= segmentCount) {
    throw new AppError(400, "InvalidSegmentIndex", "HLS segment index 超出范围");
  }
  return index;
}

function validateCompleteHlsSegments(asset: HlsAssetRecord, segments: HlsSegmentRecord[]): void {
  if (asset.init_source_url) {
    requireHlsInitSegmentSize(asset);
    if (asset.init_status !== "done" || asset.init_storage_backend !== "telegram_single" || !asset.init_telegram_file_id) {
      throw new AppError(409, "HlsUploadIncomplete", "HLS init segment 尚未导入完成", {
        init_status: asset.init_status
      });
    }
  }

  if (segments.length !== asset.segment_count) {
    throw new AppError(409, "HlsUploadIncomplete", "HLS segment 数量不完整", {
      expected_segments: asset.segment_count,
      actual_segments: segments.length
    });
  }

  for (let index = 0; index < asset.segment_count; index += 1) {
    const segment = segments[index];
    if (!segment || segment.segment_index !== index || segment.status !== "done") {
      throw new AppError(409, "HlsUploadIncomplete", "仍有 HLS segment 未导入完成", {
        segment_index: index,
        status: segment?.status
      });
    }
    requireHlsSegmentSize(segment);
  }
}

function hlsInitSegmentSize(asset: HlsAssetRecord): number {
  return asset.init_source_url ? requireHlsInitSegmentSize(asset) : 0;
}

function requireHlsInitSegmentSize(asset: HlsAssetRecord): number {
  if (!Number.isSafeInteger(asset.init_size) || Number(asset.init_size) < 0) {
    throw new AppError(409, "HlsUploadIncomplete", "HLS init segment 缺少文件大小");
  }

  return Number(asset.init_size);
}

function requireHlsSegmentSize(segment: HlsSegmentRecord): number {
  if (!Number.isSafeInteger(segment.size) || Number(segment.size) < 0) {
    throw new AppError(409, "HlsUploadIncomplete", "HLS segment 缺少文件大小", {
      segment_index: segment.segment_index
    });
  }
  return Number(segment.size);
}

function errorMessageForServer(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "HLS segment 导入失败";
}

function serializeHlsProbeResult(result: HlsProbeResult): Record<string, unknown> {
  return {
    playlist_url: result.playlistUrl,
    file_name: result.fileName,
    kind: result.plan.kind,
    selected_variant_id: result.selectedVariantId ?? null,
    variants: result.plan.kind === "master" ? result.plan.variants.map(serializeHlsVariant) : [],
    media: result.media ? serializeHlsMediaPlan(result.media) : null
  };
}

function serializeHlsVariant(variant: HlsVariantPlan): Record<string, unknown> {
  return {
    id: variant.id,
    uri: variant.uri,
    bandwidth: variant.bandwidth ?? null,
    resolution: variant.resolution ?? null,
    codecs: variant.codecs ?? null
  };
}

function serializeHlsMediaPlan(plan: HlsMediaPlan): Record<string, unknown> {
  return {
    playlist_url: plan.playlistUrl,
    target_duration: plan.targetDuration,
    duration: plan.duration,
    segment_count: plan.segments.length
  };
}

async function serializeHlsUploadResult(
  db: AppDatabase,
  request: Request,
  env: AppEnv,
  result: HlsInitResult
): Promise<Record<string, unknown>> {
  return {
    asset: serializeHlsAsset(result.asset, request, env),
    segments: await Promise.all(result.segments.map((segment) => serializeHlsSegment(db, segment)))
  };
}

function serializeHlsAsset(asset: HlsAssetRecord, request: Request, env: AppEnv): Record<string, unknown> {
  const baseUrl = getPublicBaseUrl(request, env);
  return {
    id: asset.id,
    source_url: asset.source_url,
    media_playlist_url: asset.media_playlist_url,
    file_name: asset.file_name,
    mime_type: asset.mime_type,
    directory_id: asset.directory_id,
    directory_path: asset.directory_path ?? "/",
    status: asset.status,
    selected_variant_id: asset.selected_variant_id,
    target_duration: asset.target_duration_seconds,
    duration: asset.duration_seconds,
    segment_count: asset.segment_count,
    estimated_size: asset.estimated_size,
    final_file_id: asset.final_file_id,
    remark: asset.remark,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    completed_at: asset.completed_at,
    preview_playlist_url: `${baseUrl}/api/admin/uploads/hls/${encodeURIComponent(asset.id)}/preview.m3u8`
  };
}

async function serializeHlsSegment(db: AppDatabase, segment: HlsSegmentRecord): Promise<Record<string, unknown>> {
  const chunks = segment.multipart_upload_id
    ? await listFileChunkRecords(db, segment.multipart_upload_id)
    : [];
  const uploadedChunks = chunks.map((chunk) => chunk.chunk_index);
  const missingChunks = Number.isSafeInteger(segment.chunk_count) && Number(segment.chunk_count) > 0
    ? chunkRange(Number(segment.chunk_count)).filter((index) => !uploadedChunks.includes(index))
    : [];

  return {
    id: segment.id,
    asset_id: segment.asset_id,
    segment_index: segment.segment_index,
    source_url: segment.source_url,
    duration: segment.duration_seconds,
    mime_type: segment.mime_type,
    size: segment.size,
    storage_backend: segment.storage_backend,
    telegram_channel_id: segment.telegram_channel_id,
    multipart_upload_id: segment.multipart_upload_id,
    chunk_size: segment.chunk_size,
    chunk_count: segment.chunk_count,
    status: segment.status,
    attempts: segment.attempts,
    error_message: segment.error_message,
    uploaded_chunks: uploadedChunks,
    missing_chunks: missingChunks,
    completed_at: segment.completed_at
  };
}

function chunkRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

async function handleAdminApiKeys(request: Request, env: AppEnv): Promise<Response> {
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

async function handleAdminTelegramChannels(request: Request, env: AppEnv): Promise<Response> {
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

async function requireTelegramChannelUnique(paramsDb: AppDatabase, params: {
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

async function readUploadInput(request: Request, env: AppEnv): Promise<{
  file: File;
  remark?: string;
  directoryPath: string;
  conflictAction: FileNameConflictAction;
}> {
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
  const sourceHeaders = normalizeRemoteRequestHeaders(
    formData.get("headers") ??
    formData.get("source_headers") ??
    formData.get("request_headers")
  );
  const remark = normalizeRemark(formData.get("remark"));
  const directoryPath = normalizeDirectoryPath(formData.get("directory_path") ?? formData.get("dir") ?? "/");
  const conflictAction = normalizeFileNameConflictAction(formData.get("on_conflict"));

  if (formFile instanceof File) {
    validateUploadFileSize(formFile, maxFileBytes);
    const file = fileNameOverride ? renameUploadFile(formFile, fileNameOverride) : formFile;

    return {
      file,
      directoryPath,
      conflictAction,
      ...(remark ? { remark } : {})
    };
  }

  const sourceUrl = normalizeSourceUrl(formData.get("url"));
  if (sourceUrl) {
    const file = await downloadFileFromUrl({
      sourceUrl,
      env,
      maxFileBytes,
      ...(sourceHeaders ? { sourceHeaders } : {}),
      ...(fileNameOverride ? { fileName: fileNameOverride } : {})
    });

    return {
      file,
      directoryPath,
      conflictAction,
      ...(remark ? { remark } : {})
    };
  }

  throw new AppError(400, "MissingFile", "Multipart field 'file' is required");
}

async function readUrlUploadJson(request: Request, env: AppEnv): Promise<{
  file: File;
  remark?: string;
  directoryPath: string;
  conflictAction: FileNameConflictAction;
}> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const body = await readJsonObject(request);
  const sourceUrl = normalizeSourceUrl(body.url);
  const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
  const fileNameOverride = normalizeOptionalFileName(body.file_name);
  const conflictAction = normalizeFileNameConflictAction(body.on_conflict);

  if (!sourceUrl) {
    throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? body.dir ?? "/");
  const file = await downloadFileFromUrl({
    sourceUrl,
    env,
    maxFileBytes,
    ...(sourceHeaders ? { sourceHeaders } : {}),
    ...(fileNameOverride ? { fileName: fileNameOverride } : {})
  });
  const remark = normalizeRemark(body.remark);

  return {
    file,
    directoryPath,
    conflictAction,
    ...(remark ? { remark } : {})
  };
}

async function readCompleteUploadInput(
  request: Request,
  searchParams: URLSearchParams
): Promise<{ thumbnail?: ThumbnailInput; conflictAction: FileNameConflictAction }> {
  const queryConflictAction = searchParams.get("on_conflict");
  const contentType = request.headers.get("Content-Type") || "";
  const normalizedContentType = contentType.toLowerCase();

  if (!contentType) {
    return { conflictAction: normalizeFileNameConflictAction(queryConflictAction) };
  }

  if (normalizedContentType.includes("application/json")) {
    const body = await request.json() as unknown;
    const bodyConflictAction = isPlainRecord(body) ? body.on_conflict : undefined;
    return { conflictAction: normalizeFileNameConflictAction(bodyConflictAction ?? queryConflictAction) };
  }

  if (!normalizedContentType.includes("multipart/form-data")) {
    return { conflictAction: normalizeFileNameConflictAction(queryConflictAction) };
  }

  const formData = await request.formData();
  const conflictAction = normalizeFileNameConflictAction(formData.get("on_conflict") ?? queryConflictAction);
  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    return { conflictAction };
  }

  return {
    conflictAction,
    thumbnail: {
      file: thumbnail,
      ...optionalThumbnailDimensions(formData)
    }
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

function normalizeRemoteRequestHeaders(value: unknown): RemoteRequestHeaders | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const entries = remoteHeaderEntries(value);
  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length > MAX_REMOTE_REQUEST_HEADER_COUNT) {
    throw new AppError(400, "TooManySourceHeaders", `远端请求头最多支持 ${MAX_REMOTE_REQUEST_HEADER_COUNT} 个`);
  }

  const encoder = new TextEncoder();
  const result: RemoteRequestHeaders = {};
  const names = new Map<string, string>();
  let totalBytes = 0;

  for (const [rawName, rawValue] of entries) {
    const name = normalizeRemoteRequestHeaderName(rawName);
    const valueText = normalizeRemoteRequestHeaderValue(rawValue, name);

    if (!valueText) {
      continue;
    }

    const lowerName = name.toLowerCase();
    const previousName = names.get(lowerName);
    if (previousName) {
      delete result[previousName];
    }

    names.set(lowerName, name);
    result[name] = valueText;
    totalBytes += encoder.encode(name).byteLength + encoder.encode(valueText).byteLength;
  }

  if (Object.keys(result).length > MAX_REMOTE_REQUEST_HEADER_COUNT) {
    throw new AppError(400, "TooManySourceHeaders", `远端请求头最多支持 ${MAX_REMOTE_REQUEST_HEADER_COUNT} 个`);
  }

  if (totalBytes > MAX_REMOTE_REQUEST_HEADERS_BYTES) {
    throw new AppError(400, "SourceHeadersTooLarge", "远端请求头总大小过大");
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function remoteHeaderEntries(value: unknown): Array<[string, unknown]> {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return [];
    }

    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return remoteHeaderEntries(JSON.parse(text) as unknown);
      } catch {
        throw new AppError(400, "InvalidSourceHeaders", "远端请求头 JSON 无效");
      }
    }

    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator <= 0) {
          throw new AppError(400, "InvalidSourceHeaders", "远端请求头每行必须是 Header-Name: value 格式");
        }
        return [line.slice(0, separator), line.slice(separator + 1)] satisfies [string, string];
      });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        return [String(entry[0]), entry[1]] satisfies [string, unknown];
      }

      if (isPlainRecord(entry) && typeof entry.name === "string") {
        return [entry.name, entry.value] satisfies [string, unknown];
      }

      throw new AppError(400, "InvalidSourceHeaders", "远端请求头数组必须包含 {name, value}");
    });
  }

  if (isPlainRecord(value)) {
    return Object.entries(value);
  }

  throw new AppError(400, "InvalidSourceHeaders", "headers 必须是对象、数组或 Header-Name: value 文本");
}

function normalizeRemoteRequestHeaderName(value: string): string {
  const name = value.trim();
  const nameBytes = new TextEncoder().encode(name).byteLength;

  if (!name || nameBytes > MAX_REMOTE_REQUEST_HEADER_NAME_BYTES || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new AppError(400, "InvalidSourceHeaderName", `无效的远端请求头名称：${value}`);
  }

  const lowerName = name.toLowerCase();
  if (isBlockedRemoteRequestHeader(lowerName)) {
    throw new AppError(400, "UnsupportedSourceHeader", `不允许自定义远端请求头：${name}`);
  }

  return name;
}

function normalizeRemoteRequestHeaderValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidSourceHeaderValue", `远端请求头 ${name} 的值必须是字符串`);
  }

  const normalized = value.trim();
  if (!normalized) {
    return "";
  }

  if (/[\r\n]/.test(normalized)) {
    throw new AppError(400, "InvalidSourceHeaderValue", `远端请求头 ${name} 的值不能包含换行`);
  }

  if (new TextEncoder().encode(normalized).byteLength > MAX_REMOTE_REQUEST_HEADER_VALUE_BYTES) {
    throw new AppError(400, "SourceHeaderTooLarge", `远端请求头 ${name} 的值过大`);
  }

  return normalized;
}

function isBlockedRemoteRequestHeader(lowerName: string): boolean {
  return lowerName === "host" ||
    lowerName === "range" ||
    lowerName === "content-length" ||
    lowerName === "connection" ||
    lowerName === "keep-alive" ||
    lowerName === "proxy-authenticate" ||
    lowerName === "proxy-authorization" ||
    lowerName === "te" ||
    lowerName === "trailer" ||
    lowerName === "transfer-encoding" ||
    lowerName === "upgrade" ||
    lowerName === "accept-encoding" ||
    lowerName === "cf-connecting-ip" ||
    lowerName === "cf-ipcountry" ||
    lowerName === "cf-ray" ||
    lowerName === "cf-visitor" ||
    lowerName === "true-client-ip" ||
    lowerName === "x-forwarded-for" ||
    lowerName === "x-forwarded-host" ||
    lowerName === "x-forwarded-proto" ||
    lowerName === "x-real-ip";
}

function remoteRequestHeadersJson(headers: RemoteRequestHeaders | undefined): string | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  return JSON.stringify(Object.fromEntries(
    Object.entries(headers).sort(([left], [right]) => left.localeCompare(right, "en", { sensitivity: "base" }))
  ));
}

function storedRemoteRequestHeaders(value: string | null | undefined): RemoteRequestHeaders | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return normalizeRemoteRequestHeaders(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(500, "InvalidStoredSourceHeaders", "保存的远端请求头无效");
    }
    throw new AppError(500, "InvalidStoredSourceHeaders", "保存的远端请求头 JSON 无效");
  }
}

function remoteFetchHeaders(
  sourceHeaders: RemoteRequestHeaders | undefined,
  defaults: Record<string, string>,
  overrides: Record<string, string> = {}
): Headers {
  const headers = new Headers(defaults);

  for (const [name, value] of Object.entries(sourceHeaders ?? {})) {
    headers.set(name, value);
  }

  for (const [name, value] of Object.entries(overrides)) {
    headers.set(name, value);
  }

  return headers;
}

async function downloadFileFromUrl(params: {
  sourceUrl: URL;
  env: AppEnv;
  maxFileBytes: number;
  fileName?: string;
  sourceHeaders?: RemoteRequestHeaders;
}): Promise<File> {
  const signedFile = await downloadSignedFileUrl(params);
  if (signedFile) {
    return params.fileName ? renameUploadFile(signedFile, params.fileName) : signedFile;
  }

  let response: Response;

  try {
    response = await fetch(params.sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(params.sourceHeaders, { Accept: "*/*" })
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
  env: AppEnv;
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
  env: AppEnv;
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
  env: AppEnv;
  db?: AppDatabase;
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
  env: AppEnv;
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
  env: AppEnv,
  db: AppDatabase | undefined,
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
  env: AppEnv,
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

  const response = await limiter.fetch("https://telegram-rate-limiter/acquire", {
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

async function releaseTelegramApiSlot(env: AppEnv, slot: TelegramApiSlot): Promise<void> {
  if (slot.scope !== "sendDocument" || !slot.token || !env.TELEGRAM_RATE_LIMITER) {
    return;
  }

  try {
    await env.TELEGRAM_RATE_LIMITER.fetch("https://telegram-rate-limiter/release", {
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
  env: AppEnv,
  scope: TelegramRateLimitScope,
  channelId: string | undefined,
  error: unknown
): Promise<void> {
  const retryAfterSeconds = telegramRetryAfterSeconds(error);
  if (!retryAfterSeconds || !env.TELEGRAM_RATE_LIMITER) {
    return;
  }

  try {
    await env.TELEGRAM_RATE_LIMITER.fetch("https://telegram-rate-limiter/penalize", {
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

function channelCryptoSecret(env: AppEnv): string {
  return requireEnv({ LINK_SIGNING_SECRET: env.TG_CHANNEL_SECRET || env.LINK_SIGNING_SECRET }, "LINK_SIGNING_SECRET");
}

async function telegramChannelTokenHash(botToken: string): Promise<string> {
  return base64UrlEncodeLocal(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBufferLocal(textEncodeLocal(botToken)))));
}

async function encryptTelegramBotToken(botToken: string, env: AppEnv): Promise<string> {
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

async function decryptTelegramBotToken(encrypted: string, env: AppEnv): Promise<string> {
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

async function importTelegramChannelAesKey(env: AppEnv): Promise<CryptoKey> {
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

async function materializeTelegramChannel(record: TelegramChannelRecord, env: AppEnv): Promise<TelegramStorageChannel | null> {
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

function defaultEnvTelegramChannel(env: AppEnv): TelegramStorageChannel | null {
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

async function resolveTelegramChannel(env: AppEnv, db: AppDatabase | undefined, channelId: string | null | undefined): Promise<TelegramStorageChannel> {
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

async function listUploadTelegramChannels(env: AppEnv, db: AppDatabase | undefined): Promise<TelegramStorageChannel[]> {
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

async function serializeTelegramChannelRecord(record: TelegramChannelRecord, env: AppEnv): Promise<Record<string, unknown>> {
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
  db: AppDatabase;
  sourceKind: "local" | "url" | "magnet";
  sourceUrl?: string;
  sourceHeadersJson?: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath: string;
  conflictAction?: FileNameConflictAction;
}): Promise<MultipartInitResult> {
  validateMultipartFileSize(params.size);
  await requireFileNameWritable({
    db: params.db,
    directoryPath: params.directoryPath,
    fileName: params.fileName,
    conflictAction: params.conflictAction ?? "error"
  });
  const chunkCount = Math.ceil(params.size / TELEGRAM_CHUNK_SIZE_BYTES);
  const createdAt = new Date().toISOString();
  const record = await insertMultipartUploadRecord(params.db, {
    id: crypto.randomUUID(),
    sourceKind: params.sourceKind,
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    ...(params.sourceHeadersJson ? { sourceHeadersJson: params.sourceHeadersJson } : {}),
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
  options: { forceMultipart?: boolean; sourceHeaders?: RemoteRequestHeaders } = {}
): Promise<
  | { mode: "single" }
  | { mode: "multipart"; fileName: string; mimeType: string; size: number }
> {
  const head = await fetchRemoteHead(sourceUrl, options.sourceHeaders);
  let size = parseContentLength(head?.headers.get("Content-Length") ?? null);
  const initialFileName = inferRemoteFileName(sourceUrl, head?.headers ?? new Headers());
  const remoteMimeHint = pickRemoteMimeHint(head?.headers.get("Content-Type") ?? null, initialFileName);

  if (!options.forceMultipart && size !== undefined && size <= singleMaxFileBytes) {
    return { mode: "single" };
  }

  if (size !== undefined && size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size);
  }

  const rangeProbe = await fetchRemoteRange(sourceUrl, 0, 0, options.sourceHeaders);
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

async function fetchRemoteHead(sourceUrl: URL, sourceHeaders?: RemoteRequestHeaders): Promise<Response | undefined> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      method: "HEAD",
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, { Accept: "*/*" })
    });

    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

async function fetchRemoteRange(
  sourceUrl: URL,
  start: number,
  end: number,
  sourceHeaders?: RemoteRequestHeaders
): Promise<Response> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(sourceHeaders, { Accept: "*/*" }, { Range: `bytes=${start}-${end}` })
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
  env: AppEnv;
  uploadId?: string;
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
      ...(params.uploadId ? { upload_id: params.uploadId } : {}),
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

async function handleThumbnailSourceProxy(request: Request, env: AppEnv): Promise<Response> {
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

  const sourceHeaders = await thumbnailSourceRequestHeaders(env, payload);
  const rangeHeader = thumbnailProxyRangeHeader(request, payload);
  let response: Response;

  try {
    response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(
        sourceHeaders,
        { Accept: payload.kind === "image" ? "image/*" : "video/*" },
        rangeHeader ? { Range: rangeHeader } : {}
      )
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

async function thumbnailSourceRequestHeaders(
  env: AppEnv,
  payload: ThumbnailSourceTokenPayload
): Promise<RemoteRequestHeaders | undefined> {
  if (!payload.upload_id) {
    return undefined;
  }

  const db = requireDb(env);
  const upload = await getMultipartUploadRecord(db, payload.upload_id);
  if (!upload || upload.source_kind !== "url" || upload.source_url !== payload.url) {
    return undefined;
  }

  return storedRemoteRequestHeaders(upload.source_headers_json);
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
    (value.upload_id !== undefined && typeof value.upload_id !== "string") ||
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
    ...(value.upload_id ? { upload_id: value.upload_id.slice(0, 128) } : {}),
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
  db: AppDatabase,
  id: string,
  sourceKind?: "local" | "url" | "magnet"
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

async function requireFileRecord(db: AppDatabase, id: string): Promise<FileRecord> {
  const file = await getFileRecord(db, id);

  if (!file) {
    throw new AppError(404, "FileNotFound", "File record not found");
  }

  return file;
}

async function requireFileNameAvailable(params: {
  db: AppDatabase;
  directoryPath: string;
  fileName: string;
  excludeId?: string;
}): Promise<void> {
  const conflict = await findActiveFileNameConflict(params);

  if (conflict) {
    throw fileNameConflictError(params.directoryPath, params.fileName, conflict.source);
  }
}

async function requireFileNameWritable(params: {
  db: AppDatabase;
  directoryPath: string;
  fileName: string;
  conflictAction: FileNameConflictAction;
  excludeId?: string;
}): Promise<void> {
  if (params.conflictAction === "overwrite") {
    return;
  }

  await requireFileNameAvailable(params);
}

interface UploadPreflightEntry {
  client_id: string;
  directory_path: string;
  file_name: string;
  relative_path?: string;
  size?: number;
}

type UploadPreflightConflictSource = "file" | "batch";

type UploadPreflightResultEntry = UploadPreflightEntry & {
  status: "ready" | "conflict";
  source?: UploadPreflightConflictSource;
  suggested_name?: string;
  message?: string;
};

function normalizeUploadPreflightEntries(value: unknown): UploadPreflightEntry[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", "entries must be an array");
  }

  if (value.length === 0) {
    throw new AppError(400, "InvalidBody", "entries must not be empty");
  }

  if (value.length > 1000) {
    throw new AppError(400, "InvalidBody", "entries must contain at most 1000 files");
  }

  return value.map((item, index) => {
    if (!isPlainRecord(item)) {
      throw new AppError(400, "InvalidBody", `entries[${index}] must be an object`);
    }

    const clientId = stringField(item.client_id, `entries[${index}].client_id`);
    const fileName = sanitizeFileName(stringField(item.file_name, `entries[${index}].file_name`));
    const directoryPath = normalizeDirectoryPath(item.directory_path ?? "/");
    const relativePath = optionalTrimmedString(item.relative_path, 512);
    const size = optionalNonNegativeInteger(item.size, `entries[${index}].size`);

    return {
      client_id: clientId,
      directory_path: directoryPath,
      file_name: fileName,
      ...(relativePath ? { relative_path: relativePath } : {}),
      ...(size !== undefined ? { size } : {})
    };
  });
}

async function preflightUploadEntries(
  db: AppDatabase,
  entries: UploadPreflightEntry[]
): Promise<UploadPreflightResultEntry[]> {
  const seenTargets = new Map<string, string>();
  const results: UploadPreflightResultEntry[] = [];

  for (const entry of entries) {
    const targetKey = `${entry.directory_path}\u0000${entry.file_name}`;
    const firstClientId = seenTargets.get(targetKey);

    if (firstClientId) {
      results.push({
        ...entry,
        status: "conflict",
        source: "batch",
        suggested_name: suggestAlternativeFileName(entry.file_name),
        message: "本次上传队列中已有相同目标路径的文件"
      });
      continue;
    }

    seenTargets.set(targetKey, entry.client_id);
    const conflict = await findActiveFileNameConflict({
      db,
      directoryPath: entry.directory_path,
      fileName: entry.file_name
    });

    if (conflict) {
      results.push({
        ...entry,
        status: "conflict",
        source: conflict.source,
        suggested_name: suggestAlternativeFileName(entry.file_name),
        message: "目标目录已存在同名文件"
      });
      continue;
    }

    results.push({
      ...entry,
      status: "ready"
    });
  }

  return results;
}

async function requireFileMoveNamesAvailable(params: {
  db: AppDatabase;
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

function normalizeFileNameConflictAction(value: unknown): FileNameConflictAction {
  if (value === undefined || value === null || value === "") {
    return "error";
  }

  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "on_conflict must be error or overwrite");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "error") {
    return "error";
  }

  if (normalized === "overwrite") {
    return "overwrite";
  }

  throw new AppError(400, "InvalidBody", "on_conflict must be error or overwrite");
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
  const sourceHeaders = storedRemoteRequestHeaders(upload.source_headers_json);
  const expectedSize = expectedChunkSize(upload, chunkIndex);
  const sourceRangeStart = Number.isSafeInteger(upload.source_range_start)
    ? Number(upload.source_range_start)
    : 0;
  const start = sourceRangeStart + chunkIndex * upload.chunk_size;
  const end = start + expectedSize - 1;
  const response = await fetchRemoteRange(sourceUrl, start, end, sourceHeaders);

  validateRemoteChunkResponse({
    response,
    upload,
    start,
    end,
    expectedSize,
    sourceRangeStart: upload.source_range_start ?? null
  });

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
  env: AppEnv;
  db: AppDatabase;
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
  sourceRangeStart: number | null;
}): void {
  if (params.response.status !== 206) {
    throw new AppError(400, "RangeNotSupported", "Source URL must return 206 for chunk Range requests");
  }

  const contentRange = parseContentRange(params.response.headers.get("Content-Range"));
  if (!contentRange) {
    throw new AppError(400, "RangeNotSupported", "Source URL must include Content-Range for chunk Range requests");
  }

  const rangeMode = params.sourceRangeStart !== null;
  const invalidRange = contentRange.start !== params.start ||
    contentRange.end !== params.end ||
    (!rangeMode && contentRange.size !== params.upload.size) ||
    (rangeMode && contentRange.size < params.end + 1);
  if (invalidRange) {
    throw new AppError(400, "InvalidChunkRange", "Source URL returned an unexpected byte range", {
      expected_start: params.start,
      expected_end: params.end,
      expected_total_bytes: rangeMode ? undefined : params.upload.size,
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
  env: AppEnv;
  db: AppDatabase;
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
  env: AppEnv;
  db: AppDatabase;
  upload: MultipartUploadRecord;
  conflictAction?: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
}): Promise<UploadResult> {
  const chunks = await listFileChunkRecords(params.db, params.upload.id);
  validateCompleteChunks(params.upload, chunks);
  await requireFileNameWritable({
    db: params.db,
    directoryPath: params.upload.directory_path ?? "/",
    fileName: params.upload.file_name,
    excludeId: params.upload.id,
    conflictAction: params.conflictAction ?? "error"
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
    conflictAction: params.conflictAction ?? "error",
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
  env: AppEnv;
  db: AppDatabase;
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
  env: AppEnv;
  db: AppDatabase;
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
  env: AppEnv;
  file: File;
  db?: AppDatabase;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath?: string;
  conflictAction?: FileNameConflictAction;
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
    const conflictAction = params.conflictAction ?? "error";
    await requireFileNameWritable({
      db: params.db,
      directoryPath: params.directoryPath ?? "/",
      fileName: storedName,
      conflictAction
    });
    await insertFileRecordWithConflictAction({
      db: params.db,
      conflictAction,
      record: {
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
      }
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

async function createFilePathForRecord(record: FileRecord, fileName: string, env: AppEnv): Promise<string> {
  const signingSecret = requireEnv(env, "LINK_SIGNING_SECRET");
  const iat = Math.floor(Date.now() / 1000);
  const storageBackend = fileStorageBackend(record);

  if (storageBackend === "hls_package") {
    const hlsAssetId = record.telegram_file_id.startsWith("hls:")
      ? record.telegram_file_id.slice("hls:".length)
      : record.id;
    const token = await createSignedToken(
      {
        v: 4,
        hls_asset_id: hlsAssetId,
        file_record_id: record.id,
        name: fileName,
        mime_type: record.mime_type,
        size: record.size,
        iat
      },
      signingSecret
    );

    return hlsPublicFilePath(token, fileName);
  }

  const token = storageBackend === "telegram_multipart"
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

async function handleFileAccess(request: Request, env: AppEnv): Promise<Response> {
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

  if (payload.v === 4) {
    throw new AppError(400, "NotHlsRoute", "HLS files must be accessed through /hls");
  }

  const db = env.DATABASE;
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

async function handleHlsAccess(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const access = extractHlsAccess(url.pathname);
  const payload = await verifySignedToken(access.token, requireEnv(env, "LINK_SIGNING_SECRET"));

  if (payload.v !== 4) {
    throw new AppError(400, "NotHlsFile", "HLS access token is required");
  }

  const db = requireDb(env);
  const asset = await getHlsAssetRecord(db, payload.hls_asset_id);
  if (!asset || asset.final_file_id !== payload.file_record_id || asset.status !== "done") {
    throw new AppError(404, "HlsAssetNotFound", "HLS 文件不存在");
  }

  if (access.segmentIndex !== undefined) {
    const segment = await requireHlsSegment(db, asset.id, access.segmentIndex);
    if (access.chunkIndex !== undefined) {
      return serveHlsSegmentChunk({
        env,
        db,
        segment,
        chunkIndex: access.chunkIndex,
        rangeHeader: request.headers.get("Range"),
        forceDownload: url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true"
      });
    }

    return serveStoredHlsSegment({
      env,
      db,
      segment,
      rangeHeader: request.headers.get("Range"),
      forceDownload: url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true"
    });
  }

  if (access.initSegment) {
    return serveStoredHlsInitSegment({
      env,
      db,
      asset,
      rangeHeader: request.headers.get("Range"),
      forceDownload: url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true"
    });
  }

  const segments = await listHlsSegmentRecords(db, asset.id);
  validateCompleteHlsSegments(asset, segments);
  const forceDownload = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

  if (forceDownload) {
    const downloadInfo = hlsDownloadAvailability(asset, segments);
    if (!downloadInfo.downloadable) {
      throw new AppError(400, "UnsupportedHlsDownload", "当前仅支持 TS 或 fMP4 HLS 顺序合并下载");
    }
    if (!downloadInfo.directAccess) {
      throw new AppError(
        403,
        "DirectAccessDisabled",
        "该 HLS 文件超过系统直链大小上限，不提供整包直链下载，请在控制台使用加速下载",
        {
          hls_download_part_count: downloadInfo.partCount,
          direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
        }
      );
    }

    return serveHlsPackageDownload({
      env,
      db,
      asset,
      segments,
      fileName: payload.name
    });
  }

  const baseUrl = getPublicBaseUrl(request, env);
  const playlist = buildRewrittenMediaPlaylist({
    playlistText: asset.playlist_text,
    targetDuration: asset.target_duration_seconds,
    initSegmentPath: hlsAssetHasDoneInitSegment(asset)
      ? `${baseUrl}${hlsPublicInitSegmentPath(access.token, asset)}`
      : null,
    segments: segments.map((segment) => ({
      index: segment.segment_index,
      duration: segment.duration_seconds,
      path: `${baseUrl}${hlsPublicSegmentPath(access.token, segment)}`
    }))
  });
  const headers = withSecurityHeaders();
  headers.set("Content-Type", `${HLS_PLAYLIST_MIME_TYPE}; charset=utf-8`);
  headers.set("Content-Disposition", contentDispositionInline(payload.name));
  headers.set("Cache-Control", "public, max-age=60");

  return new Response(playlist, { headers });
}

async function handleAdminHlsPreviewPlaylist(request: Request, env: AppEnv, assetId: string): Promise<Response> {
  const db = requireDb(env);
  const asset = await requireHlsAsset(db, assetId);
  const doneSegments = leadingDoneHlsSegments(await listHlsSegmentRecords(db, asset.id), HLS_PREVIEW_SEGMENT_COUNT);

  if (doneSegments.length === 0) {
    throw new AppError(409, "HlsPreviewNotReady", "至少需要完成 1 个 HLS segment 后才能生成预览 playlist");
  }

  if (asset.init_source_url && !hlsAssetHasDoneInitSegment(asset)) {
    throw new AppError(409, "HlsPreviewNotReady", "HLS init segment 尚未导入完成");
  }

  const baseUrl = new URL(request.url).origin;
  const playlist = buildRewrittenMediaPlaylist({
    targetDuration: asset.target_duration_seconds,
    initSegmentPath: asset.init_source_url
      ? `${baseUrl}/api/admin/uploads/hls/${encodeURIComponent(asset.id)}/preview-init/${encodeURIComponent(hlsInitSegmentFileName(new URL(asset.init_source_url)))}`
      : null,
    segments: doneSegments.map((segment) => ({
      index: segment.segment_index,
      duration: segment.duration_seconds,
      path: `${baseUrl}/api/admin/uploads/hls/${encodeURIComponent(asset.id)}/preview-segments/${segment.segment_index}`
    }))
  });
  const headers = withSecurityHeaders();
  headers.set("Content-Type", `${HLS_PLAYLIST_MIME_TYPE}; charset=utf-8`);
  headers.set("Cache-Control", "no-store");

  return new Response(playlist, { headers });
}

async function serveHlsPackageDownload(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  segments: HlsSegmentRecord[];
  fileName: string;
}): Promise<Response> {
  const availability = hlsDownloadAvailability(params.asset, params.segments);
  if (!availability.downloadable || !availability.kind) {
    throw new AppError(400, "UnsupportedHlsDownload", "当前仅支持 TS 或 fMP4 HLS 顺序合并下载");
  }

  const totalSize = hlsDownloadTotalSize(params.asset, params.segments, availability.kind);
  const headers = withSecurityHeaders();
  headers.set("Content-Type", hlsDownloadContentType(availability.kind));
  headers.set("Content-Disposition", contentDispositionAttachment(hlsDownloadFileName(params.fileName, availability.kind)));
  headers.set("Content-Length", String(totalSize));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(streamHlsSegmentsForDownload({
    env: params.env,
    db: params.db,
    asset: params.asset,
    segments: params.segments,
    kind: availability.kind
  }), { headers });
}

async function serveStoredHlsInitSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!params.asset.init_source_url) {
    throw new AppError(404, "HlsInitSegmentNotFound", "HLS init segment 不存在");
  }

  if (!hlsAssetHasDoneInitSegment(params.asset)) {
    throw new AppError(404, "HlsInitSegmentNotReady", "HLS init segment 尚未导入完成");
  }

  const size = requireHlsInitSegmentSize(params.asset);
  const range = parseByteRange(params.rangeHeader, size);
  if (!range) {
    return rangeNotSatisfiableResponse(size);
  }

  const channel = await resolveTelegramChannel(params.env, params.db, params.asset.init_telegram_channel_id);
  const initTelegramFileId = params.asset.init_telegram_file_id;
  if (!initTelegramFileId) {
    throw new AppError(404, "HlsInitSegmentNotFound", "HLS init segment 文件不存在");
  }
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: initTelegramFileId
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: range.partial ? `bytes=${range.start}-${range.end}` : null
  });

  if (range.partial && telegramResponse.status !== 206 && (range.start !== 0 || range.end !== size - 1)) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
  }

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const headers = hlsInitSegmentHeaders(params.asset, range, params.forceDownload, telegramResponse.headers.get("Content-Type"));
  copyHeader(telegramResponse.headers, headers, "Content-Range");

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    statusText: telegramResponse.statusText,
    headers
  });
}

async function serveStoredHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (params.segment.status !== "done") {
    throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
  }

  if (params.segment.storage_backend === "telegram_single") {
    return serveSingleHlsSegment(params);
  }

  if (params.segment.storage_backend === "telegram_multipart") {
    return serveMultipartHlsSegment(params);
  }

  throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
}

async function serveSingleHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!params.segment.telegram_file_id || !Number.isSafeInteger(params.segment.size)) {
    throw new AppError(404, "HlsSegmentNotFound", "HLS segment 文件不存在");
  }

  const size = Number(params.segment.size);
  const range = parseByteRange(params.rangeHeader, size);
  if (!range) {
    return rangeNotSatisfiableResponse(size);
  }

  const channel = await resolveTelegramChannel(params.env, params.db, params.segment.telegram_channel_id);
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken: channel.botToken,
    channelId: channel.id,
    fileId: params.segment.telegram_file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: range.partial ? `bytes=${range.start}-${range.end}` : null
  });

  if (range.partial && telegramResponse.status !== 206 && (range.start !== 0 || range.end !== size - 1)) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
  }

  const headers = hlsSegmentHeaders(params.segment, range, params.forceDownload);
  copyHeader(telegramResponse.headers, headers, "Content-Range");

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    statusText: telegramResponse.statusText,
    headers
  });
}

async function serveMultipartHlsSegment(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!params.segment.multipart_upload_id || !Number.isSafeInteger(params.segment.size)) {
    throw new AppError(404, "HlsSegmentNotFound", "HLS segment 分片文件不存在");
  }

  const uploadId = params.segment.multipart_upload_id;
  const chunkSize = requirePositiveRecordInteger(params.segment.chunk_size, "chunk_size");
  const chunkCount = requirePositiveRecordInteger(params.segment.chunk_count, "chunk_count");
  const size = Number(params.segment.size);
  const chunks = await listFileChunkRecords(params.db, uploadId);
  const payload = {
    v: 2 as const,
    file_record_id: uploadId,
    name: hlsSegmentFileName(new URL(params.segment.source_url), params.segment.segment_index),
    mime_type: params.segment.mime_type,
    size,
    chunk_size: chunkSize,
    chunk_count: chunkCount,
    iat: Math.floor(Date.now() / 1000)
  };

  validateTokenChunks(payload, chunks);
  const range = parseByteRange(params.rangeHeader, size);
  if (!range) {
    return rangeNotSatisfiableResponse(size);
  }

  return new Response(streamMultipartFile({
    env: params.env,
    payload,
    chunks,
    range
  }), {
    status: range.partial ? 206 : 200,
    headers: hlsSegmentHeaders(params.segment, range, params.forceDownload)
  });
}

async function serveHlsSegmentChunk(params: {
  env: AppEnv;
  db: AppDatabase;
  segment: HlsSegmentRecord;
  chunkIndex: number;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (params.segment.status !== "done") {
    throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
  }

  if (params.segment.storage_backend !== "telegram_multipart" || !params.segment.multipart_upload_id) {
    if (params.segment.storage_backend === "telegram_single" && params.chunkIndex === 0) {
      return serveSingleHlsSegment(params);
    }

    throw new AppError(400, "NotMultipartHlsSegment", "HLS segment chunk download is only available for multipart segments");
  }

  const chunkSize = requirePositiveRecordInteger(params.segment.chunk_size, "chunk_size");
  const chunkCount = requirePositiveRecordInteger(params.segment.chunk_count, "chunk_count");
  const segmentSize = requireHlsSegmentSize(params.segment);

  if (!Number.isSafeInteger(params.chunkIndex) || params.chunkIndex < 0 || params.chunkIndex >= chunkCount) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  const chunk = await getFileChunkRecord(params.db, params.segment.multipart_upload_id, params.chunkIndex);
  const expectedSize = expectedRecordChunkSize(segmentSize, chunkSize, chunkCount, params.chunkIndex);
  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "HLS segment chunk was not found");
  }

  const range = parseByteRange(params.rangeHeader, chunk.size);
  if (!range) {
    return rangeNotSatisfiableResponse(chunk.size);
  }

  const channel = await resolveTelegramChannel(params.env, params.db, chunk.telegram_channel_id);
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

  const fileName = recordChunkDownloadFileName(
    hlsSegmentFileName(new URL(params.segment.source_url), params.segment.segment_index),
    chunkCount,
    params.chunkIndex
  );
  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.segment.mime_type || telegramResponse.headers.get("Content-Type") || "video/mp2t");
  headers.set(
    "Content-Disposition",
    params.forceDownload ? contentDispositionAttachment(fileName) : contentDispositionInline(fileName)
  );
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${chunk.size}`);
  }
  headers.set("X-HLS-Segment-Index", String(params.segment.segment_index));
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(chunkCount));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * chunkSize));

  return new Response(telegramResponse.body, {
    status: range.partial ? 206 : 200,
    headers
  });
}

function hlsSegmentHeaders(
  segment: HlsSegmentRecord,
  range: ParsedByteRange,
  forceDownload: boolean
): Headers {
  const fileName = hlsSegmentFileName(new URL(segment.source_url), segment.segment_index);
  const headers = withSecurityHeaders();
  headers.set("Content-Type", segment.mime_type || "video/mp2t");
  headers.set(
    "Content-Disposition",
    forceDownload ? contentDispositionAttachment(fileName) : contentDispositionInline(fileName)
  );
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial && Number.isSafeInteger(segment.size)) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${Number(segment.size)}`);
  }
  return headers;
}

function hlsInitSegmentHeaders(
  asset: HlsAssetRecord,
  range: ParsedByteRange,
  forceDownload: boolean,
  telegramContentType: string | null
): Headers {
  const fileName = asset.init_source_url ? hlsInitSegmentFileName(new URL(asset.init_source_url)) : "init.mp4";
  const headers = withSecurityHeaders();
  headers.set("Content-Type", asset.init_mime_type || telegramContentType || "video/mp4");
  headers.set(
    "Content-Disposition",
    forceDownload ? contentDispositionAttachment(fileName) : contentDispositionInline(fileName)
  );
  headers.set("Content-Length", String(range.end - range.start + 1));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  if (range.partial && Number.isSafeInteger(asset.init_size)) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${Number(asset.init_size)}`);
  }
  return headers;
}

function streamHlsSegmentsForDownload(params: {
  env: AppEnv;
  db: AppDatabase;
  asset: HlsAssetRecord;
  segments: HlsSegmentRecord[];
  kind: HlsDownloadKind;
}): ReadableStream<Uint8Array> {
  const items = hlsDownloadItems(params.asset, params.segments, params.kind);
  let itemIndex = 0;
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
              itemIndex += 1;
              continue;
            }

            if (value) {
              controller.enqueue(value);
              return;
            }
            continue;
          }

          const item = items[itemIndex];
          if (!item) {
            controller.close();
            return;
          }

          const response = item.kind === "init"
            ? await serveStoredHlsInitSegment({
                env: params.env,
                db: params.db,
                asset: params.asset,
                rangeHeader: null,
                forceDownload: false
              })
            : await serveStoredHlsSegment({
                env: params.env,
                db: params.db,
                segment: item.segment,
                rangeHeader: null,
                forceDownload: false
              });

          if (!response.body) {
            throw new AppError(502, "HlsDownloadFailed", "HLS segment response did not include a body");
          }

          reader = response.body.getReader();
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

function leadingDoneHlsSegments(segments: HlsSegmentRecord[], limit: number): HlsSegmentRecord[] {
  const result: HlsSegmentRecord[] = [];
  for (const segment of segments) {
    if (segment.segment_index !== result.length || segment.status !== "done") {
      break;
    }
    result.push(segment);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function isDownloadableTsSegment(segment: HlsSegmentRecord): boolean {
  const sourcePath = new URL(segment.source_url).pathname.toLowerCase();
  const mimeType = segment.mime_type.toLowerCase();
  return sourcePath.endsWith(".ts") || mimeType === "video/mp2t";
}

function isDownloadableFmp4Segment(segment: HlsSegmentRecord): boolean {
  const sourcePath = new URL(segment.source_url).pathname.toLowerCase();
  const mimeType = segment.mime_type.toLowerCase();
  return sourcePath.endsWith(".m4s") ||
    sourcePath.endsWith(".mp4") ||
    sourcePath.endsWith(".m4v") ||
    sourcePath.endsWith(".m4a") ||
    sourcePath.endsWith(".cmfv") ||
    sourcePath.endsWith(".cmfa") ||
    mimeType === "video/mp4" ||
    mimeType === "audio/mp4" ||
    mimeType === "application/mp4";
}

type HlsDownloadKind = "ts" | "fmp4";

type HlsDownloadItem =
  | { kind: "init" }
  | { kind: "segment"; segment: HlsSegmentRecord };

function hlsAssetHasDoneInitSegment(asset: HlsAssetRecord): boolean {
  return Boolean(
    asset.init_source_url &&
    asset.init_status === "done" &&
    asset.init_storage_backend === "telegram_single" &&
    asset.init_telegram_file_id &&
    Number.isSafeInteger(asset.init_size) &&
    Number(asset.init_size) >= 0
  );
}

function hlsDownloadItems(asset: HlsAssetRecord, segments: HlsSegmentRecord[], kind: HlsDownloadKind): HlsDownloadItem[] {
  const segmentItems = segments.map((segment) => ({ kind: "segment" as const, segment }));
  return kind === "fmp4" ? [{ kind: "init" }, ...segmentItems] : segmentItems;
}

function hlsDownloadTotalSize(asset: HlsAssetRecord, segments: HlsSegmentRecord[], kind: HlsDownloadKind): number {
  return (kind === "fmp4" ? requireHlsInitSegmentSize(asset) : 0) +
    segments.reduce((total, segment) => total + requireHlsSegmentSize(segment), 0);
}

function hlsDownloadContentType(kind: HlsDownloadKind): string {
  return kind === "fmp4" ? "video/mp4" : "video/mp2t";
}

function hlsDownloadFileName(fileName: string, kind: HlsDownloadKind): string {
  const normalized = sanitizeFileName(fileName);
  return normalized.replace(/\.m3u8$/i, "") + (kind === "fmp4" ? ".mp4" : ".ts");
}

function hlsDownloadAvailability(asset: HlsAssetRecord, segments: HlsSegmentRecord[]): {
  downloadable: boolean;
  kind: HlsDownloadKind | null;
  partCount: number;
  directAccess: boolean;
} {
  const kind: HlsDownloadKind | null = !asset.init_source_url && segments.every(isDownloadableTsSegment)
    ? "ts"
    : hlsAssetHasDoneInitSegment(asset) && segments.every(isDownloadableFmp4Segment)
      ? "fmp4"
      : null;
  const partCount = kind
    ? hlsDownloadItems(asset, segments, kind).reduce((total, item) =>
        total + (item.kind === "init" ? 1 : hlsSegmentDownloadPartCount(item.segment)),
        0
      )
    : 0;
  const totalSize = kind ? hlsDownloadTotalSize(asset, segments, kind) : 0;

  return {
    downloadable: kind !== null,
    kind,
    partCount,
    directAccess: kind !== null && partCount > 0 && totalSize <= DIRECT_MULTIPART_ACCESS_MAX_BYTES
  };
}

function hlsSegmentDownloadPartCount(segment: HlsSegmentRecord): number {
  if (segment.storage_backend === "telegram_multipart") {
    return requirePositiveRecordInteger(segment.chunk_count, "chunk_count");
  }

  if (segment.storage_backend === "telegram_single") {
    return 1;
  }

  throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
}

async function handleMultipartChunkAccess(params: {
  env: AppEnv;
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
  env: AppEnv;
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
  env: AppEnv;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!canDirectlyAccessMultipartPayload(params.payload)) {
    throw new AppError(
      403,
      "DirectAccessDisabled",
      "该文件超过系统直链大小上限，不提供完整文件访问链接，请在控制台使用加速下载",
      {
        size: params.payload.size,
        chunk_count: params.payload.chunk_count,
        direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
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
  env: AppEnv;
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
          const channel = await resolveTelegramChannel(params.env, params.env.DATABASE, chunk.telegram_channel_id);
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

async function requireUploadApiKey(request: Request, db: AppDatabase): Promise<ApiKeyRecord> {
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

async function hlsDownloadSummaryForFile(db: AppDatabase, file: FileRecord): Promise<{
  segment_count: number;
  kind: HlsDownloadKind | null;
  part_count: number;
  direct_access: boolean;
  direct_access_max_parts: number;
  downloadable: boolean;
}> {
  const { asset, segments } = await requireHlsDownloadRecordsForFile(db, file);
  validateCompleteHlsSegments(asset, segments);
  const availability = hlsDownloadAvailability(asset, segments);

  return {
    segment_count: asset.segment_count,
    kind: availability.kind,
    part_count: availability.partCount,
    direct_access: availability.directAccess,
    direct_access_max_parts: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    downloadable: availability.downloadable
  };
}

async function serializeHlsDownloadPlanForFile(params: {
  request: Request;
  env: AppEnv;
  db: AppDatabase;
  file: FileRecord;
}): Promise<Record<string, unknown>> {
  if (fileStorageBackend(params.file) !== "hls_package") {
    throw new AppError(400, "NotHlsFile", "Only HLS package files have HLS download plans");
  }

  const { asset, segments } = await requireHlsDownloadRecordsForFile(params.db, params.file);
  validateCompleteHlsSegments(asset, segments);
  const availability = hlsDownloadAvailability(asset, segments);
  if (!availability.downloadable || !availability.kind) {
    throw new AppError(400, "UnsupportedHlsDownload", "当前仅支持 TS 或 fMP4 HLS 顺序合并下载");
  }

  const token = await createHlsAccessTokenForFile(params.file, params.env);
  const baseUrl = getPublicBaseUrl(params.request, params.env);
  let offset = 0;
  let partIndex = 0;
  const parts: Array<Record<string, unknown>> = [];

  if (availability.kind === "fmp4") {
    const initSize = requireHlsInitSegmentSize(asset);
    parts.push({
      index: partIndex,
      kind: "init",
      segment_index: null,
      chunk_index: null,
      offset,
      size: initSize,
      url: `${baseUrl}${hlsPublicInitSegmentPath(token, asset)}`
    });
    offset += initSize;
    partIndex += 1;
  }

  for (const segment of segments) {
    const segmentSize = requireHlsSegmentSize(segment);

    if (segment.storage_backend === "telegram_multipart") {
      const chunkSize = requirePositiveRecordInteger(segment.chunk_size, "chunk_size");
      const chunkCount = requirePositiveRecordInteger(segment.chunk_count, "chunk_count");
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const size = expectedRecordChunkSize(segmentSize, chunkSize, chunkCount, chunkIndex);
        parts.push({
          index: partIndex,
          kind: "segment",
          segment_index: segment.segment_index,
          chunk_index: chunkIndex,
          offset,
          size,
          url: `${baseUrl}${hlsPublicSegmentChunkPath(token, segment.segment_index, chunkIndex)}`
        });
        offset += size;
        partIndex += 1;
      }
      continue;
    }

    if (segment.storage_backend !== "telegram_single") {
      throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
    }

    parts.push({
      index: partIndex,
      kind: "segment",
      segment_index: segment.segment_index,
      chunk_index: null,
      offset,
      size: segmentSize,
      url: `${baseUrl}${hlsPublicSegmentPath(token, segment)}`
    });
    offset += segmentSize;
    partIndex += 1;
  }

  return {
    file_id: params.file.id,
    file_name: hlsDownloadFileName(params.file.file_name, availability.kind),
    kind: availability.kind,
    total_size: offset,
    segment_count: asset.segment_count,
    part_count: parts.length,
    direct_access: availability.directAccess,
    direct_access_max_parts: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    parts
  };
}

async function requireHlsDownloadRecordsForFile(
  db: AppDatabase,
  file: FileRecord
): Promise<{ asset: HlsAssetRecord; segments: HlsSegmentRecord[] }> {
  const assetId = file.telegram_file_id.startsWith("hls:")
    ? file.telegram_file_id.slice("hls:".length)
    : file.id;
  const asset = await getHlsAssetRecordByFinalFileId(db, file.id) ?? await getHlsAssetRecord(db, assetId);

  if (!asset || asset.final_file_id !== file.id || asset.status !== "done") {
    throw new AppError(404, "HlsAssetNotFound", "HLS 文件不存在");
  }

  const segments = await listHlsSegmentRecords(db, asset.id);
  return { asset, segments };
}

async function createHlsAccessTokenForFile(file: FileRecord, env: AppEnv): Promise<string> {
  const assetId = file.telegram_file_id.startsWith("hls:")
    ? file.telegram_file_id.slice("hls:".length)
    : file.id;

  return createSignedToken(
    {
      v: 4,
      hls_asset_id: assetId,
      file_record_id: file.id,
      name: file.file_name,
      mime_type: file.mime_type,
      size: file.size,
      iat: Math.floor(Date.now() / 1000)
    },
    requireEnv(env, "LINK_SIGNING_SECRET")
  );
}

async function serializeFileRecord(file: FileRecord, baseUrl: string, db: AppDatabase): Promise<Record<string, unknown>> {
  const storageBackend = fileStorageBackend(file);
  const directAccess = canDirectlyAccessFileRecord(file);
  const filePath = publicFilePathForResponse(file.file_path, storageBackend);
  const url = directAccess ? `${baseUrl}${filePath}` : null;
  const hlsDownload = storageBackend === "hls_package"
    ? await hlsDownloadSummaryForFile(db, file)
    : null;
  const directDownload = hlsDownload ? hlsDownload.direct_access : directAccess;
  const thumbnailUrl = file.thumbnail_file_path && file.thumbnail_status === "ready"
    ? `${baseUrl}${file.thumbnail_file_path}`
    : null;

  return {
    ...file,
    file_path: filePath,
    directory_id: file.directory_id ?? null,
    directory_path: file.directory_path ?? "/",
    storage_backend: storageBackend,
    chunk_size: storageBackend === "telegram_multipart" ? file.chunk_size ?? null : null,
    chunk_count: storageBackend === "telegram_multipart" ? file.chunk_count ?? null : null,
    direct_access: directAccess,
    direct_download: directDownload,
    download_strategy: downloadStrategy(storageBackend, directDownload),
    url,
    download_url: url && directDownload ? appendDownloadParam(url) : null,
    hls_download: hlsDownload,
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
    direct_access: canDirectlyAccessMultipartMetadata(result.size, result.chunkCount),
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

function multipartInitResultFromUploadRecord(record: MultipartUploadRecord): MultipartInitResult {
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
  const filePath = publicUploadFilePathForResponse(result);
  const publicUrl = `${new URL(result.publicUrl).origin}${filePath}`;
  const url = directAccess ? publicUrl : null;
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
    file_path: filePath,
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
    direct_access: canDirectlyAccessMultipartMetadata(upload.size, upload.chunk_count),
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

function fileStorageBackend(file: FileRecord): "telegram_single" | "telegram_multipart" | "hls_package" {
  if (file.storage_backend === "hls_package" || file.telegram_file_id.startsWith("hls:")) {
    return "hls_package";
  }

  if (file.storage_backend === "telegram_multipart" || file.telegram_file_id.startsWith("multipart:")) {
    return "telegram_multipart";
  }

  return "telegram_single";
}

function canDirectlyAccessFileRecord(file: FileRecord): boolean {
  const storageBackend = fileStorageBackend(file);

  if (storageBackend === "telegram_single" || storageBackend === "hls_package") {
    return true;
  }

  return Number.isSafeInteger(file.chunk_count) &&
    canDirectlyAccessMultipartMetadata(file.size, file.chunk_count);
}

function canDirectlyAccessUploadResult(result: UploadResult): boolean {
  if (result.storageBackend === "telegram_single" || result.storageBackend === "hls_package") {
    return true;
  }

  return canDirectlyAccessMultipartMetadata(result.size, result.chunkCount);
}

function canDirectlyAccessMultipartPayload(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>
): boolean {
  return canDirectlyAccessMultipartMetadata(payload.size, payload.chunk_count);
}

function canDirectlyAccessMultipartMetadata(size: number, chunkCount: number | null | undefined): boolean {
  return Number.isSafeInteger(size) &&
    size >= 0 &&
    size <= DIRECT_MULTIPART_ACCESS_MAX_BYTES &&
    Number.isSafeInteger(chunkCount) &&
    Number(chunkCount) > 0;
}

function downloadStrategy(
  storageBackend: "telegram_single" | "telegram_multipart" | "hls_package",
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

function optionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be a non-negative integer`);
  }

  return parsed;
}

function optionalTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
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

async function requireReadableDirectory(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const directory = await getDirectoryRecordByPath(db, path);
  if (!directory) {
    throw new AppError(404, "DirectoryNotFound", "Directory not found");
  }

  return directory;
}

async function requireWritableDirectory(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
  return requireReadableDirectory(db, path);
}

async function ensureWritableDirectory(db: AppDatabase, path: string): Promise<DirectoryRecord | null> {
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

async function requireFileRecords(db: AppDatabase, ids: string[]): Promise<FileRecord[]> {
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

async function requireDirectoryRecords(db: AppDatabase, ids: string[]): Promise<DirectoryRecord[]> {
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
  db: AppDatabase,
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

async function resolveMoveTargetDirectory(db: AppDatabase, body: Record<string, unknown>): Promise<string> {
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

function hlsPublicFilePath(token: string, fileName: string): string {
  return `${HLS_PUBLIC_ROUTE_PREFIX}/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

function hlsPublicSegmentPath(token: string, segment: HlsSegmentRecord): string {
  return `${HLS_PUBLIC_ROUTE_PREFIX}/${encodeURIComponent(token)}/segments/${segment.segment_index}/${encodeURIComponent(hlsSegmentFileName(new URL(segment.source_url), segment.segment_index))}`;
}

function hlsPublicInitSegmentPath(token: string, asset: HlsAssetRecord): string {
  const fileName = asset.init_source_url ? hlsInitSegmentFileName(new URL(asset.init_source_url)) : "init.mp4";
  return `${HLS_PUBLIC_ROUTE_PREFIX}/${encodeURIComponent(token)}/init/${encodeURIComponent(fileName)}`;
}

function hlsPublicSegmentChunkPath(token: string, segmentIndex: number, chunkIndex: number): string {
  return `${HLS_PUBLIC_ROUTE_PREFIX}/${encodeURIComponent(token)}/segments/${segmentIndex}/chunks/${chunkIndex}`;
}

function publicFilePathForResponse(
  filePath: string,
  storageBackend: "telegram_single" | "telegram_multipart" | "hls_package"
): string {
  if (storageBackend === "hls_package" && filePath.startsWith("/hls/")) {
    return `${HLS_PUBLIC_ROUTE_PREFIX}${filePath.slice("/hls".length)}`;
  }

  return filePath;
}

function publicUploadFilePathForResponse(result: UploadResult): string {
  return publicFilePathForResponse(result.filePath, result.storageBackend);
}

function getPublicBaseUrl(request: Request, env: AppEnv): string {
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
    value === "video" ||
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

function extractHlsAccess(pathname: string): { token: string; initSegment?: boolean; segmentIndex?: number; chunkIndex?: number } {
  const parts = pathname.split("/").filter(Boolean);
  const tokenPartIndex = parts[0] === "hls"
    ? 1
    : parts[0] === "api" && parts[1] === "hls"
      ? 2
      : -1;
  const token = tokenPartIndex >= 0 && parts[tokenPartIndex] ? decodeURIComponent(parts[tokenPartIndex]) : "";

  if (!token) {
    throw new AppError(404, "NotFound", "HLS route not found");
  }

  const segmentsPartIndex = tokenPartIndex + 1;
  if (parts[segmentsPartIndex] === "init") {
    return { token, initSegment: true };
  }

  if (parts[segmentsPartIndex] !== "segments") {
    return { token };
  }

  const segmentIndex = Number(parts[segmentsPartIndex + 1]);
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
    throw new AppError(400, "InvalidSegmentIndex", "HLS segment index must be a non-negative integer");
  }

  const chunkPartIndex = segmentsPartIndex + 2;
  if (parts[chunkPartIndex] === undefined) {
    return { token, segmentIndex };
  }

  if (parts[chunkPartIndex] !== "chunks") {
    return { token, segmentIndex };
  }

  const chunkIndex = Number(parts[chunkPartIndex + 1]);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AppError(400, "InvalidChunkIndex", "HLS segment chunk index must be a non-negative integer");
  }

  return { token, segmentIndex, chunkIndex };
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
