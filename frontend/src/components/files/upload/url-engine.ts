import type { HlsSegment } from "../../../api";
import {
  ApiError,
  initUrlMultipartUpload,
  uploadUrlMultipartChunk
} from "../../../api";
import type { MultipartRetryState } from "../../../lib/upload-tasks";

import type { UploadEngineContext } from "./engine-context";
import { updateUrlChunk, updateUrlChunkFromHlsSegment, updateUrlProgress } from "./engine-updates";
import {
  URL_CHUNK_REQUEST_TIMEOUT_MS,
  MultipartChunkUploadError,
  FILE_NAME_CONFLICT_TOAST_MESSAGE
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
import { fileNameConflictFromError, normalizedFileNameOverride } from "./filename-conflict";
import { seedUploadRuntimeStore } from "./runtime-store";
import { chunkProgressEqual } from "./equality";
import { isLikelyMagnetUrl } from "./magnet-helpers";
import { hlsSegmentChunkMessage, hlsSegmentChunkStatus, isLikelyHlsUrl } from "./hls-helpers";
import { thumbnailStatePayload } from "./thumbnail-helpers";
import type { ChunkProgress, UploadChunkState } from "./types";

import { submitMagnetUpload } from "./magnet-engine";
import { retryHlsUpload, submitHlsUpload } from "./hls-engine";

export async function submitUrlUpload(ctx: UploadEngineContext) {
  if (ctx.urlUpload.hls?.retry) {
    await retryHlsUpload(ctx, ctx.urlUpload.hls.retry);
    return;
  }

  if (ctx.urlUpload.retry?.kind === "url") {
    await retryUrlMultipart(ctx, ctx.urlUpload.retry);
    return;
  }

  const error = ctx.validateSourceUrl(ctx.sourceUrl);
  if (error) {
    ctx.setUrlUpload({ status: "error", message: error });
    ctx.onError(error);
    return;
  }

  if (isLikelyMagnetUrl(ctx.normalizedSourceUrl)) {
    await submitMagnetUpload(ctx);
    return;
  }

  const sourceHeadersResult = ctx.readSourceHeadersForUpload();
  if (!sourceHeadersResult.ok) {
    return;
  }
  const sourceHeaders = sourceHeadersResult.headers;

  if (isLikelyHlsUrl(ctx.normalizedSourceUrl) || ctx.urlUpload.hls?.probe) {
    await submitHlsUpload(ctx, sourceHeaders);
    return;
  }

  const task = ctx.startUploadTask("url");
  ctx.setSubmitting(true);
  seedUploadRuntimeStore(ctx.urlRuntimeStore, { completed: 0, total: 1, label: "探测远程文件" });
  ctx.setUrlUpload((current) => ({
    ...current,
    status: "uploading",
    message: undefined,
    conflict: undefined,
    progress: undefined
  }));

  try {
    const fileNameOverride = normalizedFileNameOverride(ctx.urlUpload.fileNameOverride);
    const conflictAction = ctx.urlUpload.conflictAction ?? "error";
    const init = await initUrlMultipartUpload(
      ctx.normalizedSourceUrl,
      ctx.remark.trim() || undefined,
      ctx.uploadDirectoryPath,
      true,
      fileNameOverride,
      conflictAction,
      sourceHeaders,
      task.abortController.signal
    );
    if (init.mode === "multipart" && init.upload) {
      const upload = init.upload;
      const initialRetry: MultipartRetryState = {
        kind: "url",
        uploadId: upload.id,
        size: upload.size,
        chunkSize: upload.chunk_size,
        chunkCount: upload.chunk_count,
        directAccess: upload.direct_access !== false,
        conflictAction,
        completedChunks: [],
        failedChunks: chunkRange(upload.chunk_count)
      };
      ctx.persistUrlMultipartUploadTask(initialRetry, fileNameOverride);
      const thumbnail = await ctx.resolveUrlThumbnailForUpload(upload.thumbnail_source);
      const initialChunks = createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count);
      seedUploadRuntimeStore(ctx.urlRuntimeStore, undefined, initialChunks);
      ctx.setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: undefined
      }));
      const result = await runConcurrentChunks({
        total: upload.chunk_count,
        taskLabel: "导入分片",
        doneLabel: "已导入",
        concurrency: ctx.effectiveUploadConcurrency,
        task,
        requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
        onProgress: (progress) => updateUrlProgress(ctx, progress),
        onChunkState: (index, patch) => updateUrlChunk(ctx, index, patch),
        onChunk: async (index, signal) => {
          await uploadUrlMultipartChunk(upload.id, index, signal);
        }
      });

      if (result.failedChunks.length > 0 || result.cancelled) {
        const retry = await refreshMultipartRetryState({
          kind: "url",
          uploadId: upload.id,
          size: upload.size,
          chunkSize: upload.chunk_size,
          chunkCount: upload.chunk_count,
          directAccess: upload.direct_access !== false,
          conflictAction,
          completedChunks: result.completedChunks,
          failedChunks: result.failedChunks
        });
        ctx.persistUrlMultipartUploadTask(retry, fileNameOverride);
        throw new MultipartChunkUploadError(
          result.cancelled ? "已停止，可重试未完成分片" : `有 ${result.failedChunks.length} 个分片导入失败，可手动重试`,
          retry,
          result.cancelled
        );
      }

      const completeProgress = {
        completed: upload.chunk_count,
        total: upload.chunk_count,
        label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
      };
      seedUploadRuntimeStore(ctx.urlRuntimeStore, completeProgress, ctx.urlRuntimeStore.getSnapshot().chunks);
      ctx.setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: undefined
      }));
      await completeUploadOrRetryLater({
        kind: "url",
        uploadId: upload.id,
        size: upload.size,
        chunkSize: upload.chunk_size,
        chunkCount: upload.chunk_count,
        directAccess: upload.direct_access !== false,
        conflictAction,
        thumbnail,
        task,
        timeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS
      });
    } else {
      throw new ApiError(500, "URL 上传初始化未返回分片会话", "InvalidUploadMode");
    }
    seedUploadRuntimeStore(ctx.urlRuntimeStore, null, null);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "done",
      message: "已从 URL 上传",
      progress: undefined,
      chunks: undefined,
      retry: undefined,
      conflict: undefined,
      conflictAction: "error",
      editingFileName: false
    }));
    ctx.clearCurrentPersistedTask();
    ctx.onUploaded(1);
  } catch (uploadError) {
    const retry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : undefined;
    const stopped = (uploadError instanceof MultipartChunkUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
    const conflict = fileNameConflictFromError(uploadError);
    const message = stopped
      ? "已停止"
      : uploadError instanceof ApiError
        ? uploadError.message
        : uploadError instanceof Error
          ? uploadError.message
          : "URL 上传失败";
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "error",
      message: conflict ? undefined : message,
      retry: conflict ? undefined : retry,
      conflict,
      fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
      conflictAction: "error",
      editingFileName: conflict ? true : current.editingFileName,
      progress: undefined
    }));
    seedUploadRuntimeStore(
      ctx.urlRuntimeStore,
      retry && !conflict
        ? retryFailureProgress(retry, stopped ? "已停止，可重试未完成分片" : "分片导入失败，可手动重试")
        : null,
      retry && !conflict ? ctx.urlRuntimeStore.getSnapshot().chunks : null
    );
    if (retry && !conflict && !stopped) {
      ctx.persistUrlMultipartUploadTask(retry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride));
    }
    if (!stopped) {
      ctx.onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
    }
  } finally {
    ctx.finishUploadTask(task);
    ctx.setSubmitting(false);
  }
}

