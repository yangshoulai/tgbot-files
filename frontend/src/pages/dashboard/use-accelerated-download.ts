import { useRef, useState } from "react";
import {
  ApiError,
  FileItem,
  HlsDownloadPart,
  SessionResponse,
  getHlsDownloadPlan
} from "../../api";
import {
  buildFileCacheMetadata,
  buildFileCacheUrl
} from "../../lib/file-cache";
import { useToast } from "../../lib/toast";
import {
  type AcceleratedChunkState,
  type AcceleratedDownloadState
} from "../../components/files/AcceleratedDownloadDialog";
import {
  type MultipartDownloadFile,
  type NativeFileWritableStream,
  canUseAcceleratedDownload,
  createWritableFile,
  downloadAcceleratedPart,
  downloadMultipartChunk,
  extractSignedFileToken,
  expectedMultipartChunkSize,
  isAbortError,
  supportsNativeFileSave
} from "../../lib/accelerated-download";
import { canUseHlsAcceleratedDownload, hasFileLinkAccess, type LinkAccessibleFile } from "../../lib/file-access";
import { isVideoPreviewServiceWorkerControlling } from "../../lib/video-preview-service-worker";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

interface AcceleratedDownloadPartTask {
  index: number;
  size: number;
  offset: number;
  download: (
    signal: AbortSignal,
    onProgress: (downloadedBytes: number) => void
  ) => Promise<ArrayBuffer>;
}

interface HlsAcceleratedDownloadContext {
  fileId: string;
  fileName: string;
  directoryPath: string;
  mimeType: string;
  totalSize: number;
  chunkCount: number;
}

interface AcceleratedDownloadTask {
  fileId: string;
  fileName: string;
  writable: NativeFileWritableStream;
  concurrency: number;
  parts: AcceleratedDownloadPartTask[];
  queue: number[];
  running: Set<number>;
  completed: Set<number>;
  failed: Set<number>;
  controllers: Map<number, AbortController>;
  writeChain: Promise<void>;
  cancelled: boolean;
  finalized: boolean;
}

interface UseAcceleratedDownloadOptions {
  session: SessionResponse;
  toast: ReturnType<typeof useToast>;
}

