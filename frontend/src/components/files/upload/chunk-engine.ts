import {
  completeMultipartUpload,
  getMultipartUploadStatus,
  type ThumbnailUploadPayload
} from "../../../api";
import {
  CHUNK_UI_UPDATE_INTERVAL_MS,
  MULTIPART_UPLOAD_MAX_ATTEMPTS,
  MultipartChunkUploadError
} from "./constants";
import {
  delay,
  errorMessage,
  isAbortError,
  isRetryableChunkUploadError,
  retryDelayMs
} from "./abort-retry";
import { chunkRange } from "./chunk-math";
import type { MultipartRetryState } from "../../../lib/upload-tasks";
import type {
  ChunkProgress,
  ChunkQueueResult,
  UploadAbortContext,
  UploadChunkState
} from "./types";

export async function runConcurrentChunks(params: {
  total: number;
  chunkIndexes?: number[];
  completedChunks?: number[];
  taskLabel: string;
  doneLabel: string;
  concurrency: number;
  task: UploadAbortContext;
  requestTimeoutMs: number;
  onChunk: (index: number, signal: AbortSignal) => Promise<void>;
  onProgress: (progress: ChunkProgress) => void;
  onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void;
}): Promise<ChunkQueueResult> {
  const chunkIndexes = params.chunkIndexes ?? chunkRange(params.total);
  const completedSet = new Set(params.completedChunks ?? []);
  const failedChunks: number[] = [];
  const concurrency = Math.min(params.concurrency, Math.max(1, chunkIndexes.length));
  let nextIndex = 0;
  const uiUpdates = createChunkUiUpdateBatcher(params.onProgress, params.onChunkState);

  const suffix = concurrency > 1 ? `（${concurrency} 并发）` : "";
  uiUpdates.progress({
    completed: completedSet.size,
    total: params.total,
    label: `${params.taskLabel} ${completedSet.size}/${params.total}${suffix}`
  });

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (params.task.cancelled) {
        break;
      }

      const queueIndex = nextIndex;
      nextIndex += 1;

      if (queueIndex >= chunkIndexes.length) {
        break;
      }

      const index = chunkIndexes[queueIndex];

      try {
        await uploadChunkWithRetry({
          ...params,
          onProgress: uiUpdates.progress,
          onChunkState: uiUpdates.chunkState,
          index,
          suffix,
          completed: () => completedSet.size
        });
        completedSet.add(index);
      } catch (error) {
        failedChunks.push(index);
      }

      uiUpdates.progress({
        completed: completedSet.size,
        total: params.total,
        failed: failedChunks.length,
        label: failedChunks.length > 0
          ? `${params.doneLabel} ${completedSet.size}/${params.total}，失败 ${failedChunks.length} 个${suffix}`
          : `${params.doneLabel} ${completedSet.size}/${params.total}${suffix}`
      });
    }
  });

  await Promise.all(workers);

  if (params.task.cancelled) {
    for (const index of chunkIndexes) {
      if (!completedSet.has(index)) {
        failedChunks.push(index);
        uiUpdates.chunkState(index, {
          status: "failed",
          errorMessage: "已停止"
        });
      }
    }
  }

  uiUpdates.flush();

  return {
    completedChunks: Array.from(completedSet).sort((left, right) => left - right),
    failedChunks: Array.from(new Set(failedChunks)).sort((left, right) => left - right),
    cancelled: params.task.cancelled
  };
}

