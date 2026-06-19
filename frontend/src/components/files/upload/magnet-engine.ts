import type { FileNameConflictAction, MagnetImport } from "../../../api";
import {
  ApiError,
  completeMagnetMultipartUpload,
  getMagnetUploadStatus,
  initMagnetUpload,
  probeMagnetUpload,
  uploadMagnetMultipartChunk
} from "../../../api";

import type { UploadEngineContext } from "./engine-context";
import {
  MAGNET_DOWNLOAD_TIMEOUT_MS,
  MAGNET_STATUS_MAX_TRANSIENT_FAILURES,
  MAGNET_STATUS_POLL_MS,
  MAGNET_STATUS_RETRY_DELAY_MS,
  URL_CHUNK_REQUEST_TIMEOUT_MS
} from "./constants";
import {
  runAbortableUploadRequest,
  runConcurrentChunks
} from "./chunk-engine";
import { createUploadChunkStates } from "./chunk-math";
import { delay, errorMessage, isAbortError, isRetryableMagnetStatusError } from "./abort-retry";
import { fileNameConflictFromError } from "./filename-conflict";
import { seedUploadRuntimeStore } from "./runtime-store";
import { mergeMagnetState } from "./equality";
import {
  magnetFileUploadOptions,
  magnetImportStableUiKey,
  magnetStatusProgressLabel,
  selectedMagnetIndexesForResume
} from "./magnet-helpers";
import type { UploadAbortContext } from "./types";
import { updateUrlChunk, updateUrlProgress } from "./engine-updates";

