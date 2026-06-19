import { createSignedToken } from "../utils/crypto";
import {
  getHlsAssetRecord,
  getHlsAssetRecordByFinalFileId,
  listHlsSegmentRecords,
  type FileRecord,
  type HlsAssetRecord,
  type HlsSegmentRecord
} from "../database";
import {
  AppError,
  requireEnv
} from "../utils/http";
import { fileStorageBackend } from "../services/file-access";
import {
  DIRECT_MULTIPART_ACCESS_MAX_CHUNKS
} from "../config/upload-limits";
import {
  serializeFileRecord as serializeFileRecordForResponse,
  serializeUploadedFileResult as serializeUploadedFileResultForResponse,
  type UploadResult
} from "../serializers/file";
import type { AppDatabase, AppEnv } from "../runtime";
import {
  hlsDownloadAvailability,
  hlsDownloadFileName,
  requireHlsInitSegmentSize,
  requireHlsSegmentSize,
  validateCompleteHlsSegments,
  type HlsDownloadKind
} from "../utils/hls-util";
import {
  HLS_PUBLIC_ROUTE_PREFIX,
  expectedRecordChunkSize,
  getPublicBaseUrl,
  hlsPublicInitSegmentPath,
  hlsPublicSegmentChunkPath,
  hlsPublicSegmentPath,
  requirePositiveRecordInteger
} from "./storage-shared";

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