export async function retryUrlMultipart(ctx: UploadEngineContext, retry: MultipartRetryState) {
  const task = ctx.startUploadTask("url");
  const syncedRetry = await refreshMultipartRetryState(retry);
  ctx.persistUrlMultipartUploadTask(syncedRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride));
  ctx.setSubmitting(true);
  const retryStartProgress = retryFailureProgress(syncedRetry, "准备重试失败分片");
  const retryChunks = prepareRetryChunks(ctx.urlRuntimeStore.getSnapshot().chunks ?? ctx.urlUpload.chunks, syncedRetry);
  seedUploadRuntimeStore(ctx.urlRuntimeStore, retryStartProgress, retryChunks);
  ctx.setUrlUpload((current) => ({
    ...current,
    status: "uploading",
    progress: undefined,
    retry: syncedRetry
  }));

  try {
    const result = await runConcurrentChunks({
      total: syncedRetry.chunkCount,
      chunkIndexes: syncedRetry.failedChunks,
      completedChunks: syncedRetry.completedChunks,
      taskLabel: "重试导入分片",
      doneLabel: "已导入",
      concurrency: ctx.effectiveUploadConcurrency,
      task,
      requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
      onProgress: (progress) => updateUrlProgress(ctx, progress),
      onChunkState: (index, patch) => updateUrlChunk(ctx, index, patch),
      onChunk: async (index, signal) => {
        await uploadUrlMultipartChunk(syncedRetry.uploadId, index, signal);
      }
    });

    if (result.failedChunks.length > 0 || result.cancelled) {
      const nextRetry = await refreshMultipartRetryState({
        ...syncedRetry,
        completedChunks: result.completedChunks,
        failedChunks: result.failedChunks
      });
      ctx.persistUrlMultipartUploadTask(nextRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride));
      throw new MultipartChunkUploadError(
        result.cancelled ? "已停止，可重试未完成分片" : `仍有 ${result.failedChunks.length} 个分片导入失败，可继续手动重试`,
        nextRetry,
        result.cancelled
      );
    }

    const completeProgress = {
      completed: syncedRetry.chunkCount,
      total: syncedRetry.chunkCount,
      label: syncedRetry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
    };
    seedUploadRuntimeStore(ctx.urlRuntimeStore, completeProgress, ctx.urlRuntimeStore.getSnapshot().chunks);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      progress: undefined
    }));
    const thumbnail = ctx.urlUpload.thumbnail?.status === "ready"
      ? thumbnailStatePayload(ctx.urlUpload.thumbnail)
      : undefined;
    await completeUploadOrRetryLater({
      ...syncedRetry,
      thumbnail,
      task,
      timeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS
    });
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "done",
      message: "已从 URL 上传",
      progress: undefined,
      chunks: undefined,
      retry: undefined,
      conflictAction: "error",
      editingFileName: false
    }));
    ctx.clearCurrentPersistedTask();
    ctx.onUploaded(1);
  } catch (uploadError) {
    const nextRetry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : syncedRetry;
    const stopped = (uploadError instanceof MultipartChunkUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
    const message = stopped ? "已停止" : uploadError instanceof Error ? uploadError.message : "URL 分片重试失败";
    const retryProgress = retryFailureProgress(nextRetry, stopped ? "已停止，可重试未完成分片" : "分片导入失败，可手动重试");
    seedUploadRuntimeStore(ctx.urlRuntimeStore, retryProgress, ctx.urlRuntimeStore.getSnapshot().chunks);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "error",
      message,
      retry: nextRetry,
      progress: undefined
    }));
    if (nextRetry && !stopped) {
      ctx.persistUrlMultipartUploadTask(nextRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride));
    }
    if (!stopped) {
      ctx.onError(message);
    }
  } finally {
    ctx.finishUploadTask(task);
    ctx.setSubmitting(false);
  }
}
