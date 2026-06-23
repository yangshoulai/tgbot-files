import {
  cancelMagnetImportRecord,
  findReusableMagnetImportRecord,
  getMagnetImportFileRecord,
  getMagnetImportRecord,
  insertMagnetImportRecord,
  listMagnetImportFileRecords,
  listRestartableMagnetImportRecordsBySource,
  markMagnetImportDoneIfComplete,
  markMagnetImportDownloaded,
  markMagnetImportDownloading,
  markMagnetImportFailed,
  markMagnetImportImporting,
  replaceMagnetImportFiles,
  selectMagnetImportFiles,
  updateMagnetImportFileStatus,
  upsertFileChunkRecord,
  type FileNameConflictAction,
  type MagnetImportFileRecord,
  type MagnetImportRecord,
  type MultipartUploadRecord
} from "../database";
import {
  aria2AddUri,
  aria2Forget,
  aria2RemoveTasksByInfoHash,
  aria2TellStatus,
  requireAria2Config,
  type Aria2File,
  type Aria2Status
} from "../services/aria2";
import {
  AppError,
  contentDispositionInline,
  sanitizeFileName,
  withSecurityHeaders
} from "../utils/http";
import {
  type ThumbnailInput
} from "../services/upload-input";
import {
  type UploadResult
} from "../serializers/file";
import {
  multipartInitResultFromUploadRecord,
  serializeMultipartInit
} from "../serializers/multipart-upload";
import {
  normalizeDirectoryPath
} from "../validators/request";
import type { AppDatabase, AppEnv } from "../runtime";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  delay
} from "../utils/common-util";
import {
  bencodeDictValue,
  bencodeListValue,
  bencodeNumberValue,
  bencodeStringValue,
  aria2MagnetOptions,
  isInitializedMagnetImportStatus,
  magnetInfoHash,
  mimeTypeForMagnetFileName,
  normalizeMagnetFileUploadOptions as normalizeMagnetFileUploadOptionsBase,
  normalizeTorrentRelativePath,
  parseBencode,
  safeMagnetFilePath,
  sameNumberSet,
  sanitizeDirectorySegment,
  selectedMagnetFileIndexes,
  type MagnetFileUploadOption
} from "../utils/magnet-util";
import {
  expectedChunkSize,
  normalizeChunkIndex,
  normalizeFileNameConflictAction,
  resolveTelegramChunkSizeBytes,
  thumbnailSourceKind,
  validateMultipartFileSize,
  parseByteRange,
  rangeNotSatisfiableResponse
} from "./storage-shared";
import {
  deleteAria2DownloadDir,
  ensureAria2DownloadCapacity,
  forceRemoveAria2MagnetTaskIfConfigured,
  forgetAria2MagnetTask,
  safeAria2DownloadDir
} from "./aria2-download-cache";
import {
  completeMultipartUpload,
  createMultipartUpload,
  requireMultipartUpload,
  uploadChunkToTelegram
} from "./multipart-upload";

interface MagnetImportRefreshResult {
  importRecord: MagnetImportRecord;
  files: MagnetImportFileRecord[];
  aria2Status?: Aria2Status;
}

const MAGNET_FILE_CHUNK_READ_ATTEMPTS = 5;
const MAGNET_FILE_CHUNK_READ_RETRY_MS = 600;

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
      const files = await listMagnetImportFileRecords(db, importRecord.id);
      if (await areSelectedMagnetFilesMaterialized(importRecord, files)) {
        await markMagnetImportDownloaded(db, importRecord.id, new Date().toISOString());
        importRecord = await requireMagnetImport(db, importId);
      }
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

async function areSelectedMagnetFilesMaterialized(
  importRecord: MagnetImportRecord,
  files: MagnetImportFileRecord[]
): Promise<boolean> {
  const selectedFiles = files.filter((file) => file.selected === 1);
  if (selectedFiles.length === 0) {
    return false;
  }

  for (const file of selectedFiles) {
    const absolutePath = safeMagnetFilePath(importRecord.download_dir, file.path);
    const stats = await lstat(absolutePath).catch(() => null);
    if (!stats?.isFile() || stats.size < file.size) {
      return false;
    }
  }

  return true;
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

  for (let attempt = 1; attempt <= MAGNET_FILE_CHUNK_READ_ATTEMPTS; attempt += 1) {
    const handle = await open(absolutePath, "r").catch(() => null);
    if (handle) {
      try {
        const buffer = new Uint8Array(expectedSize);
        const { bytesRead } = await handle.read(buffer, 0, expectedSize, start);
        if (bytesRead === expectedSize) {
          return new Blob([buffer], { type: upload.mime_type });
        }
      } finally {
        await handle.close();
      }
    }

    if (attempt < MAGNET_FILE_CHUNK_READ_ATTEMPTS) {
      await delay(MAGNET_FILE_CHUNK_READ_RETRY_MS);
    }
  }

  throw new AppError(409, "MagnetFileNotReady", "磁力文件分片尚未下载完成");
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
