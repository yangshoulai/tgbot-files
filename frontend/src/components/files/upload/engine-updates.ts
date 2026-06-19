import type { HlsSegment } from "../../../api";
import { updateChunkStates } from "./chunk-math";
import { chunkProgressEqual } from "./equality";
import { hlsSegmentChunkMessage, hlsSegmentChunkStatus } from "./hls-helpers";
import type { UploadEngineContext } from "./engine-context";
import type { ChunkProgress, UploadChunkState } from "./types";

export function updateUrlChunk(ctx: UploadEngineContext, chunkIndex: number, patch: Partial<UploadChunkState>) {
  ctx.urlRuntimeStore.setState((current) => {
    const chunks = updateChunkStates(current.chunks, chunkIndex, patch);
    return chunks === current.chunks ? current : { ...current, chunks };
  });
}

export function updateUrlProgress(ctx: UploadEngineContext, progress: ChunkProgress) {
  ctx.urlRuntimeStore.setState((current) => {
    if (chunkProgressEqual(current.progress, progress)) {
      return current;
    }
    return {
      ...current,
      progress
    };
  });
}

export function updateUrlChunkFromHlsSegment(ctx: UploadEngineContext, segment: HlsSegment, missingChunks: number[]) {
  updateUrlChunk(ctx, segment.segment_index, {
    size: segment.size ?? 0,
    status: hlsSegmentChunkStatus(segment),
    attempts: segment.attempts,
    errorMessage: hlsSegmentChunkMessage(segment, missingChunks)
  });
}
