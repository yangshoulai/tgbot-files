import type { ThumbnailUploadPayload } from "../../../api";
import {
  initMultipartUpload,
  uploadMultipartChunk
} from "../../../api";
import type { MultipartRetryState } from "../../../lib/upload-tasks";

import type { UploadEngineContext } from "./engine-context";
import {
  LOCAL_CHUNK_REQUEST_TIMEOUT_MS,
  MultipartChunkUploadError
} from "./constants";
import {
  completeUploadOrRetryLater,
  refreshMultipartRetryState,
  runConcurrentChunks
} from "./chunk-engine";
import {
  chunkRange,
  createUploadChunkStates,
  prepareRetryChunks,
  retryFailureProgress,
  updateChunkStates
} from "./chunk-math";
import { isAbortError } from "./abort-retry";
import { effectiveDirectoryPath, effectiveFileName, fileNameConflictFromError } from "./filename-conflict";
import { seedUploadRuntimeStore } from "./runtime-store";
import { chunkProgressEqual } from "./equality";
import { ApiError } from "../../../api";
import type { ChunkProgress, QueueItem, UploadAbortContext, UploadChunkState } from "./types";

export async function uploadLocalMultipart(
  ctx: UploadEngineContext,
  target: QueueItem,
  fileName: string,
  thumbnail: ThumbnailUploadPayload | undefined,
  task: UploadAbortContext
) {
  if (target.retry?.kind === "local") {
    await retryLocalMultipart(ctx, target, target.retry, thumbnail, task);
    return;
  }

  const conflictAction = target.conflictAction ?? "error";
  const init = await initMultipartUpload({
    file_name: fileName,
    mime_type: target.file.type || "application/octet-stream",
    size: target.file.size,
    directory_path: effectiveDirectoryPath(target, ctx.uploadDirectoryPath),
    ...(conflictAction !== "error" ? { on_conflict: conflictAction } : {}),
    ...(ctx.remark.trim() ? { remark: ctx.remark.trim() } : {})
  }, task.abortController.signal);
  const upload = init.upload;
  const initialRetry: MultipartRetryState = {
    kind: "local",
    uploadId: upload.id,
    size: upload.size,
    chunkSize: upload.chunk_size,
    chunkCount: upload.chunk_count,
    directAccess: upload.direct_access !== false,
    conflictAction,
    completedChunks: [],
    failedChunks: chunkRange(upload.chunk_count)
  };
  ctx.persistLocalUploadTask(target, initialRetry);

  const initialChunks = createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count);
  seedUploadRuntimeStore(target.runtimeStore!, undefined, initialChunks);

  const result = await runConcurrentChunks({
    total: upload.chunk_count,
    concurrency: ctx.effectiveUploadConcurrency,
    taskLabel: "上传分片",
    doneLabel: "已上传",
    task,
    requestTimeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS,
    onProgress: (progress) => updateItemProgress(ctx, target.id, progress),
    onChunkState: (index, patch) => updateItemChunk(ctx, target.id, index, patch),
    onChunk: async (index, signal) => {
      const start = index * upload.chunk_size;
      const end = Math.min(target.file.size, start + upload.chunk_size);
      await uploadMultipartChunk(upload.id, index, target.file.slice(start, end), signal);
    }
  });

  if (result.failedChunks.length > 0 || result.cancelled) {
    const retry = await refreshMultipartRetryState({
      kind: "local",
      uploadId: upload.id,
      size: upload.size,
      chunkSize: upload.chunk_size,
      chunkCount: upload.chunk_count,
      directAccess: upload.direct_access !== false,
        conflictAction,
        completedChunks: result.completedChunks,
        failedChunks: result.failedChunks
      });
    ctx.persistLocalUploadTask(target, retry);
    throw new MultipartChunkUploadError(
      result.cancelled ? "已停止，可重试未完成分片" : `有 ${result.failedChunks.length} 个分片上传失败，可手动重试`,
      retry,
      result.cancelled
    );
  }

  const completeProgress = {
    completed: upload.chunk_count,
    total: upload.chunk_count,
    label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
  };
  updateItemProgress(ctx, target.id, completeProgress);
  await completeUploadOrRetryLater({
    kind: "local",
    uploadId: upload.id,
    size: upload.size,
    chunkSize: upload.chunk_size,
    chunkCount: upload.chunk_count,
    directAccess: upload.direct_access !== false,
    conflictAction,
    thumbnail,
    task,
    timeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS
  });
  ctx.clearCurrentPersistedTask();
}