export async function submitMagnetUpload(ctx: UploadEngineContext) {
  const task = ctx.startUploadTask("url");
  ctx.setSubmitting(true);
  const initialProgress = { completed: 0, total: 1, label: ctx.urlUpload.magnet?.import ? "准备磁力导入" : "解析磁力链接" };
  seedUploadRuntimeStore(ctx.urlRuntimeStore, initialProgress);
  ctx.setUrlUpload((current) => ({
    ...current,
    status: "uploading",
    message: undefined,
    retry: undefined,
    conflict: undefined,
    progress: undefined
  }));

  try {
    let magnet = ctx.urlUpload.magnet?.import;
    let selectedIndexes = ctx.urlUpload.magnet?.selectedIndexes ?? [];

    if (!magnet || magnet.status === "failed" || magnet.status === "cancelled" || magnet.status === "probing") {
      magnet = magnet && magnet.status === "probing"
        ? magnet
        : (await probeMagnetUpload(ctx.normalizedSourceUrl, task.abortController.signal)).magnet;
      if (magnet.status === "probing") {
        magnet = await waitForMagnetStatus(
          ctx,
          magnet.id,
          task,
          (current) => current.status !== "probing",
          "解析磁力文件列表"
        );
      }
      const parsedMagnet = magnet;
      selectedIndexes = selectedMagnetIndexesForResume(parsedMagnet, ctx.maxMultipartBytes);
      ctx.persistMagnetUploadTask(parsedMagnet.id, selectedIndexes);
      const parsedProgress = parsedMagnet.status === "ready" || parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled"
        ? null
        : { completed: 0, total: 1, label: magnetStatusProgressLabel("继续磁力任务", parsedMagnet, selectedIndexes.length) };
      seedUploadRuntimeStore(ctx.urlRuntimeStore, parsedProgress);
      ctx.setUrlUpload((current) => ({
        ...current,
        status: parsedMagnet.status === "ready" ? "pending" : parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled" ? "error" : "uploading",
        message: parsedMagnet.status === "ready"
          ? `已解析 ${parsedMagnet.files.length} 个文件，请选择要导入的文件后再次点击上传`
          : parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled"
            ? parsedMagnet.error_message || "磁力链接解析失败"
            : "检测到已有磁力任务，准备继续",
        progress: undefined,
        magnet: mergeMagnetState(current.magnet, {
          import: parsedMagnet,
          selectedIndexes,
          fileDecisions: {}
        })
      }));
      if (parsedMagnet.status !== "ready") {
        if (parsedMagnet.status === "failed" || parsedMagnet.status === "cancelled") {
          throw new Error(parsedMagnet.error_message || "磁力链接解析失败");
        }
      } else {
        await ctx.preflightMagnetSelection(parsedMagnet, selectedIndexes, {});
        return;
      }
    }

    if (selectedIndexes.length === 0 && magnet) {
      selectedIndexes = selectedMagnetIndexesForResume(magnet, ctx.maxMultipartBytes);
    }
    if (selectedIndexes.length === 0) {
      throw new Error("请选择至少一个磁力文件");
    }

    const currentMagnetState = ctx.urlUploadRef.current.magnet;
    const currentDecisions = currentMagnetState?.fileDecisions ?? {};
    if (!(await ctx.preflightMagnetSelection(magnet, selectedIndexes, currentDecisions))) {
      return;
    }
    const fileOptions = magnetFileUploadOptions(magnet, selectedIndexes, currentDecisions);
    const conflictActionByFileIndex = new Map<number, FileNameConflictAction>(
      fileOptions.map((option) => [option.file_index, option.on_conflict ?? "error"])
    );

    const init = await initMagnetUpload({
      import_id: magnet.id,
      file_indexes: selectedIndexes,
      file_options: fileOptions,
      directory_path: ctx.uploadDirectoryPath,
      ...(ctx.urlUpload.conflictAction && ctx.urlUpload.conflictAction !== "error" ? { on_conflict: ctx.urlUpload.conflictAction } : {}),
      ...(ctx.remark.trim() ? { remark: ctx.remark.trim() } : {})
    }, task.abortController.signal);
    magnet = init.magnet;
    const uploads = init.uploads.map((entry) => ({
      fileIndex: entry.file_index,
      upload: entry.upload,
      targetDirectoryPath: entry.target_directory_path,
      conflictAction: conflictActionByFileIndex.get(entry.file_index) ?? "error"
    }));
    ctx.persistMagnetUploadTask(magnet.id, selectedIndexes, uploads);

    const waitingProgress = { completed: 0, total: uploads.length, label: "等待磁力文件下载完成" };
    seedUploadRuntimeStore(ctx.urlRuntimeStore, waitingProgress);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      message: `aria2 正在下载 ${uploads.length} 个文件`,
      progress: undefined,
      magnet: mergeMagnetState(current.magnet, {
        import: magnet,
        selectedIndexes,
        uploads
      })
    }));

    magnet = await waitForMagnetStatus(
      ctx,
      magnet.id,
      task,
      (current) => current.status === "downloaded" || current.status === "importing" || current.status === "done" || current.status === "failed" || current.status === "cancelled",
      "下载磁力文件",
      {
        selectedCount: uploads.length,
        syncUiState: false
      }
    );
    if (magnet.status === "failed" || magnet.status === "cancelled") {
      throw new Error(magnet.error_message || "磁力文件下载失败");
    }
    if (magnet.status === "done") {
      seedUploadRuntimeStore(ctx.urlRuntimeStore, null, null);
      ctx.setUrlUpload((current) => ({
        ...current,
        status: "done",
        message: "磁力任务已完成",
        progress: undefined,
        chunks: undefined,
        magnet: mergeMagnetState(current.magnet, current.magnet ? { ...current.magnet, import: magnet, uploads } : { import: magnet, selectedIndexes, uploads })
      }));
      ctx.onUploaded(uploads.length);
      ctx.clearCurrentPersistedTask();
      return;
    }

    let completedFiles = 0;
    for (const entry of uploads) {
      const { upload, fileIndex, conflictAction } = entry;
      if (task.cancelled) {
        throw new Error("已停止");
      }
      const magnetFile = magnet.files.find((file) => file.file_index === fileIndex);
      if (magnetFile?.status === "done") {
        completedFiles += 1;
        continue;
      }

      const initialChunks = createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count);
      const importProgress = {
        completed: completedFiles,
        total: uploads.length,
        label: `导入文件 ${completedFiles + 1}/${uploads.length}`
      };
      seedUploadRuntimeStore(ctx.urlRuntimeStore, importProgress, initialChunks);
      ctx.setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        message: `正在导入 ${upload.file_name}`,
        progress: undefined,
        magnet: mergeMagnetState(current.magnet, current.magnet ? { ...current.magnet, import: magnet, uploads } : { import: magnet, selectedIndexes, uploads })
      }));

      const result = await runConcurrentChunks({
        total: upload.chunk_count,
        taskLabel: `导入 ${upload.file_name}`,
        doneLabel: `已导入 ${upload.file_name}`,
        concurrency: ctx.effectiveUploadConcurrency,
        task,
        requestTimeoutMs: URL_CHUNK_REQUEST_TIMEOUT_MS,
        onProgress: (progress) => {
          updateUrlProgress(ctx, {
            completed: progress.completed,
            total: progress.total,
            failed: progress.failed,
            label: `${completedFiles + 1}/${uploads.length} · ${progress.label}`
          });
        },
        onChunkState: (index, patch) => updateUrlChunk(ctx, index, patch),
        onChunk: async (index, signal) => {
          await uploadMagnetMultipartChunk(magnet!.id, fileIndex, index, signal);
        }
      });

      if (result.failedChunks.length > 0 || result.cancelled) {
        throw new Error(result.cancelled ? "已停止，可重新发起磁力导入" : `${upload.file_name} 有 ${result.failedChunks.length} 个分片导入失败`);
      }

      const thumbnail = await ctx.resolveMagnetThumbnailForUpload(magnet!.id, fileIndex, upload);
      if (task.cancelled) {
        throw new Error("已停止");
      }

      updateUrlProgress(ctx, {
        completed: upload.chunk_count,
        total: upload.chunk_count,
        label: `${completedFiles + 1}/${uploads.length} · 正在生成 ${upload.file_name} 文件索引`
      });
      await runAbortableUploadRequest(task, URL_CHUNK_REQUEST_TIMEOUT_MS, (signal) =>
        completeMagnetMultipartUpload(magnet!.id, fileIndex, thumbnail, signal, conflictAction)
      );
      completedFiles += 1;
    }

    const latest = await getMagnetUploadStatus(magnet.id, task.abortController.signal);
    seedUploadRuntimeStore(ctx.urlRuntimeStore, null, null);
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "done",
      message: `已导入 ${completedFiles} 个磁力文件`,
      progress: undefined,
      chunks: undefined,
      magnet: mergeMagnetState(current.magnet, {
        ...(current.magnet ?? { selectedIndexes }),
        import: latest.magnet,
        selectedIndexes,
        uploads
      })
    }));
    ctx.clearCurrentPersistedTask();
    ctx.onUploaded(completedFiles);
  } catch (uploadError) {
    const stopped = task.cancelled || isAbortError(uploadError);
    const conflict = fileNameConflictFromError(uploadError);
    const message = stopped
      ? "已停止"
      : conflict
        ? "磁力文件与目标目录已有文件重名，请换目录或先处理同名文件"
        : uploadError instanceof ApiError
          ? uploadError.message
          : uploadError instanceof Error
            ? uploadError.message
            : "磁力导入失败";
    ctx.setUrlUpload((current) => ({
      ...current,
      status: "error",
      message: conflict ? undefined : message,
      conflict,
      conflictAction: "error",
      progress: undefined
    }));
    if (conflict || !ctx.urlUploadRef.current.magnet?.import) {
      seedUploadRuntimeStore(ctx.urlRuntimeStore, null, null);
    }
    if (!stopped && ctx.urlUploadRef.current.magnet?.import) {
      ctx.persistMagnetUploadTask(
        ctx.urlUploadRef.current.magnet.import.id,
        ctx.urlUploadRef.current.magnet.selectedIndexes,
        ctx.urlUploadRef.current.magnet.uploads
      );
    }
    if (!stopped) {
      ctx.onError(message);
    }
  } finally {
    ctx.finishUploadTask(task);
    ctx.setSubmitting(false);
  }
}

