import { createSignedPayload, createSignedToken, TokenError, verifySignedPayload, verifySignedToken } from "../utils/crypto";
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
  findActiveApiKeyRecord,
  findActiveFileNameConflict,
  cancelMagnetImportRecord,
  getFileChunkRecord,
  getFileRecord,
  getHlsAssetRecord,
  getHlsAssetRecordByFinalFileId,
  getHlsSegmentRecordByIndex,
  getMagnetImportFileRecord,
  getMagnetImportRecord,
  getMultipartUploadRecord,
  getTelegramChannelRecord,
  insertFileRecordWithConflictAction,
  insertHlsAssetRecord,
  insertHlsSegmentRecords,
  insertMagnetImportRecord,
  insertMultipartUploadRecord,
  listActiveTelegramChannelRecords,
  listFileChunkRecords,
  listHlsSegmentRecords,
  listIncompleteHlsAssetRecords,
  listIncompleteMagnetImportRecords,
  listIncompleteMultipartUploadRecords,
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
  moveDirectoryTree,
  replaceMagnetImportFiles,
  requireDb,
  markHlsInitSegmentImporting,
  markHlsAssetStatus,
  markHlsSegmentImporting,
  deleteFileRecord,
  touchApiKeyRecord,
  updateMagnetImportFileStatus,
  updateMultipartUploadDirectory,
  upsertFileChunkRecord,
  getTelegramChunkSizeBytesSetting,
  getTelegramVideoChunkSizeBytesSetting,
  getTelegramAudioChunkSizeBytesSetting,
  getTelegramTextChunkSizeBytesSetting,
  getTelegramImageChunkSizeBytesSetting,
  selectMagnetImportFiles,
  type ApiKeyRecord,
  type FileChunkRecord,
  type FileNameConflictAction,
  type FileRecord,
  type HlsAssetRecord,
  type HlsSegmentRecord,
  type MagnetImportFileRecord,
  type MagnetImportRecord,
  type MultipartUploadRecord,
  type TelegramChannelRecord,
  type TelegramChannelStatus
} from "../database";
import {
  aria2AddUri,
  aria2Forget,
  aria2RemoveTasksByInfoHash,
  aria2TellStatus,
  requireAria2Config,
  resolveAria2DownloadConfig,
  type Aria2File,
  type Aria2Status
} from "../services/aria2";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  errorResponse,
  jsonResponse,
  parseMaxFileBytes,
  requireEnv,
  sanitizeFileName,
  withEmbeddableFileSecurityHeaders,
  withSecurityHeaders
} from "../utils/http";
import { md5Hex } from "../utils/md5";
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
} from "../utils/hls";
import { extensionForMimeType, mimeTypeForFileName, resolveStoredMimeType } from "../utils/mime";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "../services/telegram";
import {
  canDirectlyAccessMultipartMetadata,
  fileStorageBackend
} from "../services/file-access";
import {
  fileTooLargeError,
  formatHumanFileSize,
  normalizeRemoteRequestHeaders,
  normalizeSourceUrl,
  remoteFetchHeaders,
  remoteRequestHeadersJson,
  renameUploadFile,
  storedRemoteRequestHeaders,
  validateUploadFileSize,
  type RemoteRequestHeaders
} from "../services/remote-source";
import {
  readCompleteUploadInput as readCompleteUploadInputBase,
  readThumbnailInputFromFormData,
  readThumbnailInputFromRecord,
  readThumbnailRequestInput,
  type ThumbnailInput
} from "../services/upload-input";
import {
  ensureWritableDirectory,
  requireReadableDirectory,
} from "../services/directory-access";
import {
  DIRECT_MULTIPART_ACCESS_MAX_BYTES,
  DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
  MAX_TELEGRAM_MULTIPART_BYTES,
  TELEGRAM_CHUNK_SIZE_BYTES,
  maxTelegramMultipartChunks
} from "../config/upload-limits";
import {
  serializeFileRecord as serializeFileRecordForResponse,
  serializeUploadedFileResult as serializeUploadedFileResultForResponse,
  type HlsDownloadSummary,
  type UploadedThumbnailResult,
  type UploadResult
} from "../serializers/file";
import {
  serializeHlsProbeResult,
  serializeHlsUploadResult as serializeHlsUploadResultForResponse,
  serializeHlsVariant,
  serializeHlsSegment as serializeHlsSegmentForResponse,
  type HlsInitResult,
  type HlsProbeResult,
  type HlsSegmentImportResult
} from "../serializers/hls";
import {
  multipartInitResultFromUploadRecord,
  serializeChunk,
  serializeMultipartInit,
  serializeMultipartUploadStatus,
  type MultipartInitResult,
  type ThumbnailSourceInfo
} from "../serializers/multipart-upload";
import {
  normalizeDirectoryPath,
  normalizeMimeTypeField,
  normalizeName,
  normalizeOptionalFileName,
  normalizeRemark,
  optionalNonNegativeInteger,
  optionalTrimmedString,
  isPlainRecord,
  parseContentRange,
  positiveIntegerField,
  readJsonObject,
  stringField
} from "../validators/request";
import type { AppDatabase, AppEnv } from "../runtime";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  delay,
  copyHeader,
  errorMessageForServer,
  extractOptionalFileToken,
  getPublicBaseUrl as getPublicBaseUrlBase,
  inferRemoteFileName,
  isAudioLikeFileName,
  isReadRequest,
  isTextLikeFileName,
  isTextLikeMimeType,
  maskSecret,
  parseContentLength
} from "../utils/common-util";
import {
  channelCryptoSecret,
  decryptTelegramBotToken,
  encryptTelegramBotToken,
  normalizeTelegramChannelId,
  telegramChannelTokenHash,
  telegramRetryAfterSeconds
} from "../utils/telegram-util";
import {
  bencodeDictValue,
  bencodeListValue,
  bencodeNumberValue,
  bencodeStringValue,
  aria2MagnetOptions,
  isInitializedMagnetImportStatus,
  magnetInfoHash,
  mimeTypeForMagnetFileName,
  normalizeMagnetFileIndexes,
  normalizeMagnetFileUploadOptions as normalizeMagnetFileUploadOptionsBase,
  normalizeMagnetUri,
  normalizeTorrentRelativePath,
  parseBencode,
  parseMagnetFileIndex,
  safeMagnetFilePath,
  sameNumberSet,
  sanitizeDirectorySegment,
  selectedMagnetFileIndexes,
  type BValue,
  type MagnetFileUploadOption
} from "../utils/magnet-util";
import {
  hlsByteRangeFromRecord,
  hlsAssetHasDoneInitSegment,
  hlsDownloadAvailability,
  hlsDownloadContentType,
  hlsDownloadFileName,
  hlsDownloadItems,
  hlsDownloadTotalSize,
  hlsInitByteRange,
  hlsInitSegmentPlanForAsset,
  hlsInitSegmentSize,
  leadingDoneHlsSegments,
  hlsPublicFilePath as hlsPublicFilePathBase,
  hlsPublicInitSegmentPath as hlsPublicInitSegmentPathBase,
  hlsPublicSegmentChunkPath as hlsPublicSegmentChunkPathBase,
  hlsPublicSegmentPath as hlsPublicSegmentPathBase,
  hlsSegmentByteRange,
  hlsSegmentEncryptionForAsset,
  normalizeHlsSegmentIndex,
  requireHlsInitSegmentSize,
  requireHlsSegmentSize,
  validateCompleteHlsSegments,
  type HlsDownloadKind
} from "../utils/hls-util";

