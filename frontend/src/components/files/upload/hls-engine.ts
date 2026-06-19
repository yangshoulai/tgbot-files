import type { SourceRequestHeaders } from "../../../api";
import {
  ApiError,
  completeHlsSegment,
  completeHlsUpload,
  getHlsUploadStatus,
  importHlsSegment,
  importHlsSegmentChunk,
  initHlsUpload,
  probeHlsUpload
} from "../../../api";
import type { HlsRetryState } from "../../../lib/upload-tasks";

import type { UploadEngineContext } from "./engine-context";
import {
  HLS_SEGMENT_REQUEST_TIMEOUT_MS,
  HlsSegmentUploadError,
  MULTIPART_UPLOAD_MAX_ATTEMPTS,
  FILE_NAME_CONFLICT_TOAST_MESSAGE
} from "./constants";
import {
  runAbortableUploadRequest,
  runConcurrentChunks
} from "./chunk-engine";
import { chunkRange } from "./chunk-math";
import { delay, errorMessage, isAbortError, isRetryableChunkUploadError, retryDelayMs } from "./abort-retry";
import { fileNameConflictFromError, normalizedFileNameOverride } from "./filename-conflict";
import { seedUploadRuntimeStore } from "./runtime-store";
import {
  createHlsSegmentStates,
  hlsProbeSummary,
  hlsRetryFailureProgress,
  hlsRetryFromStatus,
  prepareHlsRetryChunks,
  withoutHlsRetry
} from "./hls-helpers";
import { updateUrlChunk, updateUrlChunkFromHlsSegment, updateUrlProgress } from "./engine-updates";

export function sameOriginAdminUrl(value: string): string {
  if (typeof window === "undefined") {
    return value;
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.pathname.startsWith("/api/admin/")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    return value;
  }

  return value;
}