export async function retryLocalMultipart(
  ctx: UploadEngineContext,
  target: QueueItem,
  retry: MultipartRetryState,
  thumbnail: ThumbnailUploadPayload | undefined,
  task: UploadAbortContext
) {
  const syncedRetry = await refreshMultipartRetryState(retry);
  seedUploadRuntimeStore(
    target.runtimeStore!,
    undefined,
    prepareRetryChunks(target.runtimeStore?.getSnapshot().chunks ?? target.chunks, syncedRetry)
  );
  ctx.setItems((current) =>
    current.map((item) =>
      item.id === target.id
        ? { ...item, retry: syncedRetry }
        : item
    )
  );

  const result = await runConcurrentChunks({
    total: syncedRetry.chunkCount,
    concurrency: ctx.effectiveUploadConcurrency,
    chunkIndexes: syncedRetry.failedChunks,
    completedChunks: syncedRetry.completedChunks,
    taskLabel: "重试上传分片",
    doneLabel: "已上传",
    task,
    requestTimeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS,
    onProgress: (progress) => updateItemProgress(ctx, target.id, progress),
    onChunkState: (index, patch) => updateItemChunk(ctx, target.id, index, patch),
    onChunk: async (index, signal) => {
      const start = index * syncedRetry.chunkSize;
      const end = Math.min(target.file.size, start + syncedRetry.chunkSize);
      await uploadMultipartChunk(syncedRetry.uploadId, index, target.file.slice(start, end), signal);
    }
  });

  if (result.failedChunks.length > 0 || result.cancelled) {
    const nextRetry = await refreshMultipartRetryState({
      ...syncedRetry,
      completedChunks: result.completedChunks,
      failedChunks: result.failedChunks
    });
    ctx.persistLocalUploadTask(target, nextRetry);
    throw new MultipartChunkUploadError(
      result.cancelled ? "已停止，可重试未完成分片" : `仍有 ${result.failedChunks.length} 个分片上传失败，可继续手动重试`,
      nextRetry,
      result.cancelled
    );
  }

  updateItemProgress(ctx, target.id, {
    completed: syncedRetry.chunkCount,
    total: syncedRetry.chunkCount,
    label: syncedRetry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
  });
  await completeUploadOrRetryLater({
    ...syncedRetry,
    thumbnail,
    task,
    timeoutMs: LOCAL_CHUNK_REQUEST_TIMEOUT_MS
  });
  ctx.clearCurrentPersistedTask();
}

export function updateItemProgress(ctx: UploadEngineContext, id: string, progress: ChunkProgress) {
  const target = ctx.itemsRef.current.find((item) => item.id === id);
  if (!target?.runtimeStore) return;
  target.runtimeStore.setState((current) => {
    if (chunkProgressEqual(current.progress, progress)) {
      return current;
    }
    return { ...current, progress };
  });
}

export function updateItemChunk(ctx: UploadEngineContext, id: string, chunkIndex: number, patch: Partial<UploadChunkState>) {
  const target = ctx.itemsRef.current.find((item) => item.id === id);
  if (!target?.runtimeStore) return;
  target.runtimeStore.setState((current) => {
    const chunks = updateChunkStates(current.chunks, chunkIndex, patch);
    return chunks === current.chunks ? current : { ...current, chunks };
  });
}

export async function retryItemFailedChunks(ctx: UploadEngineContext, id: string) {
  if (ctx.uploadBusy) return;

  const target = ctx.items.find((item) => item.id === id);
  if (!target?.retry || target.retry.kind !== "local") {
    return;
  }

  const task = ctx.startUploadTask("local", id);
  ctx.setSubmitting(true);
  const retryStartProgress = retryFailureProgress(target.retry, "准备重试失败分片");
  seedUploadRuntimeStore(
    target.runtimeStore!,
    retryStartProgress,
    prepareRetryChunks(target.runtimeStore?.getSnapshot().chunks ?? target.chunks, target.retry)
  );
  ctx.setItems((current) =>
    current.map((item) =>
      item.id === id
        ? { ...item, status: "uploading", message: undefined, progress: undefined }
        : item
    )
  );

  try {
    const thumbnail = await ctx.resolveLocalThumbnailForUpload(target);
    await retryLocalMultipart(ctx, target, target.retry, thumbnail, task);
    ctx.setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              status: "done",
              message: undefined,
              progress: undefined,
              chunks: undefined,
              retry: undefined,
              conflictAction: "error",
              editingFileName: false
            }
          : item
      )
    );
    ctx.onUploaded(1);
  } catch (error) {
    const retry = error instanceof MultipartChunkUploadError ? error.retry : target.retry;
    const stopped = (error instanceof MultipartChunkUploadError && error.stopped) || task.cancelled || isAbortError(error);
    const message = stopped ? "已停止" : error instanceof Error ? error.message : "分片重试失败";
    const retryProgress = retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片上传失败，可手动重试");
      ctx.setItems((current) =>
        current.map((item) =>
          item.id === id
            ? (() => {
                seedUploadRuntimeStore(item.runtimeStore!, retryProgress, item.runtimeStore?.getSnapshot().chunks ?? item.chunks);
              return {
                ...item,
                status: "error",
                message,
                retry,
                progress: undefined,
                chunks: undefined
              };
            })()
          : item
      )
    );
    if (retry && !stopped) {
      seedUploadRuntimeStore(target.runtimeStore!, retryProgress, target.runtimeStore?.getSnapshot().chunks ?? target.chunks);
    } else {
      seedUploadRuntimeStore(target.runtimeStore!, null, null);
    }
    if (!stopped) {
      ctx.onError(message);
    }
  } finally {
    ctx.finishUploadTask(task);
    ctx.setSubmitting(false);
  }
}