interface MagnetImportRefreshResult {
  importRecord: MagnetImportRecord;
  files: MagnetImportFileRecord[];
  aria2Status?: Aria2Status;
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

interface ParsedByteRange {
  start: number;
  end: number;
  partial: boolean;
}

const DEFAULT_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24;
const MIN_STALE_MULTIPART_UPLOAD_TTL_HOURS = 1;
const MAX_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24 * 30;
const MAX_THUMBNAIL_BYTES = 512 * 1024;
const THUMBNAIL_SOURCE_TOKEN_TTL_SECONDS = 10 * 60;
const IMAGE_THUMBNAIL_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_THUMBNAIL_SOURCE_MAX_BYTES = MAX_TELEGRAM_MULTIPART_BYTES;
const VIDEO_THUMBNAIL_PROXY_DEFAULT_RANGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_THUMBNAIL_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HLS_PLAYLIST_MIME_TYPE = "application/vnd.apple.mpegurl";
const HLS_PUBLIC_ROUTE_PREFIX = "/api/hls";
const HLS_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const HLS_AES_128_KEY_BYTES = 16;
const HLS_SEGMENT_IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const HLS_PREVIEW_SEGMENT_COUNT = 4;
const ARIA2_CACHE_DIRECTORY_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveTelegramChunkSizeBytes(params: {
  db: AppDatabase;
  mimeType: string;
  fileName: string;
}): Promise<number> {
  const kind = telegramChunkSizeKind(params.mimeType, params.fileName);
  switch (kind) {
    case "video":
      return getTelegramVideoChunkSizeBytesSetting(params.db);
    case "audio":
      return getTelegramAudioChunkSizeBytesSetting(params.db);
    case "text":
      return getTelegramTextChunkSizeBytesSetting(params.db);
    case "image":
      return getTelegramImageChunkSizeBytesSetting(params.db);
    default:
      return getTelegramChunkSizeBytesSetting(params.db);
  }
}

type TelegramChunkSizeKind = "default" | "video" | "audio" | "text" | "image";

function telegramChunkSizeKind(mimeType: string, fileName: string): TelegramChunkSizeKind {
  const normalizedMimeType = mimeType.toLowerCase().split(";")[0]?.trim() || "";
  if (normalizedMimeType.startsWith("video/")) return "video";
  if (normalizedMimeType.startsWith("audio/") || isAudioLikeFileName(fileName)) return "audio";
  if (normalizedMimeType.startsWith("image/")) return "image";
  if (isTextLikeMimeType(normalizedMimeType) || isTextLikeFileName(fileName)) return "text";
  return "default";
}

type TelegramRateLimitScope = "sendDocument" | "getFile";

interface TelegramApiSlot {
  scope: TelegramRateLimitScope;
  token?: string;
  channelId?: string;
}

export interface TelegramStorageChannel {
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

export async function cancelMagnetImportUpload(
  env: AppEnv,
  db: AppDatabase,
  importId: string
): Promise<{ deleted: boolean; path?: string; skipped?: string }> {
  const record = await requireMagnetImport(db, importId);
  const config = requireAria2Config(env);
  await forgetAria2MagnetTask(config, record);

  if (record.status !== "done" && !record.completed_at) {
    await cancelMagnetImportRecord(db, importId, new Date().toISOString());
  }

  return deleteMagnetImportDownloadDir(config, record);
}

export async function createMagnetImport(params: {
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

export async function refreshMagnetImportStatus(
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

  // 兜底：按 InfoHash 扫描并清除 aria2 中任何残留的任务（以防 gid 已失效）
  await aria2RemoveTasksByInfoHash(config, infoHash);
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
        await Promise.all(torrentFiles.map(async (file) => {
          const chunkSizeBytes = await resolveTelegramChunkSizeBytes({
            db,
            mimeType: file.mimeType,
            fileName: file.fileName
          });
          return {
            id: crypto.randomUUID(),
            importId: importRecord.id,
            fileIndex: file.fileIndex,
            path: file.relativePath,
            fileName: file.fileName,
            relativeDirectoryPath: file.relativeDirectoryPath,
            size: file.size,
            mimeType: file.mimeType,
            chunkSize: chunkSizeBytes,
            chunkCount: Math.ceil(file.size / chunkSizeBytes),
            createdAt: now,
            updatedAt: now
          };
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
    await Promise.all(files.map(async (file) => {
      const chunkSizeBytes = await resolveTelegramChunkSizeBytes({
        db,
        mimeType: file.mimeType,
        fileName: file.fileName
      });
      return {
        id: crypto.randomUUID(),
        importId: importRecord.id,
        fileIndex: file.fileIndex,
        path: file.relativePath,
        fileName: file.fileName,
        relativeDirectoryPath: file.relativeDirectoryPath,
        size: file.size,
        mimeType: file.mimeType,
        chunkSize: chunkSizeBytes,
        chunkCount: Math.ceil(file.size / chunkSizeBytes),
        createdAt: now,
        updatedAt: now
      };
    })),
    {
      infoHash: magnetInfoHash(importRecord.magnet_uri),
      name: status.bittorrent?.info?.name ?? null,
      totalSize: files.reduce((total, file) => total + file.size, 0),
      updatedAt: now
    }
  );
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

export async function initMagnetImportSelection(params: MagnetImportSelectionParams): Promise<MagnetImportRefreshResult & {
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
    const fileOption = params.fileOptions.get(file.file_index);
    const targetFileName = fileOption?.fileName ?? file.file_name;
    const chunkSizeBytes = await resolveTelegramChunkSizeBytes({
      db: params.db,
      mimeType: file.mime_type,
      fileName: targetFileName
    });
    validateMultipartFileSize(file.size, chunkSizeBytes);
    const targetConflictAction = fileOption?.conflictAction ?? params.conflictAction;
    const targetDirectoryPath = targetDirectoryForMagnetFile(params.directoryPath, file);
    const upload = await createMultipartUpload({
      db: params.db,
      sourceKind: "magnet",
      sourceUrl: importRecord.magnet_uri,
      fileName: targetFileName,
      mimeType: file.mime_type,
      size: file.size,
      chunkSizeBytes,
      uploadedBy: params.uploadedBy,
      directoryId: null,
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
    "bt-save-metadata": "false",
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

export async function importMagnetFileChunk(params: {
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

export async function completeMagnetFileUpload(params: {
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
    ensureDirectoryOnComplete: true,
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

export async function serveMagnetThumbnailSource(params: {
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

export function serializeMagnetImport(
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

export function normalizeMagnetFileUploadOptions(
  value: unknown,
  selectedIndexes: number[]
): Map<number, MagnetFileUploadOption> {
  return normalizeMagnetFileUploadOptionsBase(value, selectedIndexes, normalizeFileNameConflictAction);
}

function magnetDownloadDir(baseDir: string, importId: string): string {
  return path.join(baseDir, importId);
}

export async function probeHlsSource(
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

export async function createHlsUpload(params: {
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

export async function importHlsSegment(params: {
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
    const fileName = hlsSegmentFileName(sourceUrl, segment.segment_index);
    const hlsVideoChunkSizeBytes = await resolveTelegramChunkSizeBytes({
      db: params.db,
      mimeType,
      fileName
    });

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

    if (probe.size !== undefined && probe.size > hlsVideoChunkSizeBytes) {
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

    const blob = await downloadHlsSegmentBlob(sourceUrl, hlsVideoChunkSizeBytes, probe.size, sourceHeaders, byteRange);
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

export async function importHlsSegmentChunk(params: {
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

export async function completeHlsMultipartSegment(params: {
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

export async function completeHlsUpload(params: {
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

  const now = new Date().toISOString();
  const sourceUrl = new URL(params.segment.source_url);
  const fileName = hlsSegmentFileName(sourceUrl, params.segment.segment_index);
  const chunkSizeBytes = await resolveTelegramChunkSizeBytes({
    db: params.db,
    mimeType: params.mimeType,
    fileName
  });
  validateMultipartFileSize(params.size, chunkSizeBytes);
  const chunkCount = Math.ceil(params.size / chunkSizeBytes);
  const byteRange = hlsSegmentByteRange(params.segment);
  const upload = await insertMultipartUploadRecord(params.db, {
    id: crypto.randomUUID(),
    sourceKind: "url",
    sourceUrl: params.segment.source_url,
    ...(params.asset.source_headers_json ? { sourceHeadersJson: params.asset.source_headers_json } : {}),
    ...(byteRange ? { sourceRangeStart: byteRange.offset } : {}),
    fileName,
    mimeType: params.mimeType,
    size: params.size,
    chunkSize: chunkSizeBytes,
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
    chunkSize: chunkSizeBytes,
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

export async function requireHlsAsset(db: AppDatabase, assetId: string): Promise<HlsAssetRecord> {
  const asset = await getHlsAssetRecord(db, assetId);
  if (!asset) {
    throw new AppError(404, "HlsAssetNotFound", "HLS 上传任务不存在");
  }
  return asset;
}

export async function requireMutableHlsAsset(db: AppDatabase, assetId: string): Promise<HlsAssetRecord> {
  const asset = await requireHlsAsset(db, assetId);
  if (asset.status === "done" || asset.status === "cancelled" || asset.final_file_id) {
    throw new AppError(409, "HlsAssetClosed", "HLS 上传任务已结束");
  }
  return asset;
}

export async function requireHlsSegment(db: AppDatabase, assetId: string, segmentIndex: number): Promise<HlsSegmentRecord> {
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

export async function serializeHlsUploadResult(
  db: AppDatabase,
  request: Request,
  env: AppEnv,
  result: HlsInitResult
): Promise<Record<string, unknown>> {
  return serializeHlsUploadResultForResponse({
    baseUrl: getPublicBaseUrl(request, env),
    result,
    loadChunks: (segment) => segment.multipart_upload_id ? listFileChunkRecords(db, segment.multipart_upload_id) : Promise.resolve([])
  });
}

export async function serializeHlsSegment(db: AppDatabase, segment: HlsSegmentRecord): Promise<Record<string, unknown>> {
  return serializeHlsSegmentForResponse({
    segment,
    loadChunks: (currentSegment) => currentSegment.multipart_upload_id
      ? listFileChunkRecords(db, currentSegment.multipart_upload_id)
      : Promise.resolve([])
  });
}

export async function readUploadInput(request: Request, env: AppEnv): Promise<{
  file: File;
  remark?: string;
  directoryPath: string;
  conflictAction: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
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
  const thumbnail = readThumbnailInputFromFormData(formData);

  if (formFile instanceof File) {
    validateUploadFileSize(formFile, maxFileBytes);
    const file = fileNameOverride ? renameUploadFile(formFile, fileNameOverride) : formFile;

    return {
      file,
      directoryPath,
      conflictAction,
      ...(thumbnail ? { thumbnail } : {}),
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
      ...(thumbnail ? { thumbnail } : {}),
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
  thumbnail?: ThumbnailInput;
}> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const body = await readJsonObject(request);
  const sourceUrl = normalizeSourceUrl(body.url);
  const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
  const fileNameOverride = normalizeOptionalFileName(body.file_name);
  const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
  const thumbnail = readThumbnailInputFromRecord(body);

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
    ...(thumbnail ? { thumbnail } : {}),
    ...(remark ? { remark } : {})
  };
}

export async function readCompleteUploadInput(
  request: Request,
  searchParams: URLSearchParams
): Promise<{ thumbnail?: ThumbnailInput; conflictAction: FileNameConflictAction }> {
  return readCompleteUploadInputBase(request, searchParams, normalizeFileNameConflictAction);
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

export async function getRateLimitedTelegramFileUrl(params: {
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

export async function resolveTelegramChannel(env: AppEnv, db: AppDatabase | undefined, channelId: string | null | undefined): Promise<TelegramStorageChannel> {
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

function pickRemoteMimeHint(contentType: string | null, fileName: string): string | undefined {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  const nameMimeType = mimeTypeForFileName(fileName);

  if (normalizedContentType && normalizedContentType !== "application/octet-stream") {
    return normalizedContentType;
  }

  return nameMimeType ?? normalizedContentType;
}

function ensureFileExtension(fileName: string, mimeType: string): string {
  if (/\.[a-z0-9]{1,12}$/i.test(fileName)) {
    return fileName;
  }

  const extension = extensionForMimeType(mimeType);

  return extension ? `${fileName}.${extension}` : fileName;
}

export async function createMultipartUpload(params: {
  db: AppDatabase;
  sourceKind: "local" | "url" | "magnet";
  sourceUrl?: string;
  sourceHeadersJson?: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSizeBytes?: number;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath: string;
  conflictAction?: FileNameConflictAction;
}): Promise<MultipartInitResult> {
  const chunkSizeBytes = params.chunkSizeBytes ?? await resolveTelegramChunkSizeBytes({
    db: params.db,
    mimeType: params.mimeType,
    fileName: params.fileName
  });
  validateMultipartFileSize(params.size, chunkSizeBytes);
  await requireFileNameWritable({
    db: params.db,
    directoryPath: params.directoryPath,
    fileName: params.fileName,
    conflictAction: params.conflictAction ?? "error"
  });
  const chunkCount = Math.ceil(params.size / chunkSizeBytes);
  const createdAt = new Date().toISOString();
  const record = await insertMultipartUploadRecord(params.db, {
    id: crypto.randomUUID(),
    sourceKind: params.sourceKind,
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    ...(params.sourceHeadersJson ? { sourceHeadersJson: params.sourceHeadersJson } : {}),
    fileName: params.fileName,
    mimeType: params.mimeType,
    size: params.size,
    chunkSize: chunkSizeBytes,
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

function validateMultipartFileSize(size: number, chunkSizeBytes = TELEGRAM_CHUNK_SIZE_BYTES): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size, {
      chunk_size_bytes: chunkSizeBytes,
      chunk_size: formatHumanFileSize(chunkSizeBytes),
      max_chunks: maxTelegramMultipartChunks(chunkSizeBytes)
    });
  }
}

export async function probeRemoteSourceForMultipart(
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

export async function createThumbnailSourceInfo(params: {
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

export async function handleThumbnailSourceProxy(request: Request, env: AppEnv): Promise<Response> {
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

export async function requireMultipartUpload(
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

export async function requireFileRecord(db: AppDatabase, id: string): Promise<FileRecord> {
  const file = await getFileRecord(db, id);

  if (!file) {
    throw new AppError(404, "FileNotFound", "File record not found");
  }

  return file;
}

export async function requireFileNameAvailable(params: {
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

export async function requireFileNameWritable(params: {
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

export function normalizeUploadPreflightEntries(value: unknown): UploadPreflightEntry[] {
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

export async function preflightUploadEntries(
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

export async function requireFileMoveNamesAvailable(params: {
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

export function normalizeFileNameConflictAction(value: unknown): FileNameConflictAction {
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

export function normalizeChunkIndex(value: string, upload: MultipartUploadRecord): number {
  const index = Number(value);

  if (!Number.isSafeInteger(index) || index < 0 || index >= upload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  return index;
}

export function expectedChunkSize(upload: MultipartUploadRecord, chunkIndex: number): number {
  if (chunkIndex === upload.chunk_count - 1) {
    return upload.size - upload.chunk_size * chunkIndex;
  }

  return upload.chunk_size;
}

export function validateChunkFile(chunk: Blob, expectedSize: number): void {
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

export async function downloadAndUploadRemoteChunk(params: {
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

export async function uploadChunkToTelegram(params: {
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

export async function completeMultipartUpload(params: {
  request: Request;
  env: AppEnv;
  db: AppDatabase;
  upload: MultipartUploadRecord;
  conflictAction?: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
  ensureDirectoryOnComplete?: boolean;
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
  let upload = params.upload;
  if (params.ensureDirectoryOnComplete) {
    const directoryPath = params.upload.directory_path ?? "/";
    const directory = await ensureWritableDirectory(params.db, directoryPath);
    await updateMultipartUploadDirectory({
      db: params.db,
      id: params.upload.id,
      directoryId: directory?.id ?? null,
      directoryPath
    });
    upload = {
      ...params.upload,
      directory_id: directory?.id ?? null,
      directory_path: directoryPath
    };
  }

  await completeMultipartUploadWithFileRecord({
    db: params.db,
    uploadId: upload.id,
    completedAt: createdAt,
    conflictAction: params.conflictAction ?? "error",
    file: {
      id: upload.id,
      fileName: upload.file_name,
      mimeType: upload.mime_type,
      size: upload.size,
      md5,
      telegramFileId: `multipart:${upload.id}`,
      telegramChannelId: chunks[0]?.telegram_channel_id ?? "default",
      filePath,
      createdAt,
      storageBackend: "telegram_multipart",
      chunkSize: upload.chunk_size,
      chunkCount: upload.chunk_count,
      directoryId: upload.directory_id ?? null,
      directoryPath: upload.directory_path ?? "/",
      ...thumbnailFileRecordFields(thumbnail),
      ...(upload.remark ? { remark: upload.remark } : {}),
      ...(upload.uploaded_by ? { uploadedBy: upload.uploaded_by } : {})
    }
  });

  return {
    id: upload.id,
    name: upload.file_name,
    size: upload.size,
    mimeType: upload.mime_type,
    md5,
    filePath,
    publicUrl,
    telegramFileId: `multipart:${upload.id}`,
    telegramChannelId: chunks[0]?.telegram_channel_id ?? "default",
    ...(upload.remark ? { remark: upload.remark } : {}),
    createdAt,
    directoryId: upload.directory_id ?? null,
    directoryPath: upload.directory_path ?? "/",
    storageBackend: "telegram_multipart",
    chunkSize: upload.chunk_size,
    chunkCount: upload.chunk_count,
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

export async function uploadThumbnailToTelegram(params: {
  request: Request;
  env: AppEnv;
  db: AppDatabase;
  originalFileName: string;
  thumbnail: ThumbnailInput;
}): Promise<UploadedThumbnailResult> {
  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const materialized = await materializeThumbnailFile(params);
  const thumbnailFileName = materialized.file.name;
  const { telegramDocument, channel } = await uploadTelegramDocumentWithChannel({
    env: params.env,
    db: params.db,
    file: materialized.file,
    fileName: thumbnailFileName
  });
  const thumbnailSize = telegramDocument.file_size ?? materialized.file.size;
  const token = await createSignedToken(
    {
      v: 3,
      channel_id: channel.id,
      file_id: telegramDocument.file_id,
      name: thumbnailFileName,
      mime_type: materialized.mimeType,
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
    mimeType: materialized.mimeType,
    size: thumbnailSize,
    ...(params.thumbnail.width ? { width: params.thumbnail.width } : {}),
    ...(params.thumbnail.height ? { height: params.thumbnail.height } : {})
  };
}

async function materializeThumbnailFile(params: {
  originalFileName: string;
  thumbnail: ThumbnailInput;
}): Promise<{ file: File; mimeType: string }> {
  if (params.thumbnail.file) {
    const thumbnailBytes = await params.thumbnail.file.arrayBuffer();
    return thumbnailFileFromBytes({
      bytes: thumbnailBytes,
      fileType: params.thumbnail.file.type,
      originalFileName: params.originalFileName
    });
  }

  if (params.thumbnail.sourceUrl) {
    return downloadThumbnailFileFromUrl({
      sourceUrl: params.thumbnail.sourceUrl,
      originalFileName: params.originalFileName,
      ...(params.thumbnail.sourceHeaders ? { sourceHeaders: params.thumbnail.sourceHeaders } : {})
    });
  }

  throw new AppError(400, "MissingThumbnail", "Thumbnail file or thumbnail_url is required");
}

async function downloadThumbnailFileFromUrl(params: {
  sourceUrl: URL;
  sourceHeaders?: RemoteRequestHeaders;
  originalFileName: string;
}): Promise<{ file: File; mimeType: string }> {
  let response: Response;

  try {
    response = await fetch(params.sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(params.sourceHeaders, { Accept: "image/jpeg,image/png,image/webp,image/*,*/*" })
    });
  } catch {
    throw new AppError(502, "ThumbnailFetchFailed", "Failed to fetch thumbnail URL");
  }

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "ThumbnailFetchFailed",
      `Thumbnail URL returned ${response.status}`,
      { source_status: response.status }
    );
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength > MAX_THUMBNAIL_BYTES) {
    throw new AppError(400, "ThumbnailTooLarge", `Thumbnail must not exceed ${formatHumanFileSize(MAX_THUMBNAIL_BYTES)}`);
  }

  const bytes = await readResponseArrayBufferLimited(response, MAX_THUMBNAIL_BYTES);
  const remoteName = inferRemoteFileName(params.sourceUrl, response.headers);
  const fileType = pickRemoteMimeHint(response.headers.get("Content-Type"), remoteName);

  return thumbnailFileFromBytes({
    bytes,
    fileType,
    originalFileName: params.originalFileName
  });
}

async function readResponseArrayBufferLimited(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    validateThumbnailBytes(bytes, response.headers.get("Content-Type") || "");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(400, "ThumbnailTooLarge", `Thumbnail must not exceed ${formatHumanFileSize(maxBytes)}`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(502, "ThumbnailFetchFailed", "Failed to read thumbnail URL response");
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output.buffer;
}

function thumbnailFileFromBytes(params: {
  bytes: ArrayBuffer;
  fileType: string | undefined;
  originalFileName: string;
}): { file: File; mimeType: string } {
  validateThumbnailBytes(params.bytes, params.fileType ?? "");

  const mimeType = resolveStoredMimeType({
    bytes: params.bytes,
    fileType: params.fileType
  });
  validateThumbnailMimeType(mimeType);

  const thumbnailFileName = thumbnailFileNameFor(params.originalFileName, mimeType);
  return {
    file: new File([params.bytes], thumbnailFileName, { type: mimeType }),
    mimeType
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

export function thumbnailRecordUpdateFields(thumbnail: UploadedThumbnailResult) {
  return {
    thumbnailFileId: thumbnail.fileId ?? null,
    thumbnailFileUniqueId: thumbnail.fileUniqueId ?? null,
    thumbnailFilePath: thumbnail.filePath ?? null,
    thumbnailMimeType: thumbnail.mimeType ?? null,
    thumbnailSize: thumbnail.size ?? null,
    thumbnailWidth: thumbnail.width ?? null,
    thumbnailHeight: thumbnail.height ?? null,
    thumbnailStatus: thumbnail.status
  };
}

export function emptyThumbnailRecordUpdateFields() {
  return {
    thumbnailFileId: null,
    thumbnailFileUniqueId: null,
    thumbnailFilePath: null,
    thumbnailMimeType: null,
    thumbnailSize: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    thumbnailStatus: "none" as const
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

export async function uploadAndRecordFile(params: {
  request: Request;
  env: AppEnv;
  file: File;
  db?: AppDatabase;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath?: string;
  conflictAction?: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
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
  const thumbnail = params.db
    ? await uploadOptionalThumbnail({
        request: params.request,
        env: params.env,
        db: params.db,
        originalFileName: storedName,
        thumbnail: params.thumbnail
      })
    : undefined;

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
        ...thumbnailFileRecordFields(thumbnail),
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
    chunkCount: null,
    ...(thumbnail ? { thumbnail } : {})
  };
}

export async function createFilePathForRecord(record: FileRecord, fileName: string, env: AppEnv): Promise<string> {
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

export function requirePositiveRecordInteger(value: number | null | undefined, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new AppError(500, "InvalidFileRecord", `File record is missing ${fieldName}`);
  }

  return value as number;
}

export async function handleAdminHlsPreviewPlaylist(request: Request, env: AppEnv, assetId: string): Promise<Response> {
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

export async function serveHlsPackageDownload(params: {
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

export async function serveStoredHlsInitSegment(params: {
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

export async function serveStoredHlsSegment(params: {
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

export async function serveHlsSegmentChunk(params: {
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

export async function handleMultipartChunkAccess(params: {
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

export async function handleMultipartChunkRecordAccess(params: {
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

export async function handleMultipartFileAccess(params: {
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

  const headers = withEmbeddableFileSecurityHeaders();
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

export async function requireUploadApiKey(request: Request, db: AppDatabase): Promise<ApiKeyRecord> {
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

export function serializeFileRecord(file: FileRecord, baseUrl: string, db: AppDatabase): Promise<Record<string, unknown>> {
  return serializeFileRecordForResponse({
    file,
    baseUrl,
    hlsPublicRoutePrefix: HLS_PUBLIC_ROUTE_PREFIX,
    loadHlsDownloadSummary: (currentFile) => hlsDownloadSummaryForFile(db, currentFile)
  });
}

export function serializeUploadedFileResult(result: UploadResult, username: string | null): Record<string, unknown> {
  return serializeUploadedFileResultForResponse(result, username, HLS_PUBLIC_ROUTE_PREFIX);
}

export async function serializeHlsDownloadPlanForFile(params: {
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

export function missingChunkIndexes(upload: MultipartUploadRecord, chunks: FileChunkRecord[]): number[] {
  const uploaded = new Set(chunks.map((chunk) => chunk.chunk_index));
  const missing: number[] = [];

  for (let index = 0; index < upload.chunk_count; index += 1) {
    if (!uploaded.has(index)) {
      missing.push(index);
    }
  }

  return missing;
}

function canDirectlyAccessMultipartPayload(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>
): boolean {
  return canDirectlyAccessMultipartMetadata(payload.size, payload.chunk_count, DIRECT_MULTIPART_ACCESS_MAX_BYTES);
}

function hlsPublicFilePath(token: string, fileName: string): string {
  return hlsPublicFilePathBase(HLS_PUBLIC_ROUTE_PREFIX, token, fileName);
}

export function hlsPublicSegmentPath(token: string, segment: HlsSegmentRecord): string {
  return hlsPublicSegmentPathBase(HLS_PUBLIC_ROUTE_PREFIX, token, segment);
}

export function hlsPublicInitSegmentPath(token: string, asset: HlsAssetRecord): string {
  return hlsPublicInitSegmentPathBase(HLS_PUBLIC_ROUTE_PREFIX, token, asset);
}

function hlsPublicSegmentChunkPath(token: string, segmentIndex: number, chunkIndex: number): string {
  return hlsPublicSegmentChunkPathBase(HLS_PUBLIC_ROUTE_PREFIX, token, segmentIndex, chunkIndex);
}

export function getPublicBaseUrl(request: Request, env: AppEnv): string {
  return getPublicBaseUrlBase(request, env.PUBLIC_BASE_URL);
}