export async function submitHlsUpload(ctx: UploadEngineContext, sourceHeaders?: SourceRequestHeaders) {
  const error = ctx.validateSourceUrl(ctx.sourceUrl);
  if (error) {
    ctx.setUrlUpload({ status: "error", message: error });
    ctx.onError(error);
    return;
  }

  const task = ctx.startUploadTask("url");
  let completionRetry: HlsRetryState | undefined;

  ctx.setSubmitting(true);
  seedUploadRuntimeStore(ctx.urlRuntimeStore, { completed: 0, total: 1, label: "探测 HLS 播放列表" });
  ctx.setUrlUpload((current) => ({
    ...current,
    status: "uploading",
    message: undefined,
    retry: undefined,
    conflict: undefined,
    progress: undefined
  }));

  try {
    let probe = ctx.urlUpload.hls?.probe;
    let variantId = ctx.urlUpload.hls?.variantId;

    if (!probe || (probe.kind === "master" && variantId && probe.selected_variant_id !== variantId)) {
      probe = (await probeHlsUpload(ctx.normalizedSourceUrl, variantId, sourceHeaders, task.abortController.signal)).hls;
    }

    if (probe.kind === "master" && !probe.media) {
      if (probe.variants.length === 1) {
        variantId = probe.variants[0]?.id;
        probe = (await probeHlsUpload(ctx.normalizedSourceUrl, variantId, sourceHeaders, task.abortController.signal)).hls;
      } else if (!variantId) {
        ctx.urlRuntimeStore.reset();
        ctx.setUrlUpload((current) => ({
          ...current,
          status: "pending",
          message: "检测到多码率 HLS，请先选择一个 variant",
          progress: undefined,
          chunks: undefined,
          hls: { probe }
        }));
        return;
      } else {
        probe = (await probeHlsUpload(ctx.normalizedSourceUrl, variantId, sourceHeaders, task.abortController.signal)).hls;
      }
    }

    if (probe.kind === "master" && !probe.media) {
      throw new Error("请选择一个可导入的 HLS variant");
    }

    const selectedVariantId = probe.kind === "master"
      ? probe.selected_variant_id ?? variantId
      : undefined;
    const fileName = normalizedFileNameOverride(ctx.urlUpload.fileNameOverride) ?? probe.file_name;
    const conflictAction = ctx.urlUpload.conflictAction ?? "error";

    const createHlsTaskProgress = { completed: 0, total: probe.media?.segment_count ?? 1, label: "创建 HLS 上传任务" };
    seedUploadRuntimeStore(ctx.urlRuntimeStore, createHlsTaskProgress);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: hlsProbeSummary(probe),
      progress: undefined,
      hls: {
        probe,
        ...(selectedVariantId ? { variantId: selectedVariantId } : {})
      }
    }));

    const init = await initHlsUpload({
      url: ctx.normalizedSourceUrl,
      ...(selectedVariantId ? { variant_id: selectedVariantId } : {}),
      file_name: fileName,
      directory_path: ctx.uploadDirectoryPath,
      ...(sourceHeaders ? { headers: sourceHeaders } : {}),
      ...(ctx.remark.trim() ? { remark: ctx.remark.trim() } : {}),
      ...(conflictAction !== "error" ? { on_conflict: conflictAction } : {})
    }, task.abortController.signal);
    const asset = init.hls.asset;
    const segments = init.hls.segments;
    const previewPlaylistUrl = sameOriginAdminUrl(asset.preview_playlist_url);

    completionRetry = hlsRetryFromStatus(asset, segments, conflictAction);
    ctx.persistHlsUploadTask(completionRetry, fileName, selectedVariantId);
    const initialChunks = createHlsSegmentStates(segments);
    const startProgress = { completed: 0, total: asset.segment_count, label: `开始导入 HLS 片段（${ctx.effectiveUploadConcurrency} 并发）` };
    seedUploadRuntimeStore(ctx.urlRuntimeStore, startProgress, initialChunks);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: `HLS 视频 · ${asset.segment_count} 个片段`,
      progress: undefined,
      hls: {
        probe,
        assetId: asset.id,
        segmentCount: asset.segment_count,
        previewPlaylistUrl,
        ...(selectedVariantId ? { variantId: selectedVariantId } : {})
      }
    }));

    const result = await runConcurrentChunks({
      total: asset.segment_count,
      taskLabel: "导入 HLS 片段",
      doneLabel: "已导入 HLS 片段",
      concurrency: ctx.effectiveUploadConcurrency,
      task,
      requestTimeoutMs: HLS_SEGMENT_REQUEST_TIMEOUT_MS,
      onProgress: (progress) => updateUrlProgress(ctx, progress),
      onChunkState: (index, patch) => updateUrlChunk(ctx, index, patch),
      onChunk: async (index, signal) => {
        await uploadHlsSegmentFully(ctx, asset.id, index, previewPlaylistUrl, asset.file_name, signal);
      }
    });

    if (result.failedChunks.length > 0 || result.cancelled) {
      const retry = await refreshHlsRetryState(ctx, {
        ...completionRetry,
        completedSegments: result.completedChunks,
        failedSegments: result.failedChunks
      });
      ctx.persistHlsUploadTask(retry, fileName, selectedVariantId);
      throw new HlsSegmentUploadError(
        result.cancelled ? "已停止，可重试未完成 HLS 片段" : `有 ${result.failedChunks.length} 个 HLS 片段导入失败，可手动重试`,
        retry,
        result.cancelled
      );
    }

    completionRetry = await refreshHlsRetryState(ctx, {
      ...completionRetry,
      completedSegments: chunkRange(asset.segment_count),
      failedSegments: []
    });
    ctx.persistHlsUploadTask(completionRetry, fileName, selectedVariantId);
    const indexProgress = { completed: asset.segment_count, total: asset.segment_count, label: "正在生成 HLS 文件索引" };
    seedUploadRuntimeStore(ctx.urlRuntimeStore, indexProgress, ctx.urlRuntimeStore.getSnapshot().chunks);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      progress: undefined
    }));
    const thumbnail = await ctx.resolveHlsThumbnailForUpload(previewPlaylistUrl, asset.file_name);
    await runAbortableUploadRequest(task, HLS_SEGMENT_REQUEST_TIMEOUT_MS, (signal) =>
      completeHlsUpload(asset.id, thumbnail, signal, conflictAction)
    );
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "done",
      message: "已导入 HLS 视频",
      progress: undefined,
      chunks: undefined,
      retry: undefined,
      conflict: undefined,
      conflictAction: "error",
      editingFileName: false,
      hls: current.hls ? withoutHlsRetry(current.hls) : current.hls
    }));
    ctx.clearCurrentPersistedTask();
    ctx.onUploaded(1);
  } catch (uploadError) {
    const retry = uploadError instanceof HlsSegmentUploadError ? uploadError.retry : completionRetry;
    const stopped = (uploadError instanceof HlsSegmentUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
    const conflict = fileNameConflictFromError(uploadError);
    const message = stopped
      ? "已停止"
      : uploadError instanceof ApiError
        ? uploadError.message
        : uploadError instanceof Error
          ? uploadError.message
          : "HLS 上传失败";

    const retryProgress = retry && !conflict
      ? hlsRetryFailureProgress(retry, stopped ? "已停止，可重试未完成 HLS 片段" : "HLS 片段导入失败，可手动重试")
      : undefined;
    seedUploadRuntimeStore(ctx.urlRuntimeStore, retryProgress, ctx.urlRuntimeStore.getSnapshot().chunks);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "error",
      message: conflict ? undefined : message,
      retry: undefined,
      conflict,
      fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
      conflictAction: "error",
      editingFileName: conflict ? true : current.editingFileName,
      progress: undefined,
      hls: retry
        ? {
            ...(current.hls ?? {}),
            assetId: retry.assetId,
            segmentCount: retry.segmentCount,
            previewPlaylistUrl: retry.previewPlaylistUrl,
            retry
          }
        : current.hls
    }));
    if (retry && !conflict && !stopped) {
      ctx.persistHlsUploadTask(retry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride), ctx.urlUpload.hls?.variantId);
    }
    if (!stopped) {
      ctx.onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
    }
  } finally {
    ctx.finishUploadTask(task);
    ctx.setSubmitting(false);
  }
}