async function uploadChunkWithRetry(params: {
  index: number;
  total: number;
  taskLabel: string;
  task: UploadAbortContext;
  requestTimeoutMs: number;
  onChunk: (index: number, signal: AbortSignal) => Promise<void>;
  onProgress: (progress: ChunkProgress) => void;
  onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void;
  suffix: string;
  completed: () => number;
}) {
  for (let attempt = 1; attempt <= MULTIPART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (params.task.cancelled) {
      params.onChunkState?.(params.index, {
        status: "failed",
        attempts: Math.max(1, attempt - 1),
        errorMessage: "已停止"
      });
      throw new Error("已停止");
    }

    params.onChunkState?.(params.index, {
      status: "uploading",
      attempts: attempt,
      errorMessage: undefined
    });
    params.onProgress({
      completed: params.completed(),
      total: params.total,
      label: attempt === 1
        ? `${params.taskLabel} ${params.index + 1}/${params.total}${params.suffix}`
        : `重试分片 ${params.index + 1}/${params.total}（第 ${attempt}/${MULTIPART_UPLOAD_MAX_ATTEMPTS} 次）${params.suffix}`
    });

    try {
      await runAbortableUploadRequest(params.task, params.requestTimeoutMs, (signal) => params.onChunk(params.index, signal));
      params.onChunkState?.(params.index, {
        status: "completed",
        attempts: attempt,
        errorMessage: undefined
      });
      return;
    } catch (error) {
      if (params.task.cancelled) {
        params.onChunkState?.(params.index, {
          status: "failed",
          attempts: attempt,
          errorMessage: "已停止"
        });
        throw new Error("已停止");
      }

      const canRetry = attempt < MULTIPART_UPLOAD_MAX_ATTEMPTS && isRetryableChunkUploadError(error);
      if (!canRetry) {
        params.onChunkState?.(params.index, {
          status: "failed",
          attempts: attempt,
          errorMessage: errorMessage(error)
        });
        throw new Error(`分片 ${params.index + 1} 处理失败：${errorMessage(error)}`);
      }

      await delay(retryDelayMs(attempt, error), params.task.abortController.signal);
    }
  }
}

function createChunkUiUpdateBatcher(
  onProgress: (progress: ChunkProgress) => void,
  onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void
) {
  let pendingProgress: ChunkProgress | null = null;
  const pendingChunkStates = new Map<number, Partial<UploadChunkState>>();
  let timerId: number | null = null;

  const flush = () => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }

    for (const [index, patch] of pendingChunkStates) {
      onChunkState?.(index, patch);
    }
    pendingChunkStates.clear();

    if (pendingProgress) {
      onProgress(pendingProgress);
      pendingProgress = null;
    }
  };

  const schedule = () => {
    if (timerId !== null) {
      return;
    }
    timerId = window.setTimeout(flush, CHUNK_UI_UPDATE_INTERVAL_MS);
  };

  return {
    progress(progress: ChunkProgress) {
      pendingProgress = progress;
      schedule();
    },
    chunkState(index: number, patch: Partial<UploadChunkState>) {
      pendingChunkStates.set(index, {
        ...(pendingChunkStates.get(index) ?? {}),
        ...patch
      });
      schedule();
    },
    flush
  };
}

export async function runAbortableUploadRequest<T>(
  task: UploadAbortContext,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abortFromTask = () => controller.abort();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  task.controllers.add(controller);
  task.abortController.signal.addEventListener("abort", abortFromTask, { once: true });

  try {
    if (task.cancelled || task.abortController.signal.aborted) {
      controller.abort();
    }

    return await request(controller.signal);
  } finally {
    window.clearTimeout(timeoutId);
    task.controllers.delete(controller);
    task.abortController.signal.removeEventListener("abort", abortFromTask);
  }
}

export async function completeUploadOrRetryLater(params: Omit<MultipartRetryState, "completedChunks" | "failedChunks"> & {
  thumbnail?: ThumbnailUploadPayload;
  task: UploadAbortContext;
  timeoutMs: number;
}) {
  const retry: MultipartRetryState = {
    kind: params.kind,
    uploadId: params.uploadId,
    size: params.size,
    chunkSize: params.chunkSize,
    chunkCount: params.chunkCount,
    directAccess: params.directAccess,
    conflictAction: params.conflictAction,
    completedChunks: chunkRange(params.chunkCount),
    failedChunks: []
  };

  try {
    await runAbortableUploadRequest(params.task, params.timeoutMs, (signal) =>
      completeMultipartUpload(params.uploadId, params.thumbnail, signal, params.conflictAction)
    );
  } catch (error) {
    if (params.task.cancelled || isAbortError(error)) {
      throw new MultipartChunkUploadError(
        params.task.cancelled ? "已停止，可继续完成上传" : "生成文件索引超时，可继续完成上传",
        retry,
        params.task.cancelled
      );
    }
    throw error;
  }
}

export async function refreshMultipartRetryState(retry: MultipartRetryState): Promise<MultipartRetryState> {
  try {
    const status = await getMultipartUploadStatus(retry.uploadId);
    if (status.upload.source_kind !== retry.kind) {
      return retry;
    }

    return {
      ...retry,
      size: status.upload.size,
      chunkSize: status.upload.chunk_size,
      chunkCount: status.upload.chunk_count,
      directAccess: status.upload.direct_access !== false,
      completedChunks: status.uploaded_chunks,
      failedChunks: status.missing_chunks
    };
  } catch {
    return retry;
  }
}
