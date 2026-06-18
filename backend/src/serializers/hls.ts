import type { HlsAssetRecord, HlsSegmentRecord, FileChunkRecord } from "../database";
import type { HlsMediaPlan, HlsPlaylistPlan, HlsVariantPlan } from "../utils/hls";

export interface HlsProbeResult {
  playlistUrl: string;
  fileName: string;
  plan: HlsPlaylistPlan;
  media?: HlsMediaPlan;
  selectedVariantId?: string;
}

export interface HlsInitResult {
  asset: HlsAssetRecord;
  segments: HlsSegmentRecord[];
}

export interface HlsSegmentImportResult {
  segment: HlsSegmentRecord;
  uploadedChunks: number[];
  missingChunks: number[];
}

export function serializeHlsProbeResult(result: HlsProbeResult): Record<string, unknown> {
  return {
    playlist_url: result.playlistUrl,
    file_name: result.fileName,
    kind: result.plan.kind,
    selected_variant_id: result.selectedVariantId ?? null,
    variants: result.plan.kind === "master" ? result.plan.variants.map(serializeHlsVariant) : [],
    media: result.media ? serializeHlsMediaPlan(result.media) : null
  };
}

export function serializeHlsVariant(variant: HlsVariantPlan): Record<string, unknown> {
  return {
    id: variant.id,
    uri: variant.uri,
    bandwidth: variant.bandwidth ?? null,
    resolution: variant.resolution ?? null,
    codecs: variant.codecs ?? null
  };
}

export function serializeHlsMediaPlan(plan: HlsMediaPlan): Record<string, unknown> {
  return {
    playlist_url: plan.playlistUrl,
    target_duration: plan.targetDuration,
    duration: plan.duration,
    segment_count: plan.segments.length
  };
}

export async function serializeHlsUploadResult(params: {
  baseUrl: string;
  result: HlsInitResult;
  loadChunks: (segment: HlsSegmentRecord) => Promise<FileChunkRecord[]>;
}): Promise<Record<string, unknown>> {
  return {
    asset: serializeHlsAsset(params.result.asset, params.baseUrl),
    segments: await Promise.all(params.result.segments.map((segment) => serializeHlsSegment({
      segment,
      loadChunks: params.loadChunks
    })))
  };
}

export function serializeHlsAsset(asset: HlsAssetRecord, baseUrl: string): Record<string, unknown> {
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

export async function serializeHlsSegment(params: {
  segment: HlsSegmentRecord;
  loadChunks: (segment: HlsSegmentRecord) => Promise<FileChunkRecord[]>;
}): Promise<Record<string, unknown>> {
  const chunks = params.segment.multipart_upload_id
    ? await params.loadChunks(params.segment)
    : [];
  const uploadedChunks = chunks.map((chunk) => chunk.chunk_index);
  const missingChunks = Number.isSafeInteger(params.segment.chunk_count) && Number(params.segment.chunk_count) > 0
    ? chunkRange(Number(params.segment.chunk_count)).filter((index) => !uploadedChunks.includes(index))
    : [];

  return {
    id: params.segment.id,
    asset_id: params.segment.asset_id,
    segment_index: params.segment.segment_index,
    source_url: params.segment.source_url,
    duration: params.segment.duration_seconds,
    mime_type: params.segment.mime_type,
    size: params.segment.size,
    storage_backend: params.segment.storage_backend,
    telegram_channel_id: params.segment.telegram_channel_id,
    multipart_upload_id: params.segment.multipart_upload_id,
    chunk_size: params.segment.chunk_size,
    chunk_count: params.segment.chunk_count,
    status: params.segment.status,
    attempts: params.segment.attempts,
    error_message: params.segment.error_message,
    uploaded_chunks: uploadedChunks,
    missing_chunks: missingChunks,
    completed_at: params.segment.completed_at
  };
}

function chunkRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}
