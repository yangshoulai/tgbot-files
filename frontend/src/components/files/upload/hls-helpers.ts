import {
  cancelHlsUpload,
  getHlsUploadStatus,
  type FileNameConflictAction,
  type HlsAsset,
  type HlsProbeInfo,
  type HlsSegment
} from "../../../api";
import { type HlsRetryState } from "../../../lib/upload-tasks";
import type {
  ChunkProgress,
  HlsUrlState,
  UploadChunkState,
  UploadChunkStatus,
  UrlUploadState
} from "./types";
import { chunkRange } from "./chunk-math";

export function withoutHlsRetry(state: HlsUrlState): HlsUrlState {
  const { retry: _retry, ...rest } = state;
  return rest;
}

export function isLikelyHlsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\.m3u8$/i.test(url.pathname) || url.pathname.toLowerCase().includes(".m3u8");
  } catch {
    return /\.m3u8(?:[?#]|$)/i.test(value);
  }
}

export function hlsRetryFromStatus(
  asset: HlsAsset,
  segments: HlsSegment[],
  conflictAction: FileNameConflictAction
): HlsRetryState {
  const completedSegments = segments
    .filter((segment) => segment.status === "done")
    .map((segment) => segment.segment_index)
    .sort((left, right) => left - right);
  const completedSet = new Set(completedSegments);
  const failedSegments = chunkRange(asset.segment_count)
    .filter((index) => !completedSet.has(index));

  return {
    assetId: asset.id,
    fileName: asset.file_name,
    segmentCount: asset.segment_count,
    previewPlaylistUrl: asset.preview_playlist_url,
    conflictAction,
    completedSegments,
    failedSegments
  };
}

export function hlsRetryFailureProgress(retry: HlsRetryState, label: string): ChunkProgress {
  return {
    completed: retry.completedSegments.length,
    total: retry.segmentCount,
    failed: retry.failedSegments.length,
    label: retry.failedSegments.length > 0
      ? `${label}（失败 ${retry.failedSegments.length} 个片段）`
      : label
  };
}

export function createHlsSegmentStates(segments: HlsSegment[]): UploadChunkState[] {
  return segments.map((segment) => ({
    index: segment.segment_index,
    size: segment.size ?? 0,
    status: hlsSegmentChunkStatus(segment),
    attempts: segment.attempts,
    ...(hlsSegmentChunkMessage(segment, segment.missing_chunks) ? { errorMessage: hlsSegmentChunkMessage(segment, segment.missing_chunks) } : {})
  }));
}

export function prepareHlsRetryChunks(chunks: UploadChunkState[] | undefined, retry: HlsRetryState): UploadChunkState[] {
  const completed = new Set(retry.completedSegments);
  const failed = new Set(retry.failedSegments);
  const source = chunks ?? Array.from({ length: retry.segmentCount }, (_, index) => ({
    index,
    size: 0,
    status: "queued" as UploadChunkStatus,
    attempts: 0
  }));

  return source.map((chunk) => {
    if (completed.has(chunk.index)) {
      return { ...chunk, status: "completed", errorMessage: undefined };
    }
    if (failed.has(chunk.index)) {
      return { ...chunk, status: "queued", errorMessage: undefined };
    }
    return { ...chunk, status: "queued", errorMessage: undefined };
  });
}

export function hlsSegmentChunkStatus(segment: HlsSegment): UploadChunkStatus {
  switch (segment.status) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "importing":
      return "uploading";
    default:
      return "queued";
  }
}

export function hlsSegmentChunkMessage(segment: HlsSegment, missingChunks: number[]): string | undefined {
  if (segment.status === "done") {
    return undefined;
  }

  if (segment.status === "failed") {
    return segment.error_message || "HLS 片段导入失败";
  }

  if (segment.storage_backend === "telegram_multipart" && segment.chunk_count) {
    const uploaded = segment.uploaded_chunks.length;
    return missingChunks.length > 0
      ? `大 HLS 片段 · 内部分片 ${uploaded}/${segment.chunk_count}`
      : "大 HLS 片段 · 等待合成";
  }

  return segment.error_message ?? undefined;
}

export function hlsProbeSummary(probe: HlsProbeInfo): string {
  if (probe.media) {
    return `HLS VOD · ${probe.media.segment_count} 个片段 · ${formatHlsDuration(probe.media.duration)}`;
  }

  if (probe.kind === "master") {
    return `HLS master · ${probe.variants.length} 个 variant`;
  }

  return "HLS 播放列表";
}

export function formatHlsDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "未知时长";
  }

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) {
    return `${hours}小时${minutes.toString().padStart(2, "0")}分`;
  }

  return `${minutes}分${rest.toString().padStart(2, "0")}秒`;
}

export function hlsVariantLabel(variant: HlsProbeInfo["variants"][number]): string {
  const parts = [
    variant.resolution,
    variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)}kbps` : undefined,
    variant.codecs
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : variant.id;
}

export function cleanupTemporaryHlsUpload(state: UrlUploadState): void {
  if (state.status === "done") {
    return;
  }

  const assetId = state.hls?.assetId ?? state.hls?.retry?.assetId;
  if (!assetId) {
    return;
  }

  void getHlsUploadStatus(assetId)
    .then((response) => {
      if (response.hls.asset.status === "done" || response.hls.asset.final_file_id) {
        return undefined;
      }
      return cancelHlsUpload(assetId);
    })
    .catch(() => undefined);
}
