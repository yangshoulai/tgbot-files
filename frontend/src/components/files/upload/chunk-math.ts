import type { MultipartRetryState } from "../../../lib/upload-tasks";
import type { ChunkProgress, UploadChunkState } from "./types";
import { uploadChunkStateEqual } from "./equality";

export function chunkRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

export function retryFailureProgress(retry: MultipartRetryState, label: string): ChunkProgress {
  return {
    completed: retry.completedChunks.length,
    total: retry.chunkCount,
    failed: retry.failedChunks.length,
    label: `${label}（失败 ${retry.failedChunks.length} 个）`
  };
}

export function createUploadChunkStates(size: number, chunkSize: number, chunkCount: number): UploadChunkState[] {
  return Array.from({ length: chunkCount }, (_, index) => ({
    index,
    size: expectedUploadChunkSize(size, chunkSize, chunkCount, index),
    status: "queued",
    attempts: 0
  }));
}

export function prepareRetryChunks(chunks: UploadChunkState[] | undefined, retry: MultipartRetryState): UploadChunkState[] {
  const failed = new Set(retry.failedChunks);
  const completed = new Set(retry.completedChunks);
  const source = chunks ?? createUploadChunkStates(retry.size, retry.chunkSize, retry.chunkCount);

  return source.map((chunk) => {
    if (completed.has(chunk.index)) {
      return { ...chunk, status: "completed", errorMessage: undefined };
    }
    if (failed.has(chunk.index)) {
      return { ...chunk, status: "queued", errorMessage: undefined };
    }
    return chunk;
  });
}

export function updateChunkStates(
  chunks: UploadChunkState[] | undefined,
  chunkIndex: number,
  patch: Partial<UploadChunkState>
): UploadChunkState[] | undefined {
  if (!chunks) {
    return chunks;
  }

  let changed = false;
  const next = chunks.map((chunk) => {
    if (chunk.index !== chunkIndex) {
      return chunk;
    }

    const patched = { ...chunk, ...patch };
    if (uploadChunkStateEqual(chunk, patched)) {
      return chunk;
    }

    changed = true;
    return patched;
  });

  return changed ? next : chunks;
}

export function expectedUploadChunkSize(size: number, chunkSize: number, chunkCount: number, chunkIndex: number): number {
  return chunkIndex === chunkCount - 1 ? size - chunkSize * chunkIndex : chunkSize;
}
