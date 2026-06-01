import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardPaste, FilePlus2, Layers3, Link2, Trash2, UploadCloud, X } from "lucide-react";
import {
  ApiError,
  completeMultipartUpload,
  initMultipartUpload,
  initUrlMultipartUpload,
  uploadFile,
  uploadFileFromUrl,
  uploadMultipartChunk,
  uploadUrlMultipartChunk
} from "../../api";
import { formatBytes, formatCompactBytes } from "../../utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Textarea";
import { Spinner } from "../ui/Spinner";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { Segmented } from "../ui/Segmented";
import { Input } from "../ui/Input";
import { cn } from "../../lib/cn";

interface UploadDialogProps {
  open: boolean;
  initialFiles: File[];
  maxBytes: number;
  multipartChunkBytes: number;
  maxMultipartBytes: number;
  directoryPath: string;
  onClose: () => void;
  onUploaded: (uploadedCount: number) => void;
  onError: (message: string) => void;
}

type ItemStatus = "pending" | "uploading" | "done" | "error" | "skipped";
type UploadMode = "file" | "url";
type UploadChunkStatus = "queued" | "uploading" | "completed" | "failed";

interface ChunkProgress {
  completed: number;
  total: number;
  label: string;
  failed?: number;
}

interface UploadChunkState {
  index: number;
  size: number;
  status: UploadChunkStatus;
  attempts: number;
  errorMessage?: string;
}

interface MultipartRetryState {
  kind: "local" | "url";
  uploadId: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  directAccess: boolean;
  completedChunks: number[];
  failedChunks: number[];
}

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  chunks?: UploadChunkState[];
  retry?: MultipartRetryState;
}

interface UrlUploadState {
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  chunks?: UploadChunkState[];
  retry?: MultipartRetryState;
}

interface ChunkQueueResult {
  completedChunks: number[];
  failedChunks: number[];
}

let counter = 0;
const MULTIPART_UPLOAD_CONCURRENCY = 3;
const MULTIPART_UPLOAD_MAX_ATTEMPTS = 3;
const MULTIPART_UPLOAD_RETRY_DELAY_MS = 800;

class MultipartChunkUploadError extends Error {
  constructor(
    message: string,
    public readonly retry: MultipartRetryState
  ) {
    super(message);
    this.name = "MultipartChunkUploadError";
  }
}

function makeItem(file: File): QueueItem {
  counter += 1;
  return { id: `${Date.now()}-${counter}`, file, status: "pending" };
}

