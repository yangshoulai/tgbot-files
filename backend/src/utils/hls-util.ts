import type { HlsAssetRecord, HlsSegmentRecord } from "../database";
import { AppError, sanitizeFileName } from "./http";
import {
  hlsInitSegmentFileName,
  hlsSegmentFileName,
  parseHlsPlaylist,
  type HlsByteRange,
  type HlsInitSegmentPlan,
  type HlsSegmentEncryption
} from "./hls";
import { DIRECT_MULTIPART_ACCESS_MAX_BYTES } from "../config/upload-limits";

export type HlsDownloadKind = "ts" | "fmp4";

export type HlsDownloadItem =
  | { kind: "init" }
  | { kind: "segment"; segment: HlsSegmentRecord };

export function normalizeHlsSegmentIndex(value: string, segmentCount: number): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= segmentCount) {
    throw new AppError(400, "InvalidSegmentIndex", "HLS segment index 超出范围");
  }
  return index;
}

export function validateCompleteHlsSegments(asset: HlsAssetRecord, segments: HlsSegmentRecord[]): void {
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

export function hlsInitSegmentSize(asset: HlsAssetRecord): number {
  return asset.init_source_url ? requireHlsInitSegmentSize(asset) : 0;
}

export function leadingDoneHlsSegments(segments: HlsSegmentRecord[], limit: number): HlsSegmentRecord[] {
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

export function requireHlsInitSegmentSize(asset: HlsAssetRecord): number {
  if (!Number.isSafeInteger(asset.init_size) || Number(asset.init_size) < 0) {
    throw new AppError(409, "HlsUploadIncomplete", "HLS init segment 缺少文件大小");
  }

  return Number(asset.init_size);
}

export function requireHlsSegmentSize(segment: HlsSegmentRecord): number {
  if (!Number.isSafeInteger(segment.size) || Number(segment.size) < 0) {
    throw new AppError(409, "HlsUploadIncomplete", "HLS segment 缺少文件大小", {
      segment_index: segment.segment_index
    });
  }
  return Number(segment.size);
}

export function hlsAssetHasDoneInitSegment(asset: HlsAssetRecord): boolean {
  return Boolean(
    asset.init_source_url &&
    asset.init_status === "done" &&
    asset.init_storage_backend === "telegram_single" &&
    asset.init_telegram_file_id &&
    Number.isSafeInteger(asset.init_size) &&
    Number(asset.init_size) >= 0
  );
}

export function hlsDownloadItems(asset: HlsAssetRecord, segments: HlsSegmentRecord[], kind: HlsDownloadKind): HlsDownloadItem[] {
  const segmentItems = segments.map((segment) => ({ kind: "segment" as const, segment }));
  return kind === "fmp4" ? [{ kind: "init" }, ...segmentItems] : segmentItems;
}

export function hlsDownloadTotalSize(asset: HlsAssetRecord, segments: HlsSegmentRecord[], kind: HlsDownloadKind): number {
  return (kind === "fmp4" ? requireHlsInitSegmentSize(asset) : 0) +
    segments.reduce((total, segment) => total + requireHlsSegmentSize(segment), 0);
}

export function hlsDownloadContentType(kind: HlsDownloadKind): string {
  return kind === "fmp4" ? "video/mp4" : "video/mp2t";
}

export function hlsDownloadFileName(fileName: string, kind: HlsDownloadKind): string {
  const normalized = sanitizeFileName(fileName);
  return normalized.replace(/\.m3u8$/i, "") + (kind === "fmp4" ? ".mp4" : ".ts");
}

export function hlsDownloadAvailability(asset: HlsAssetRecord, segments: HlsSegmentRecord[]): {
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

export function hlsSegmentDownloadPartCount(segment: HlsSegmentRecord): number {
  if (segment.storage_backend === "telegram_multipart") {
    return requirePositiveRecordInteger(segment.chunk_count, "chunk_count");
  }

  if (segment.storage_backend === "telegram_single") {
    return 1;
  }

  throw new AppError(404, "HlsSegmentNotReady", "HLS segment 尚未导入完成");
}

export function hlsSegmentEncryptionForAsset(asset: HlsAssetRecord, segmentIndex: number): HlsSegmentEncryption | null {
  const plan = parseHlsPlaylist(asset.playlist_text, new URL(asset.media_playlist_url));
  if (plan.kind !== "media") {
    throw new AppError(400, "InvalidHlsPlaylist", "HLS media playlist 无效");
  }

  return plan.segments[segmentIndex]?.encryption ?? null;
}

export function hlsInitSegmentPlanForAsset(asset: HlsAssetRecord): HlsInitSegmentPlan | null {
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

export function hlsSegmentByteRange(segment: HlsSegmentRecord): HlsByteRange | null {
  return hlsByteRangeFromRecord(segment.byte_range_start, segment.byte_range_length, "HLS segment byte-range");
}

export function hlsInitByteRange(asset: HlsAssetRecord): HlsByteRange | null {
  return hlsByteRangeFromRecord(asset.init_byte_range_start, asset.init_byte_range_length, "HLS init byte-range");
}

export function hlsByteRangeFromRecord(
  start: number | null | undefined,
  length: number | null | undefined,
  label = "HLS byte-range"
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

function requirePositiveRecordInteger(value: number | null | undefined, fieldName: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new AppError(409, "InvalidRecord", `${fieldName} is invalid`);
  }
  return Number(value);
}

export function hlsPublicFilePath(routePrefix: string, token: string, fileName: string): string {
  return `${routePrefix}/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

export function hlsPublicSegmentPath(routePrefix: string, token: string, segment: HlsSegmentRecord): string {
  return `${routePrefix}/${encodeURIComponent(token)}/segments/${segment.segment_index}/${encodeURIComponent(hlsSegmentFileName(new URL(segment.source_url), segment.segment_index))}`;
}

export function hlsPublicInitSegmentPath(routePrefix: string, token: string, asset: HlsAssetRecord): string {
  const fileName = asset.init_source_url ? hlsInitSegmentFileName(new URL(asset.init_source_url)) : "init.mp4";
  return `${routePrefix}/${encodeURIComponent(token)}/init/${encodeURIComponent(fileName)}`;
}

export function hlsPublicSegmentChunkPath(routePrefix: string, token: string, segmentIndex: number, chunkIndex: number): string {
  return `${routePrefix}/${encodeURIComponent(token)}/segments/${segmentIndex}/chunks/${chunkIndex}`;
}