export async function retryHlsUpload(ctx: UploadEngineContext, retry: HlsRetryState) {
  const task = ctx.startUploadTask("url");
  const conflictAction = ctx.urlUpload.conflictAction ?? retry.conflictAction;
  let syncedRetry = await refreshHlsRetryState(ctx, { ...retry, conflictAction });
  ctx.persistHlsUploadTask(syncedRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride), ctx.urlUpload.hls?.variantId);

  ctx.setSubmitting(true);
  const hlsRetryProgress = hlsRetryFailureProgress(syncedRetry, "准备重试失败 HLS 片段");
  const hlsRetryChunks = prepareHlsRetryChunks(ctx.urlRuntimeStore.getSnapshot().chunks ?? ctx.urlUpload.chunks, syncedRetry);
  seedUploadRuntimeStore(ctx.urlRuntimeStore, hlsRetryProgress, hlsRetryChunks);
  ctx.setUrlUpload((current) => ({
    ...current,
    status: "uploading",
    message: "准备重试 HLS 片段",
    retry: undefined,
    conflict: undefined,
    progress: undefined,
    hls: {
      ...(current.hls ?? {}),
      assetId: syncedRetry.assetId,
      segmentCount: syncedRetry.segmentCount,
      previewPlaylistUrl: syncedRetry.previewPlaylistUrl,
      retry: syncedRetry
    }
  }));

  try {
    if (syncedRetry.failedSegments.length > 0) {
      const result = await runConcurrentChunks({
        total: syncedRetry.segmentCount,
        chunkIndexes: syncedRetry.failedSegments,
        completedChunks: syncedRetry.completedSegments,
        taskLabel: "重试 HLS 片段",
        doneLabel: "已导入 HLS 片段",
        concurrency: ctx.effectiveUploadConcurrency,
        task,
        requestTimeoutMs: HLS_SEGMENT_REQUEST_TIMEOUT_MS,
        onProgress: (progress) => updateUrlProgress(ctx, progress),
        onChunkState: (index, patch) => updateUrlChunk(ctx, index, patch),
        onChunk: async (index, signal) => {
          await uploadHlsSegmentFully(ctx, syncedRetry.assetId, index, syncedRetry.previewPlaylistUrl, syncedRetry.fileName, signal);
        }
      });

      if (result.failedChunks.length > 0 || result.cancelled) {
        const nextRetry = await refreshHlsRetryState(ctx, {
          ...syncedRetry,
          completedSegments: result.completedChunks,
          failedSegments: result.failedChunks
        });
        ctx.persistHlsUploadTask(nextRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride), ctx.urlUpload.hls?.variantId);
        throw new HlsSegmentUploadError(
          result.cancelled ? "已停止，可重试未完成 HLS 片段" : `仍有 ${result.failedChunks.length} 个 HLS 片段导入失败，可继续手动重试`,
          nextRetry,
          result.cancelled
        );
      }

      syncedRetry = await refreshHlsRetryState(ctx, {
        ...syncedRetry,
        completedSegments: result.completedChunks,
        failedSegments: []
      });
      ctx.persistHlsUploadTask(syncedRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride), ctx.urlUpload.hls?.variantId);
    }

    ctx.setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      progress: undefined
    }));
    updateUrlProgress(ctx, {
      completed: syncedRetry.segmentCount,
      total: syncedRetry.segmentCount,
      label: "正在生成 HLS 文件索引"
    });
    const thumbnail = await ctx.resolveHlsThumbnailForUpload(syncedRetry.previewPlaylistUrl, syncedRetry.fileName);
    await runAbortableUploadRequest(task, HLS_SEGMENT_REQUEST_TIMEOUT_MS, (signal) =>
      completeHlsUpload(syncedRetry.assetId, thumbnail, signal, conflictAction)
    );
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "done",
      message: "已导入 HLS 视频",
      progress: undefined,
      chunks: undefined,
      retry: undefined,
      conflict: undefined,
      conflictAction: "error",
      editingFileName: false,
      hls: current.hls ? withoutHlsRetry(current.hls) : current.hls
    }));
    ctx.clearCurrentPersistedTask();
    ctx.onUploaded(1);
  } catch (uploadError) {
    const nextRetry = uploadError instanceof HlsSegmentUploadError ? uploadError.retry : syncedRetry;
    const stopped = (uploadError instanceof HlsSegmentUploadError && uploadError.stopped) || task.cancelled || isAbortError(uploadError);
    const conflict = fileNameConflictFromError(uploadError);
    const message = stopped ? "已停止" : uploadError instanceof Error ? uploadError.message : "HLS 片段重试失败";
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "error",
      message: conflict ? undefined : message,
      retry: undefined,
      conflict,
      fileNameOverride: conflict?.suggestedName ?? current.fileNameOverride,
      conflictAction: "error",
      editingFileName: conflict ? true : current.editingFileName,
      progress: undefined,
      hls: {
        ...(current.hls ?? {}),
        assetId: nextRetry.assetId,
        segmentCount: nextRetry.segmentCount,
        previewPlaylistUrl: nextRetry.previewPlaylistUrl,
        retry: nextRetry
      }
    }));
    if (nextRetry && !conflict && !stopped) {
      ctx.persistHlsUploadTask(nextRetry, normalizedFileNameOverride(ctx.urlUpload.fileNameOverride), ctx.urlUpload.hls?.variantId);
    }
    if (!stopped) {
      ctx.onError(conflict ? FILE_NAME_CONFLICT_TOAST_MESSAGE : message);
    }
  } finally {
    ctx.finishUploadTask(task);
    ctx.setSubmitting(false);
  }
}