export function UploadDialog({
  open,
  initialFiles,
  maxBytes,
  multipartChunkBytes,
  maxMultipartBytes,
  directoryPath,
  onClose,
  onUploaded,
  onError
}: UploadDialogProps) {
  const [mode, setMode] = useState<UploadMode>("file");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [urlUpload, setUrlUpload] = useState<UrlUploadState>({ status: "pending" });
  const [remark, setRemark] = useState("");
  const [forceMultipart, setForceMultipart] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setMode("file");
      setItems([]);
      setSourceUrl("");
      setUrlUpload({ status: "pending" });
      setRemark("");
      setForceMultipart(false);
      setSubmitting(false);
      setDragOver(false);
      return;
    }
    setMode("file");
    setItems(initialFiles.map(makeItem));
    setSourceUrl("");
    setUrlUpload({ status: "pending" });
    setForceMultipart(false);
  }, [open, initialFiles]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setMode("file");
    setItems((current) => [...current, ...files.map(makeItem)]);
  }, []);

  const handlePick = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    addFiles(Array.from(list));
    event.target.value = "";
  };

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const filePendingCount = items.filter((item) => item.status === "pending" || item.status === "error").length;
  const normalizedSourceUrl = sourceUrl.trim();
  const urlPendingCount = normalizedSourceUrl && urlUpload.status !== "uploading" && urlUpload.status !== "done" ? 1 : 0;
  const pendingCount = mode === "url" ? urlPendingCount : filePendingCount;
  const hasDone = urlUpload.status === "done" || items.some((item) => item.status === "done");

  function handleModeChange(nextMode: UploadMode) {
    if (submitting || mode === nextMode) return;
    setMode(nextMode);
  }

  function handleSourceUrlChange(value: string) {
    setSourceUrl(value);
    setUrlUpload({ status: "pending" });
  }

  function extractFirstUrl(value: string): string | undefined {
    const match = value.match(/https?:\/\/[^\s<>"']+/i);
    return match?.[0];
  }

  function validateSourceUrl(value: string): string | undefined {
    const normalized = value.trim();

    if (!normalized) {
      return "请粘贴要上传的 URL";
    }

    try {
      const url = new URL(normalized);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "仅支持 http/https URL";
      }
    } catch {
      return "请输入完整的 URL，例如 https://example.com/file.pdf";
    }

    return undefined;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (mode === "url") {
      await submitUrlUpload();
      return;
    }
    if (items.length === 0) {
      onError("请选择要上传的文件");
      return;
    }
    const targets = items.filter((item) => item.status === "pending" || item.status === "error");
    if (targets.length === 0) {
      onClose();
      return;
    }

    setSubmitting(true);
    let successCount = 0;

    for (const target of targets) {
      if (target.file.size > maxMultipartBytes) {
        const message = `文件大小不能超过 ${formatCompactBytes(maxMultipartBytes)}（当前 ${formatCompactBytes(target.file.size)}）`;
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? { ...item, status: "error", message }
              : item
          )
        );
        onError(message);
        continue;
      }

      setItems((current) =>
        current.map((item) =>
          item.id === target.id ? { ...item, status: "uploading", message: undefined, progress: undefined } : item
        )
      );

      try {
        if (forceMultipart || target.file.size > maxBytes) {
          await uploadLocalMultipart(target);
        } else {
          const form = new FormData();
          form.set("file", target.file);
          form.set("directory_path", directoryPath);
          if (remark.trim()) form.set("remark", remark.trim());
          await uploadFile(form);
        }
        successCount += 1;
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? { ...item, status: "done", message: undefined, progress: undefined, retry: undefined }
              : item
          )
        );
      } catch (error) {
        const retry = error instanceof MultipartChunkUploadError ? error.retry : undefined;
        const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "上传失败";
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: "error",
                  message,
                  retry,
                  progress: retry ? retryFailureProgress(retry, "分片上传失败，可手动重试") : undefined
                }
              : item
          )
        );
        onError(message);
      }
    }

    setSubmitting(false);
    if (successCount > 0) {
      onUploaded(successCount);
    }
  }

  async function uploadLocalMultipart(target: QueueItem) {
    if (target.retry?.kind === "local") {
      await retryLocalMultipart(target, target.retry);
      return;
    }

    const init = await initMultipartUpload({
      file_name: target.file.name,
      mime_type: target.file.type || "application/octet-stream",
      size: target.file.size,
      directory_path: directoryPath,
      ...(remark.trim() ? { remark: remark.trim() } : {})
    });
    const upload = init.upload;

    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? { ...item, chunks: createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count) }
          : item
      )
    );

    const result = await runConcurrentChunks({
      total: upload.chunk_count,
      taskLabel: "上传分片",
      doneLabel: "已上传",
      onProgress: (progress) => updateItemProgress(target.id, progress),
      onChunkState: (index, patch) => updateItemChunk(target.id, index, patch),
      onChunk: async (index) => {
        const start = index * upload.chunk_size;
        const end = Math.min(target.file.size, start + upload.chunk_size);
        await uploadMultipartChunk(upload.id, index, target.file.slice(start, end));
      }
    });

    if (result.failedChunks.length > 0) {
      throw new MultipartChunkUploadError(
        `有 ${result.failedChunks.length} 个分片上传失败，可手动重试`,
        {
          kind: "local",
          uploadId: upload.id,
          size: upload.size,
          chunkSize: upload.chunk_size,
          chunkCount: upload.chunk_count,
          directAccess: upload.direct_access !== false,
          completedChunks: result.completedChunks,
          failedChunks: result.failedChunks
        }
      );
    }

    updateItemProgress(target.id, {
      completed: upload.chunk_count,
      total: upload.chunk_count,
      label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
    });
    await completeMultipartUpload(upload.id);
  }

  async function retryLocalMultipart(target: QueueItem, retry: MultipartRetryState) {
    setItems((current) =>
      current.map((item) =>
        item.id === target.id
          ? { ...item, chunks: prepareRetryChunks(item.chunks, retry) }
          : item
      )
    );

    const result = await runConcurrentChunks({
      total: retry.chunkCount,
      chunkIndexes: retry.failedChunks,
      completedChunks: retry.completedChunks,
      taskLabel: "重试上传分片",
      doneLabel: "已上传",
      onProgress: (progress) => updateItemProgress(target.id, progress),
      onChunkState: (index, patch) => updateItemChunk(target.id, index, patch),
      onChunk: async (index) => {
        const start = index * retry.chunkSize;
        const end = Math.min(target.file.size, start + retry.chunkSize);
        await uploadMultipartChunk(retry.uploadId, index, target.file.slice(start, end));
      }
    });

    if (result.failedChunks.length > 0) {
      throw new MultipartChunkUploadError(
        `仍有 ${result.failedChunks.length} 个分片上传失败，可继续手动重试`,
        {
          ...retry,
          completedChunks: result.completedChunks,
          failedChunks: result.failedChunks
        }
      );
    }

    updateItemProgress(target.id, {
      completed: retry.chunkCount,
      total: retry.chunkCount,
      label: retry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
    });
    await completeMultipartUpload(retry.uploadId);
  }

  async function runConcurrentChunks(params: {
    total: number;
    chunkIndexes?: number[];
    completedChunks?: number[];
    taskLabel: string;
    doneLabel: string;
    onChunk: (index: number) => Promise<void>;
    onProgress: (progress: ChunkProgress) => void;
    onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void;
  }): Promise<ChunkQueueResult> {
    const chunkIndexes = params.chunkIndexes ?? chunkRange(params.total);
    const completedSet = new Set(params.completedChunks ?? []);
    const failedChunks: number[] = [];
    const concurrency = Math.min(MULTIPART_UPLOAD_CONCURRENCY, Math.max(1, chunkIndexes.length));
    let nextIndex = 0;

    const suffix = concurrency > 1 ? `（${concurrency} 并发）` : "";
    params.onProgress({
      completed: completedSet.size,
      total: params.total,
      label: `${params.taskLabel} ${completedSet.size}/${params.total}${suffix}`
    });

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const queueIndex = nextIndex;
        nextIndex += 1;

        if (queueIndex >= chunkIndexes.length) {
          break;
        }

        const index = chunkIndexes[queueIndex];

        try {
          await uploadChunkWithRetry({
            ...params,
            index,
            suffix,
            completed: () => completedSet.size
          });
          completedSet.add(index);
        } catch (error) {
          failedChunks.push(index);
        }

        params.onProgress({
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

    return {
      completedChunks: Array.from(completedSet).sort((left, right) => left - right),
      failedChunks: Array.from(new Set(failedChunks)).sort((left, right) => left - right)
    };
  }

  async function uploadChunkWithRetry(params: {
    index: number;
    total: number;
    taskLabel: string;
    onChunk: (index: number) => Promise<void>;
    onProgress: (progress: ChunkProgress) => void;
    onChunkState?: (index: number, patch: Partial<UploadChunkState>) => void;
    suffix: string;
    completed: () => number;
  }) {
    for (let attempt = 1; attempt <= MULTIPART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
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
        await params.onChunk(params.index);
        params.onChunkState?.(params.index, {
          status: "completed",
          attempts: attempt,
          errorMessage: undefined
        });
        return;
      } catch (error) {
        const canRetry = attempt < MULTIPART_UPLOAD_MAX_ATTEMPTS && isRetryableChunkUploadError(error);
        if (!canRetry) {
          params.onChunkState?.(params.index, {
            status: "failed",
            attempts: attempt,
            errorMessage: errorMessage(error)
          });
          throw new Error(`分片 ${params.index + 1} 处理失败：${errorMessage(error)}`);
        }

        await delay(retryDelayMs(attempt));
      }
    }
  }

  function updateItemProgress(id: string, progress: ChunkProgress) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, progress } : item)));
  }

  function updateItemChunk(id: string, chunkIndex: number, patch: Partial<UploadChunkState>) {
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              chunks: updateChunkStates(item.chunks, chunkIndex, patch)
            }
          : item
      )
    );
  }

  function updateUrlChunk(chunkIndex: number, patch: Partial<UploadChunkState>) {
    setUrlUpload((current) => ({
      ...current,
      chunks: updateChunkStates(current.chunks, chunkIndex, patch)
    }));
  }

  async function submitUrlUpload() {
    if (urlUpload.retry?.kind === "url") {
      await retryUrlMultipart(urlUpload.retry);
      return;
    }

    const error = validateSourceUrl(sourceUrl);
    if (error) {
      setUrlUpload({ status: "error", message: error });
      onError(error);
      return;
    }

    setSubmitting(true);
    setUrlUpload({ status: "uploading", progress: { completed: 0, total: 1, label: "探测远程文件" } });

    try {
      const init = await initUrlMultipartUpload(normalizedSourceUrl, remark.trim() || undefined, directoryPath, forceMultipart);
      if (init.mode === "multipart" && init.upload) {
        const upload = init.upload;
        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          chunks: createUploadChunkStates(upload.size, upload.chunk_size, upload.chunk_count)
        }));
        const result = await runConcurrentChunks({
          total: upload.chunk_count,
          taskLabel: "导入分片",
          doneLabel: "已导入",
          onProgress: (progress) => {
            setUrlUpload((current) => ({
              ...current,
              status: "uploading",
              progress
            }));
          },
          onChunkState: updateUrlChunk,
          onChunk: async (index) => {
            await uploadUrlMultipartChunk(upload.id, index);
          }
        });

        if (result.failedChunks.length > 0) {
          throw new MultipartChunkUploadError(
            `有 ${result.failedChunks.length} 个分片导入失败，可手动重试`,
            {
              kind: "url",
              uploadId: upload.id,
              size: upload.size,
              chunkSize: upload.chunk_size,
              chunkCount: upload.chunk_count,
              directAccess: upload.direct_access !== false,
              completedChunks: result.completedChunks,
              failedChunks: result.failedChunks
            }
          );
        }

        setUrlUpload((current) => ({
          ...current,
          status: "uploading",
          progress: {
            completed: upload.chunk_count,
            total: upload.chunk_count,
            label: upload.direct_access === false ? "正在生成文件索引" : "正在生成访问链接"
          }
        }));
        await completeMultipartUpload(upload.id);
      } else {
        setUrlUpload({ status: "uploading", progress: { completed: 0, total: 1, label: "拉取远程文件" } });
        await uploadFileFromUrl(normalizedSourceUrl, remark.trim() || undefined, directoryPath);
      }
      setUrlUpload((current) => ({ ...current, status: "done", message: "已从 URL 上传", progress: undefined, retry: undefined }));
      onUploaded(1);
    } catch (uploadError) {
      const retry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : undefined;
      const message = uploadError instanceof ApiError
        ? uploadError.message
        : uploadError instanceof Error
          ? uploadError.message
          : "URL 上传失败";
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message,
        retry,
        progress: retry ? retryFailureProgress(retry, "分片导入失败，可手动重试") : undefined
      }));
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retryUrlMultipart(retry: MultipartRetryState) {
    setSubmitting(true);
    setUrlUpload((current) => ({
      ...current,
      status: "uploading",
      progress: retryFailureProgress(retry, "准备重试失败分片"),
      chunks: prepareRetryChunks(current.chunks, retry),
      retry
    }));

    try {
      const result = await runConcurrentChunks({
        total: retry.chunkCount,
        chunkIndexes: retry.failedChunks,
        completedChunks: retry.completedChunks,
        taskLabel: "重试导入分片",
        doneLabel: "已导入",
        onProgress: (progress) => {
          setUrlUpload((current) => ({
            ...current,
            status: "uploading",
            progress,
            retry
          }));
        },
        onChunkState: updateUrlChunk,
        onChunk: async (index) => {
          await uploadUrlMultipartChunk(retry.uploadId, index);
        }
      });

      if (result.failedChunks.length > 0) {
        throw new MultipartChunkUploadError(
          `仍有 ${result.failedChunks.length} 个分片导入失败，可继续手动重试`,
          {
            ...retry,
            completedChunks: result.completedChunks,
            failedChunks: result.failedChunks
          }
        );
      }

      setUrlUpload((current) => ({
        ...current,
        status: "uploading",
        progress: {
          completed: retry.chunkCount,
          total: retry.chunkCount,
          label: retry.directAccess === false ? "正在生成文件索引" : "正在生成访问链接"
        }
      }));
      await completeMultipartUpload(retry.uploadId);
      setUrlUpload((current) => ({ ...current, status: "done", message: "已从 URL 上传", progress: undefined, retry: undefined }));
      onUploaded(1);
    } catch (uploadError) {
      const nextRetry = uploadError instanceof MultipartChunkUploadError ? uploadError.retry : retry;
      const message = uploadError instanceof Error ? uploadError.message : "URL 分片重试失败";
      setUrlUpload((current) => ({
        ...current,
        status: "error",
        message,
        retry: nextRetry,
        progress: retryFailureProgress(nextRetry, "分片导入失败，可手动重试")
      }));
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retryItemFailedChunks(id: string) {
    if (submitting) return;

    const target = items.find((item) => item.id === id);
    if (!target?.retry || target.retry.kind !== "local") {
      return;
    }

    setSubmitting(true);
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? { ...item, status: "uploading", message: undefined, progress: retryFailureProgress(target.retry!, "准备重试失败分片") }
          : item
      )
    );

    try {
      await retryLocalMultipart(target, target.retry);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: "done", message: undefined, progress: undefined, retry: undefined } : item
        )
      );
      onUploaded(1);
    } catch (error) {
      const retry = error instanceof MultipartChunkUploadError ? error.retry : target.retry;
      const message = error instanceof Error ? error.message : "分片重试失败";
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "error",
                message,
                retry,
                progress: retryFailureProgress(retry, "分片上传失败，可手动重试")
              }
            : item
        )
      );
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleDropFiles(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    addFiles(files);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="上传文件"
      description={`上传到 ${directoryPath}；单文件 ${formatBytes(maxBytes)} 内直传，大文件分片上限 ${formatBytes(maxMultipartBytes)}，最多 ${MULTIPART_UPLOAD_CONCURRENCY} 分片并发，每片最多 ${MULTIPART_UPLOAD_MAX_ATTEMPTS} 次尝试`}
      size="lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            {hasDone ? "关闭" : "取消"}
          </Button>
          <Button
            type="submit"
            form="upload-form"
            variant="primary"
            loading={submitting}
            leadingIcon={mode === "url" ? <Link2 size={16} /> : <FilePlus2 size={16} />}
            disabled={pendingCount === 0}
          >
            {submitting
              ? mode === "url" ? "导入中" : "上传中"
              : pendingCount > 0
                ? mode === "url" ? "上传 URL" : `开始上传 ${pendingCount} 个`
                : "无待传文件"}
          </Button>
        </>
      }
    >
      <form id="upload-form" className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex items-center justify-between gap-3">
          <Segmented<UploadMode>
            value={mode}
            onChange={handleModeChange}
            ariaLabel="上传方式"
            options={[
              { value: "file", label: "本地文件", icon: <UploadCloud size={15} /> },
              { value: "url", label: "URL 链接", icon: <Link2 size={15} /> }
            ]}
          />
          <span className="hidden text-xs text-muted sm:inline">分片上限 {formatBytes(maxMultipartBytes)}</span>
        </div>
        <label className="flex items-start gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground">
          <input
            type="checkbox"
            checked={forceMultipart}
            disabled={submitting}
            onChange={(event) => setForceMultipart(event.target.checked)}
            className="mt-0.5 size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">小文件也使用分片上传</span>
            <span className="text-xs leading-5 text-muted">
              开启后本地文件和 URL 导入都会走分片流程；分片最多 {MULTIPART_UPLOAD_CONCURRENCY} 个并发，每片失败自动重试，URL 分片要求远端支持 Range。
            </span>
          </span>
        </label>

        {mode === "file" ? (
          <>
            <label
              onDragEnter={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDropFiles}
              className={cn(
                "relative grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed bg-background px-6 py-8 text-center transition-colors duration-150",
                dragOver
                  ? "border-primary bg-primary-soft text-primary-strong"
                  : "border-border hover:border-primary/60 hover:bg-primary-soft/40"
              )}
            >
              <span className="grid size-12 place-items-center rounded-2xl bg-primary-soft text-primary-strong">
                <UploadCloud size={22} />
              </span>
              <p className="text-sm font-medium text-foreground">点击选择文件，或拖拽到这里</p>
              <p className="text-xs text-muted">
                {formatBytes(maxBytes)} 内直传；超过后按 {formatBytes(multipartChunkBytes)} 分片，最多 {MULTIPART_UPLOAD_CONCURRENCY} 并发，每片最多 {MULTIPART_UPLOAD_MAX_ATTEMPTS} 次
              </p>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={handlePick}
              />
            </label>

            {items.length > 0 ? (
              <div className="flex max-h-[32rem] flex-col gap-2 overflow-auto scroll-thin">
                {items.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    directMaxBytes={maxBytes}
                    forceMultipart={forceMultipart}
                    onRemove={() => removeItem(item.id)}
                    onRetry={item.retry ? () => void retryItemFailedChunks(item.id) : undefined}
                    disabled={submitting}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="upload-source-url" className="text-xs font-medium text-muted">
                粘贴文件 URL
              </label>
              <Input
                id="upload-source-url"
                type="url"
                placeholder="https://example.com/report.pdf"
                value={sourceUrl}
                disabled={submitting}
                invalid={urlUpload.status === "error"}
                leadingIcon={<ClipboardPaste size={15} />}
                onChange={(event) => handleSourceUrlChange(event.target.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  const pastedUrl = extractFirstUrl(pasted);
                  if (pastedUrl) {
                    event.preventDefault();
                    handleSourceUrlChange(pastedUrl);
                  }
                }}
              />
              <p className="text-xs leading-5 text-muted">
                {forceMultipart ? "当前将强制使用分片导入；" : `小文件直接拉取；超过 ${formatBytes(maxBytes)} 时`}
                要求远端支持 Range，并按
                {" "}{formatBytes(multipartChunkBytes)} 分片导入，最多 {MULTIPART_UPLOAD_CONCURRENCY} 并发，每片最多 {MULTIPART_UPLOAD_MAX_ATTEMPTS} 次。
              </p>
            </div>

            {normalizedSourceUrl ? (
              <UrlUploadRow
                url={normalizedSourceUrl}
                status={urlUpload.status}
                message={urlUpload.message}
                progress={urlUpload.progress}
                chunks={urlUpload.chunks}
                onClear={() => handleSourceUrlChange("")}
                onRetry={urlUpload.retry ? () => void retryUrlMultipart(urlUpload.retry!) : undefined}
                disabled={submitting}
              />
            ) : null}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="upload-remark" className="text-xs font-medium text-muted">
            备注（可选 · 应用于本次所有文件）
          </label>
          <Textarea
            id="upload-remark"
            placeholder="补充说明，便于后续检索"
            value={remark}
            maxLength={1000}
            onChange={(event) => setRemark(event.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}

function isRetryableChunkUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }

  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "上传失败";
}

function retryDelayMs(failedAttempt: number): number {
  return MULTIPART_UPLOAD_RETRY_DELAY_MS * failedAttempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function chunkRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function retryFailureProgress(retry: MultipartRetryState, label: string): ChunkProgress {
  return {
    completed: retry.completedChunks.length,
    total: retry.chunkCount,
    failed: retry.failedChunks.length,
    label: `${label}（失败 ${retry.failedChunks.length} 个）`
  };
}

function createUploadChunkStates(size: number, chunkSize: number, chunkCount: number): UploadChunkState[] {
  return Array.from({ length: chunkCount }, (_, index) => ({
    index,
    size: expectedUploadChunkSize(size, chunkSize, chunkCount, index),
    status: "queued",
    attempts: 0
  }));
}

function prepareRetryChunks(chunks: UploadChunkState[] | undefined, retry: MultipartRetryState): UploadChunkState[] {
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

function updateChunkStates(
  chunks: UploadChunkState[] | undefined,
  chunkIndex: number,
  patch: Partial<UploadChunkState>
): UploadChunkState[] | undefined {
  if (!chunks) {
    return chunks;
  }

  return chunks.map((chunk) => (chunk.index === chunkIndex ? { ...chunk, ...patch } : chunk));
}

function expectedUploadChunkSize(size: number, chunkSize: number, chunkCount: number, chunkIndex: number): number {
  return chunkIndex === chunkCount - 1 ? size - chunkSize * chunkIndex : chunkSize;
}

interface QueueRowProps {
  item: QueueItem;
  directMaxBytes: number;
  forceMultipart: boolean;
  onRemove: () => void;
  onRetry?: () => void;
  disabled: boolean;
}

function QueueRow({ item, directMaxBytes, forceMultipart, onRemove, onRetry, disabled }: QueueRowProps) {
  const status = item.status;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <FileTypeIcon mimeType={item.file.type || "application/octet-stream"} fileName={item.file.name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={item.file.name}>
            {item.file.name}
          </p>
          <p className="truncate text-xs text-muted">
            {formatBytes(item.file.size)}
            {forceMultipart || item.file.size > directMaxBytes ? <span> · 分片上传</span> : null}
            {item.message ? <span className="text-danger"> · {item.message}</span> : null}
          </p>
          {item.progress ? <ProgressBar progress={item.progress} /> : null}
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="shrink-0 rounded-md border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
          >
            重试失败分片
          </button>
        ) : null}
        <StatusBadge status={status} multipart={Boolean(item.progress)} />
        <button
          type="button"
          aria-label="移除"
          onClick={onRemove}
          disabled={disabled || status === "uploading"}
          className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {status === "done" ? <CheckCircle2 size={14} className="text-success" /> : <X size={14} />}
        </button>
      </div>
      {item.chunks ? <UploadChunkList chunks={item.chunks} /> : null}
    </div>
  );
}

interface UrlUploadRowProps {
  url: string;
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  onClear: () => void;
  chunks?: UploadChunkState[];
  onRetry?: () => void;
  disabled: boolean;
}

function UrlUploadRow({ url, status, message, progress, chunks, onClear, onRetry, disabled }: UrlUploadRowProps) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
          <Link2 size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={url}>
            {remoteFileLabel(url)}
          </p>
          <p className="truncate text-xs text-muted">
            {url}
            {message ? <span className={status === "error" ? "text-danger" : "text-success"}> · {message}</span> : null}
          </p>
          {progress ? <ProgressBar progress={progress} /> : null}
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="shrink-0 rounded-md border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
          >
            重试失败分片
          </button>
        ) : null}
        <StatusBadge status={status} multipart={Boolean(progress)} />
        <button
          type="button"
          aria-label="清空 URL"
          onClick={onClear}
          disabled={disabled || status === "uploading"}
          className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {status === "done" ? <CheckCircle2 size={14} className="text-success" /> : <X size={14} />}
        </button>
      </div>
      {chunks ? <UploadChunkList chunks={chunks} /> : null}
    </div>
  );
}

