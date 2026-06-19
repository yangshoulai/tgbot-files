import { createSignedToken } from "../utils/crypto";
import {
  completeMultipartUploadWithFileRecord,
  getMultipartUploadRecord,
  insertFileRecordWithConflictAction,
  insertMultipartUploadRecord,
  listFileChunkRecords,
  updateMultipartUploadDirectory,
  type FileChunkRecord,
  type FileNameConflictAction,
  type FileRecord,
  type MultipartUploadRecord
} from "../database";
import {
  AppError,
  requireEnv,
  sanitizeFileName
} from "../utils/http";
import { md5Hex } from "../utils/md5";
import { extensionForMimeType, resolveStoredMimeType } from "../utils/mime";
import {
  fileTooLargeError,
  formatHumanFileSize
} from "../services/remote-source";
import { fileStorageBackend } from "../services/file-access";
import {
  remoteFetchHeaders,
  storedRemoteRequestHeaders,
  type RemoteRequestHeaders
} from "../services/remote-source";
import {
  type ThumbnailInput
} from "../services/upload-input";
import {
  ensureWritableDirectory
} from "../services/directory-access";
import {
  MAX_TELEGRAM_MULTIPART_BYTES,
  TELEGRAM_CHUNK_SIZE_BYTES
} from "../config/upload-limits";
import {
  type UploadedThumbnailResult,
  type UploadResult
} from "../serializers/file";
import {
  type MultipartInitResult
} from "../serializers/multipart-upload";
import {
  parseContentRange
} from "../validators/request";
import type { AppDatabase, AppEnv } from "../runtime";
import {
  inferRemoteFileName,
  parseContentLength
} from "../utils/common-util";
import {
  normalizeTelegramChannelId
} from "../utils/telegram-util";
import {
  ensureFileExtension,
  expectedChunkSize,
  fetchRemoteHead,
  fetchRemoteRange,
  getPublicBaseUrl,
  hlsPublicFilePath,
  pickRemoteMimeHint,
  requirePositiveRecordInteger,
  resolveTelegramChunkSizeBytes,
  thumbnailFileRecordFields,
  validateChunkFile,
  validateMultipartFileSize
} from "./storage-shared";
import {
  uploadTelegramDocumentWithChannel,
  acquireTelegramUploadSlot,
  releaseTelegramApiSlot,
  type TelegramUploadSlot
} from "./telegram-channel";
import { requireFileNameWritable } from "./upload-validation";

const MAX_THUMBNAIL_BYTES = 512 * 1024;
const ALLOWED_THUMBNAIL_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

export async function uploadOptionalThumbnail(params: {
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

export function validateCompleteChunks(upload: MultipartUploadRecord, chunks: FileChunkRecord[]): void {
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