export async function uploadHlsSegmentFully(
  ctx: UploadEngineContext,
  assetId: string,
  segmentIndex: number,
  previewPlaylistUrl: string,
  fileName: string,
  signal: AbortSignal
) {
  let response = await importHlsSegment(assetId, segmentIndex, signal);
  updateUrlChunkFromHlsSegment(ctx, response.segment, response.missing_chunks);

  if (response.segment.storage_backend === "telegram_multipart") {
    response = await importHlsSegmentMultipartChunks(ctx, assetId, segmentIndex, response, signal);
  }

  if (response.segment.status !== "done") {
    throw new Error(response.segment.error_message || `HLS 片段 ${segmentIndex + 1} 未完成`);
  }

  updateUrlChunkFromHlsSegment(ctx, response.segment, []);

  if (segmentIndex === 0) {
    void ctx.maybeGenerateHlsThumbnail(previewPlaylistUrl, fileName);
  }
}

export async function importHlsSegmentMultipartChunks(
  ctx: UploadEngineContext,
  assetId: string,
  segmentIndex: number,
  initialResponse: Awaited<ReturnType<typeof importHlsSegment>>,
  signal: AbortSignal
): Promise<Awaited<ReturnType<typeof importHlsSegment>>> {
  let response = initialResponse;
  let segment = response.segment;
  const chunkCount = segment.chunk_count ?? Math.max(response.uploaded_chunks.length + response.missing_chunks.length, 1);

  if (!segment.chunk_count || segment.chunk_count <= 0) {
    throw new Error(`HLS 片段 ${segmentIndex + 1} 缺少内部 chunk 信息`);
  }

  for (const chunkIndex of response.missing_chunks) {
    response = await importHlsSegmentChunkWithRetry(ctx, assetId, segmentIndex, chunkIndex, chunkCount, response.uploaded_chunks.length, signal);
    segment = response.segment;
    updateUrlChunkFromHlsSegment(ctx, segment, response.missing_chunks);
  }

  if (response.missing_chunks.length > 0) {
    throw new Error(`HLS 片段 ${segmentIndex + 1} 仍有 ${response.missing_chunks.length} 个内部 chunk 未完成`);
  }

  updateUrlChunk(ctx, segmentIndex, {
    status: "uploading",
    errorMessage: "正在合成大 HLS 片段"
  });
  return completeHlsSegment(assetId, segmentIndex, signal);
}