export async function waitForMagnetStatus(
  ctx: UploadEngineContext,
  importId: string,
  task: UploadAbortContext,
  isDone: (current: MagnetImport) => boolean,
  label: string,
  options: {
    selectedCount?: number;
    syncUiState?: boolean;
  } = {}
): Promise<MagnetImport> {
  const deadline = Date.now() + MAGNET_DOWNLOAD_TIMEOUT_MS;
  let transientFailures = 0;

  while (true) {
    if (task.cancelled) {
      throw new Error("已停止");
    }

    let magnet: MagnetImport;
    try {
      const response = await runAbortableUploadRequest(task, URL_CHUNK_REQUEST_TIMEOUT_MS, (signal) =>
        getMagnetUploadStatus(importId, signal)
      );
      magnet = response.magnet;
      transientFailures = 0;
    } catch (error) {
      if (task.cancelled || !isRetryableMagnetStatusError(error)) {
        throw error;
      }

      transientFailures += 1;
      if (transientFailures > MAGNET_STATUS_MAX_TRANSIENT_FAILURES) {
        throw new Error(`${label}状态确认失败：${errorMessage(error)}`);
      }

      const retryLabel = `${label}状态确认失败，自动重试 ${transientFailures}/${MAGNET_STATUS_MAX_TRANSIENT_FAILURES}：${errorMessage(error)}`;
      ctx.urlRuntimeStore.setState((current) => ({
        ...current,
        progress: current.progress
          ? { ...current.progress, label: retryLabel }
          : { completed: 0, total: 1, label: retryLabel }
      }));

      if (Date.now() >= deadline) {
        throw new Error(`${label}超时`);
      }

      await delay(MAGNET_STATUS_RETRY_DELAY_MS * transientFailures, task.abortController.signal);
      continue;
    }

    const progressLabel = magnetStatusProgressLabel(label, magnet, options.selectedCount);
    ctx.urlRuntimeStore.setState((current) => ({
      ...current,
      progress: current.progress
        ? { ...current.progress, label: progressLabel }
        : { completed: 0, total: 1, label: progressLabel }
    }));

    if (options.syncUiState !== false || isDone(magnet)) {
      ctx.setUrlUpload((current) => {
        const nextMagnet = current.magnet
          ? { ...current.magnet, import: magnet }
          : { import: magnet, selectedIndexes: selectedMagnetIndexesForResume(magnet, ctx.maxMultipartBytes) };

        if (current.magnet?.import && magnetImportStableUiKey(current.magnet.import) === magnetImportStableUiKey(magnet)) {
          return current;
        }

        return {
          ...current,
          magnet: mergeMagnetState(current.magnet, nextMagnet)
        };
      });
    }

    if (isDone(magnet)) {
      return magnet;
    }

    if (Date.now() >= deadline) {
      throw new Error(`${label}超时`);
    }

    await delay(MAGNET_STATUS_POLL_MS, task.abortController.signal);
  }
}
