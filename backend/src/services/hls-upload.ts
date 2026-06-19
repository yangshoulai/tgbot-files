import { createSignedToken } from "../utils/crypto";
import {
  attachHlsSegmentMultipartUpload,
  completeHlsInitSegmentSingle,
  completeHlsAssetWithFileRecord,
  completeHlsSegmentMultipart,
  completeHlsSegmentSingle,
  completeMultipartUploadRecord,
  getHlsAssetRecord,
  getHlsSegmentRecordByIndex,
  getMultipartUploadRecord,
  insertHlsAssetRecord,
  insertHlsSegmentRecords,
  insertMultipartUploadRecord,
  listFileChunkRecords,
  listHlsSegmentRecords,
  markHlsInitSegmentImporting,
  markHlsAssetStatus,
  markHlsSegmentImporting,
  failHlsSegment,
  failHlsInitSegment,
  upsertFileChunkRecord,
  type FileNameConflictAction,
  type HlsAssetRecord,
  type HlsSegmentRecord,
  type MultipartUploadRecord
} from "../database";
import {
  AppError,
  requireEnv
} from "../utils/http";
import {
  buildRewrittenMediaPlaylist,
  hlsInitSegmentFileName,
  hlsFileNameFromUrl,
  hlsMimeTypeForInitSegment,
  hlsMimeTypeForSegment,
  hlsSegmentFileName,
  parseHlsPlaylist,
  type HlsByteRange,
  type HlsMediaPlan,
  type HlsPlaylistPlan,
  type HlsSegmentEncryption,
  type HlsVariantPlan
} from "../utils/hls";
import {
  fileTooLargeError,
  formatHumanFileSize,
  remoteFetchHeaders,
  remoteRequestHeadersJson,
  storedRemoteRequestHeaders,
  type RemoteRequestHeaders
} from "../services/remote-source";
import {
  type ThumbnailInput
} from "../services/upload-input";
import {
  serializeHlsUploadResult as serializeHlsUploadResultForResponse,
  serializeHlsVariant,
  serializeHlsSegment as serializeHlsSegmentForResponse,
  type HlsInitResult,
  type HlsProbeResult,
  type HlsSegmentImportResult
} from "../serializers/hls";
import {
  MAX_TELEGRAM_MULTIPART_BYTES,
  TELEGRAM_CHUNK_SIZE_BYTES
} from "../config/upload-limits";
import {
  type UploadResult
} from "../serializers/file";
import type { AppDatabase, AppEnv } from "../runtime";
import {
  errorMessageForServer,
  parseContentLength
} from "../utils/common-util";
import {
  hlsByteRangeFromRecord,
  hlsInitByteRange,
  hlsInitSegmentPlanForAsset,
  hlsInitSegmentSize,
  hlsSegmentByteRange,
  hlsSegmentEncryptionForAsset,
  requireHlsSegmentSize,
  validateCompleteHlsSegments
} from "../utils/hls-util";
import {
  getPublicBaseUrl,
  fetchRemoteHead,
  fetchRemoteRange,
  hlsPublicFilePath,
  missingChunkIndexes,
  normalizeChunkIndex,
  resolveTelegramChunkSizeBytes,
  thumbnailFileRecordFields,
  validateMultipartFileSize
} from "./storage-shared";
import { uploadTelegramDocumentWithChannel } from "./telegram-channel";
import { requireFileNameWritable } from "./upload-validation";
import {
  downloadAndUploadRemoteChunk,
  uploadOptionalThumbnail,
  validateCompleteChunks
} from "./multipart-upload";
import { parseContentRange } from "../validators/request";

const HLS_PLAYLIST_MIME_TYPE = "application/vnd.apple.mpegurl";
const HLS_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const HLS_AES_128_KEY_BYTES = 16;

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