export async function importHlsSegmentChunkWithRetry(
  ctx: UploadEngineContext,
  assetId: string,
  segmentIndex: number,
  chunkIndex: number,
  chunkCount: number,
  completedBefore: number,
  signal: AbortSignal
): Promise<Awaited<ReturnType<typeof importHlsSegmentChunk>>> {
  for (let attempt = 1; attempt <= MULTIPART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    updateUrlChunk(ctx, segmentIndex, {
      status: "uploading",
      attempts: attempt,
      errorMessage: `大 HLS 片段内部分片 ${completedBefore + 1}/${chunkCount}（#${chunkIndex + 1}，第 ${attempt}/${MULTIPART_UPLOAD_MAX_ATTEMPTS} 次）`
    });

    try {
      return await importHlsSegmentChunk(assetId, segmentIndex, chunkIndex, signal);
    } catch (error) {
      const canRetry = attempt < MULTIPART_UPLOAD_MAX_ATTEMPTS && isRetryableChunkUploadError(error);
      if (!canRetry) {
        throw new Error(`HLS 片段 ${segmentIndex + 1} 的内部分片 ${chunkIndex + 1} 导入失败：${errorMessage(error)}`);
      }
      await delay(retryDelayMs(attempt, error), signal);
    }
  }

  throw new Error(`HLS 片段 ${segmentIndex + 1} 的内部分片 ${chunkIndex + 1} 导入失败`);
}

export async function refreshHlsRetryState(ctx: UploadEngineContext, retry: HlsRetryState): Promise<HlsRetryState> {
  try {
    const status = await getHlsUploadStatus(retry.assetId);
    return hlsRetryFromStatus(status.hls.asset, status.hls.segments, retry.conflictAction);
  } catch {
    return retry;
  }
}