function UploadChunkList({ chunks }: { chunks: UploadChunkState[] }) {
  const completed = chunks.filter((chunk) => chunk.status === "completed").length;
  const failed = chunks.filter((chunk) => chunk.status === "failed").length;
  const uploading = chunks.filter((chunk) => chunk.status === "uploading").length;

  return (
    <div className="rounded-lg border border-border bg-background/70 p-2">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>
          分片明细：{completed}/{chunks.length} 完成
          {uploading > 0 ? ` · ${uploading} 上传中` : ""}
          {failed > 0 ? ` · ${failed} 失败` : ""}
        </span>
        <span>每片状态实时更新</span>
      </div>
      <div className="grid max-h-40 gap-1 overflow-auto pr-1 scroll-thin sm:grid-cols-2">
        {chunks.map((chunk) => (
          <div
            key={chunk.index}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
              chunk.status === "completed" && "border-success/25 bg-success-soft text-success",
              chunk.status === "failed" && "border-danger/25 bg-danger-soft text-danger",
              chunk.status === "uploading" && "border-primary/25 bg-primary-soft text-primary-strong",
              chunk.status === "queued" && "border-border bg-surface text-muted"
            )}
            title={chunk.errorMessage}
          >
            <ChunkStatusIcon status={chunk.status} />
            <span className="shrink-0 font-medium">#{chunk.index + 1}</span>
            <span className="min-w-0 flex-1 truncate">
              {chunkStatusLabel(chunk.status)}
              {chunk.attempts > 0 ? ` · 第 ${chunk.attempts} 次` : ""}
              {chunk.errorMessage ? ` · ${chunk.errorMessage}` : ""}
            </span>
            <span className="shrink-0 opacity-70">{formatBytes(chunk.size)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChunkStatusIcon({ status }: { status: UploadChunkStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={13} className="shrink-0" />;
    case "failed":
      return <Trash2 size={13} className="shrink-0" />;
    case "uploading":
      return <Spinner size={12} className="shrink-0" />;
    default:
      return <span className="size-2 shrink-0 rounded-full bg-current opacity-35" />;
  }
}

function chunkStatusLabel(status: UploadChunkStatus): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "uploading":
      return "上传中";
    default:
      return "等待中";
  }
}

function ProgressBar({ progress }: { progress: ChunkProgress }) {
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>{progress.label}</span>
        <span>{percent}%{progress.failed ? ` · 失败 ${progress.failed}` : ""}</span>
      </div>
    </div>
  );
}

function remoteFileLabel(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : url.hostname;
  } catch {
    return "远程文件";
  }
}

function StatusBadge({ status, multipart }: { status: ItemStatus; multipart?: boolean }) {
  switch (status) {
    case "uploading":
      return multipart ? <Layers3 size={15} className="text-primary-strong" /> : <Spinner size={14} className="text-primary-strong" />;
    case "done":
      return <CheckCircle2 size={16} className="text-success" />;
    case "error":
      return <Trash2 size={14} className="text-danger" />;
    case "skipped":
      return <span className="text-xs text-muted">跳过</span>;
    default:
      return <span className="text-xs text-muted">待上传</span>;
  }
}