export function useAcceleratedDownload({ session, toast }: UseAcceleratedDownloadOptions) {
  const acceleratedDownloadTaskRef = useRef<AcceleratedDownloadTask | null>(null);
  const [acceleratedDownload, setAcceleratedDownload] = useState<AcceleratedDownloadState | null>(null);

  async function onAcceleratedDownload(file: FileItem) {
    if (acceleratedDownloadTaskRef.current) {
      toast.info("已有加速下载任务进行中，请先完成或取消当前任务");
      return;
    }

    const isMultipart = canUseAcceleratedDownload(file);
    const isHls = canUseHlsAcceleratedDownload(file);
    const isHlsPackage = file.storage_backend === "hls_package";
    const linkFile = hasFileLinkAccess(file) ? file : null;

    if (isHlsPackage && !isHls) {
      toast.info("该 HLS 文件暂不支持加速下载");
      return;
    }

    if (!isMultipart && !isHls && !linkFile) {
      toast.info("该文件暂无可下载链接");
      return;
    }

    if (!supportsNativeFileSave()) {
      toast.info("当前浏览器不支持加速下载，请使用支持本地文件保存的浏览器");
      return;
    }

    let fileName = file.file_name;
    let totalBytes = file.size;
    let parts: AcceleratedDownloadPartTask[];
    const downloadConcurrency = session.upload_concurrency;

    try {
      if (isMultipart) {
        const token = extractSignedFileToken(file.file_path) || (linkFile ? extractSignedFileToken(linkFile.url) : null);
        if (!token) {
          if (!linkFile) {
            toast.info("无法解析分片下载 token，且该文件暂无可下载链接");
            return;
          }
          parts = createSingleFileAcceleratedParts(linkFile);
        } else {
          parts = createMultipartAcceleratedParts(file, token);
        }
      } else if (isHls) {
        const plan = (await getHlsDownloadPlan(file.id)).hls_download;
        fileName = plan.file_name;
        totalBytes = plan.total_size;
        parts = createHlsAcceleratedParts(plan.parts, {
          fileId: file.id,
          fileName: file.file_name,
          directoryPath: file.directory_path || "/",
          mimeType: file.mime_type || "application/vnd.apple.mpegurl",
          totalSize: plan.total_size,
          chunkCount: plan.part_count
        });
      } else {
        if (!linkFile) {
          toast.info("该文件暂无可下载链接");
          return;
        }
        parts = createSingleFileAcceleratedParts(linkFile);
      }
    } catch (error) {
      toast.danger(errorMessage(error));
      return;
    }

    setAcceleratedDownload({
      fileId: file.id,
      fileName,
      status: "preparing",
      concurrency: downloadConcurrency,
      totalBytes,
      chunks: createInitialAcceleratedChunks(parts)
    });

    let writable: Awaited<ReturnType<typeof createWritableFile>>;
    try {
      writable = await createWritableFile(fileName);
    } catch (error) {
      setAcceleratedDownload(null);
      if (!isAbortError(error)) {
        toast.danger(errorMessage(error));
      }
      return;
    }

    const task: AcceleratedDownloadTask = {
      fileId: file.id,
      fileName,
      writable,
      concurrency: downloadConcurrency,
      parts,
      queue: parts.map((part) => part.index),
      running: new Set(),
      completed: new Set(),
      failed: new Set(),
      controllers: new Map(),
      writeChain: Promise.resolve(),
      cancelled: false,
      finalized: false
    };

    acceleratedDownloadTaskRef.current = task;
    setAcceleratedDownload((current) =>
      current?.fileId === task.fileId
        ? { ...current, status: "downloading" }
        : current
    );
    startAcceleratedQueuedChunks(task);
  }

  function startAcceleratedQueuedChunks(task: AcceleratedDownloadTask) {
    if (task.cancelled || task.finalized) {
      return;
    }

    while (task.running.size < task.concurrency && task.queue.length > 0) {
      const chunkIndex = task.queue.shift();
      if (chunkIndex === undefined || task.running.has(chunkIndex) || task.completed.has(chunkIndex)) {
        continue;
      }

      task.failed.delete(chunkIndex);
      task.running.add(chunkIndex);
      void runAcceleratedChunk(task, chunkIndex);
    }

    updateAcceleratedOverallStatus(task);
  }

  async function runAcceleratedChunk(task: AcceleratedDownloadTask, chunkIndex: number) {
    const part = task.parts[chunkIndex];
    if (!part) {
      task.failed.add(chunkIndex);
      updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
        ...chunk,
        status: "failed",
        errorMessage: "下载 part 不存在"
      }));
      return;
    }

    const controller = new AbortController();
    task.controllers.set(chunkIndex, controller);
    updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
      ...chunk,
      status: "downloading",
      downloadedBytes: 0,
      attempts: chunk.attempts + 1,
      errorMessage: undefined
    }));

    try {
      const bytes = await part.download(controller.signal, (downloadedBytes) => {
        updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) =>
          chunk.downloadedBytes === downloadedBytes
            ? chunk
            : {
                ...chunk,
                downloadedBytes
              }
        );
      });

      if (task.cancelled) {
        return;
      }

      await writeAcceleratedChunk(task, chunkIndex, bytes);

      if (task.cancelled) {
        return;
      }

      task.failed.delete(chunkIndex);
      task.completed.add(chunkIndex);
      updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
        ...chunk,
        status: "completed",
        downloadedBytes: chunk.size,
        errorMessage: undefined
      }));
      await finalizeAcceleratedDownloadIfReady(task);
    } catch (error) {
      if (!task.cancelled) {
        task.failed.add(chunkIndex);
        updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
          ...chunk,
          status: "failed",
          errorMessage: errorMessage(error)
        }));
      }
    } finally {
      task.controllers.delete(chunkIndex);
      task.running.delete(chunkIndex);
      if (!task.cancelled && !task.finalized) {
        startAcceleratedQueuedChunks(task);
      }
    }
  }

  function writeAcceleratedChunk(
    task: AcceleratedDownloadTask,
    chunkIndex: number,
    bytes: ArrayBuffer
  ): Promise<void> {
    const part = task.parts[chunkIndex];
    if (!part) {
      return Promise.reject(new Error("下载 part 不存在"));
    }

    const writeOperation = task.writeChain.then(() =>
      task.writable.write({
        type: "write",
        position: part.offset,
        data: bytes
      })
    );

    task.writeChain = writeOperation.catch(() => undefined);
    return writeOperation;
  }

  async function finalizeAcceleratedDownloadIfReady(task: AcceleratedDownloadTask) {
    if (task.finalized || task.cancelled || task.completed.size !== task.parts.length) {
      return;
    }

    task.finalized = true;
    setAcceleratedDownload((current) =>
      current?.fileId === task.fileId ? { ...current, status: "finalizing" } : current
    );

    try {
      await task.writeChain;
      await task.writable.close();
      if (acceleratedDownloadTaskRef.current === task) {
        acceleratedDownloadTaskRef.current = null;
      }
      setAcceleratedDownload((current) =>
        current?.fileId === task.fileId ? { ...current, status: "completed" } : current
      );
      toast.success("加速下载完成");
    } catch (error) {
      if (acceleratedDownloadTaskRef.current === task) {
        acceleratedDownloadTaskRef.current = null;
      }
      setAcceleratedDownload((current) =>
        current?.fileId === task.fileId
          ? {
              ...current,
              status: "error",
              errorMessage: errorMessage(error)
            }
          : current
      );
      toast.danger(errorMessage(error));
    }
  }

  function retryAcceleratedChunk(chunkIndex: number) {
    const task = acceleratedDownloadTaskRef.current;
    if (!task || task.cancelled || task.finalized || task.running.has(chunkIndex) || task.completed.has(chunkIndex)) {
      return;
    }

    task.failed.delete(chunkIndex);
    if (!task.queue.includes(chunkIndex)) {
      task.queue.unshift(chunkIndex);
    }
    updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
      ...chunk,
      status: "queued",
      downloadedBytes: 0,
      errorMessage: undefined
    }));
    startAcceleratedQueuedChunks(task);
  }

  function retryFailedAcceleratedChunks() {
    const task = acceleratedDownloadTaskRef.current;
    if (!task || task.cancelled || task.finalized) {
      return;
    }

    const failedChunks = Array.from(task.failed).sort((left, right) => left - right);
    if (failedChunks.length === 0) {
      return;
    }

    for (const chunkIndex of failedChunks) {
      if (task.running.has(chunkIndex) || task.completed.has(chunkIndex) || task.queue.includes(chunkIndex)) {
        continue;
      }
      task.queue.push(chunkIndex);
      updateAcceleratedChunk(task.fileId, chunkIndex, (chunk) => ({
        ...chunk,
        status: "queued",
        downloadedBytes: 0,
        errorMessage: undefined
      }));
    }
    task.failed.clear();
    startAcceleratedQueuedChunks(task);
  }

  function cancelAcceleratedDownload() {
    const task = acceleratedDownloadTaskRef.current;
    if (!task) {
      setAcceleratedDownload((current) =>
        current && current.status === "preparing" ? { ...current, status: "cancelled" } : current
      );
      return;
    }

    task.cancelled = true;
    task.queue = [];
    for (const controller of task.controllers.values()) {
      controller.abort();
    }
    task.controllers.clear();
    task.running.clear();
    acceleratedDownloadTaskRef.current = null;
    void task.writeChain
      .catch(() => undefined)
      .finally(async () => {
        try {
          await task.writable.abort?.("cancelled");
        } catch {
          // 忽略取消写入时的浏览器实现差异。
        }
      });
    setAcceleratedDownload((current) =>
      current?.fileId === task.fileId ? { ...current, status: "cancelled" } : current
    );
    toast.info("下载已取消");
  }

  function updateAcceleratedChunk(
    fileId: string,
    chunkIndex: number,
    updater: (chunk: AcceleratedChunkState) => AcceleratedChunkState
  ) {
    setAcceleratedDownload((current) => {
      if (!current || current.fileId !== fileId) {
        return current;
      }

      let changed = false;
      const chunks = current.chunks.map((chunk) => {
        if (chunk.index !== chunkIndex) {
          return chunk;
        }

        const nextChunk = updater(chunk);
        if (nextChunk !== chunk) {
          changed = true;
        }
        return nextChunk;
      });

      return changed ? { ...current, chunks } : current;
    });
  }

  function updateAcceleratedOverallStatus(task: AcceleratedDownloadTask) {
    setAcceleratedDownload((current) => {
      if (!current || current.fileId !== task.fileId || task.finalized || task.cancelled) {
        return current;
      }

      const nextStatus = task.running.size > 0 || task.queue.length > 0
        ? "downloading"
        : task.failed.size > 0
          ? "partial_failed"
          : current.status;

      if (nextStatus !== current.status) {
        return { ...current, status: nextStatus };
      }

      return current;
    });
  }

  function createMultipartAcceleratedParts(file: MultipartDownloadFile, token: string): AcceleratedDownloadPartTask[] {
    return Array.from({ length: file.chunk_count }, (_, index) => ({
      index,
      size: expectedMultipartChunkSize(file, index),
      offset: index * file.chunk_size,
      download: (signal, onProgress) =>
        downloadMultipartChunk({
          file,
          token,
          chunkIndex: index,
          signal,
          onProgress: (progress) => onProgress(progress.downloadedBytes)
        })
    }));
  }

  function createSingleFileAcceleratedParts(file: LinkAccessibleFile): AcceleratedDownloadPartTask[] {
    const cacheUrl = isVideoPreviewServiceWorkerControlling()
      ? buildFileCacheUrl(buildFileCacheMetadata(file, session.video_preview_cache_bytes, "auto"))
      : null;

    return [{
      index: 0,
      size: file.size,
      offset: 0,
      download: (signal, onProgress) =>
        downloadAcceleratedPart({
          url: cacheUrl || file.url,
          expectedSize: file.size,
          label: "文件",
          signal,
          onProgress: (progress) => onProgress(progress.downloadedBytes)
        })
    }];
  }

  function createHlsAcceleratedParts(parts: HlsDownloadPart[], context: HlsAcceleratedDownloadContext): AcceleratedDownloadPartTask[] {
    const fullSegments = new Map<number, { offset: number; size: number; url: string }>();
    for (const part of parts) {
      if (part.kind === "segment" && part.segment_index !== null && part.chunk_index === null) {
        const path = sameOriginPath(part.url);
        if (path) {
          fullSegments.set(part.segment_index, {
            offset: part.offset,
            size: part.size,
            url: path
          });
        }
      }
    }

    return parts.map((part) => ({
      index: part.index,
      size: part.size,
      offset: part.offset,
      download: (signal, onProgress) =>
        downloadAcceleratedPart({
          url: hlsAcceleratedPartCacheUrl(part, context, fullSegments) || part.url,
          expectedSize: part.size,
          label: part.kind === "init" || part.segment_index === null
            ? "HLS 初始化片段"
            : part.chunk_index === null
              ? `HLS 片段 ${part.segment_index + 1}`
              : `HLS 片段 ${part.segment_index + 1} / 分片 ${part.chunk_index + 1}`,
          signal,
          headers: hlsAcceleratedPartCacheHeaders(part, fullSegments),
          onProgress: (progress) => onProgress(progress.downloadedBytes)
        })
    }));
  }

  function hlsAcceleratedPartCacheUrl(part: HlsDownloadPart, context: HlsAcceleratedDownloadContext, fullSegments: Map<number, { offset: number; size: number; url: string }>): string | null {
    if (!isVideoPreviewServiceWorkerControlling()) {
      return null;
    }

    const fullSegment = part.kind === "segment" && part.chunk_index !== null && part.segment_index !== null
      ? fullSegments.get(part.segment_index)
      : null;
    if (part.kind === "segment" && part.chunk_index !== null && !fullSegment) {
      return null;
    }

    const sourceUrl = sameOriginPath(part.url);
    if (!sourceUrl) {
      return null;
    }

    const partKind = part.kind === "init" || part.segment_index === null ? "init" : "segment";
    const partIndex = partKind === "init" ? 0 : part.segment_index;
    if (partIndex === null || !Number.isSafeInteger(partIndex) || partIndex < 0) {
      return null;
    }

    const params = new URLSearchParams({
      source: sourceUrl,
      cache_max: String(session.video_preview_cache_bytes),
      prefetch_concurrency: String(Math.max(1, Math.min(session.upload_concurrency, 32))),
      file_name: context.fileName,
      directory_path: context.directoryPath,
      mime: context.mimeType,
      size: String(context.totalSize),
      chunk_size: String(part.size),
      chunk_count: String(context.chunkCount),
      cache_source: "auto"
    });

    if (fullSegment) {
      params.set("full_source", fullSegment.url);
      params.set("full_size", String(fullSegment.size));
    }

    return `/__video-preview/hls-part/${encodeURIComponent(context.fileId)}/${partKind}/${partIndex}?${params.toString()}`;
  }

  function hlsAcceleratedPartCacheHeaders(part: HlsDownloadPart, fullSegments: Map<number, { offset: number; size: number; url: string }>): HeadersInit | undefined {
    const fullSegment = part.kind === "segment" && part.chunk_index !== null && part.segment_index !== null
      ? fullSegments.get(part.segment_index)
      : null;
    if (!fullSegment) {
      return undefined;
    }

    const start = part.offset - fullSegment.offset;
    return { Range: `bytes=${start}-${start + part.size - 1}` };
  }

  function sameOriginPath(url: string): string | null {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) {
        return null;
      }
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  function createInitialAcceleratedChunks(parts: AcceleratedDownloadPartTask[]): AcceleratedChunkState[] {
    return parts.map((part) => ({
      index: part.index,
      size: part.size,
      downloadedBytes: 0,
      status: "queued",
      attempts: 0
    }));
  }

  return {
    acceleratedDownload,
    setAcceleratedDownload,
    onAcceleratedDownload,
    retryAcceleratedChunk,
    retryFailedAcceleratedChunks,
    cancelAcceleratedDownload
  };
}
