import type { FileItem } from "../api";

export const DEFAULT_ACCELERATED_DOWNLOAD_CONCURRENCY = 5;
const PROGRESS_REPORT_MIN_INTERVAL_MS = 200;

type WritableData = BufferSource | Blob | string;

export interface NativeFileWritableStream {
  write(data: WritableData | { type: "write"; position?: number; data: WritableData }): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface NativeFileHandle {
  createWritable(): Promise<NativeFileWritableStream>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<NativeFileHandle>;
}

export interface AcceleratedDownloadProgress {
  chunkIndex: number;
  downloadedBytes: number;
  totalBytes: number;
}

export interface MultipartDownloadFile extends FileItem {
  storage_backend: "telegram_multipart";
  chunk_size: number;
  chunk_count: number;
}

export interface AcceleratedDownloadOptions {
  file: MultipartDownloadFile;
  token: string;
  chunkIndex: number;
  signal: AbortSignal;
  onProgress?: (progress: AcceleratedDownloadProgress) => void;
}

export function canUseAcceleratedDownload(file: FileItem): file is MultipartDownloadFile {
  return file.storage_backend === "telegram_multipart" &&
    Number.isSafeInteger(file.chunk_size) &&
    Number(file.chunk_size) > 0 &&
    Number.isSafeInteger(file.chunk_count) &&
    Number(file.chunk_count) > 0;
}

export function supportsNativeFileSave(): boolean {
  return typeof window !== "undefined" &&
    typeof (window as SaveFilePickerWindow).showSaveFilePicker === "function";
}

export async function createWritableFile(suggestedName: string): Promise<NativeFileWritableStream> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) {
    throw new Error("当前浏览器不支持选择本地保存位置");
  }

  const handle = await picker({ suggestedName });
  return handle.createWritable();
}

export function extractSignedFileToken(filePathOrUrl: string): string | null {
  const baseUrl = typeof window === "undefined" ? "https://local.invalid" : window.location.origin;

  try {
    const pathname = new URL(filePathOrUrl, baseUrl).pathname;
    const match = /^\/f\/([^/]+)(?:\/|$)/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError";
}

export async function downloadMultipartChunk({
  file,
  token,
  chunkIndex,
  signal,
  onProgress
}: AcceleratedDownloadOptions): Promise<ArrayBuffer> {
  const response = await fetch(`/f/${encodeURIComponent(token)}/chunks/${chunkIndex}`, {
    signal,
    credentials: "omit"
  });

  if (!response.ok) {
    throw new Error(await readChunkErrorMessage(response, chunkIndex));
  }

  const expectedSize = expectedMultipartChunkSize(file, chunkIndex);
  onProgress?.({ chunkIndex, downloadedBytes: 0, totalBytes: expectedSize });

  if (!response.body) {
    const bytes = await response.arrayBuffer();
    validateChunkSize(bytes.byteLength, expectedSize, chunkIndex);
    onProgress?.({ chunkIndex, downloadedBytes: bytes.byteLength, totalBytes: expectedSize });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloadedBytes = 0;
  let lastReportedAt = Date.now();

  function reportProgress(force = false) {
    if (!onProgress) {
      return;
    }

    const now = Date.now();
    const elapsedSinceLastReport = now - lastReportedAt;

    if (
      !force &&
      downloadedBytes !== expectedSize &&
      elapsedSinceLastReport < PROGRESS_REPORT_MIN_INTERVAL_MS
    ) {
      return;
    }

    lastReportedAt = now;
    onProgress({ chunkIndex, downloadedBytes, totalBytes: expectedSize });
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    chunks.push(value);
    downloadedBytes += value.byteLength;
    reportProgress();
  }

  reportProgress(true);
  validateChunkSize(downloadedBytes, expectedSize, chunkIndex);
  return concatChunks(chunks, downloadedBytes);
}

export function expectedMultipartChunkSize(file: MultipartDownloadFile, chunkIndex: number): number {
  return chunkIndex === file.chunk_count - 1
    ? file.size - file.chunk_size * chunkIndex
    : file.chunk_size;
}

async function readChunkErrorMessage(response: Response, chunkIndex: number): Promise<string> {
  const prefix = `分片 ${chunkIndex + 1} 下载失败（HTTP ${response.status}）`;
  const contentType = response.headers.get("Content-Type") || "";

  if (!contentType.includes("application/json")) {
    return response.statusText ? `${prefix}：${response.statusText}` : prefix;
  }

  try {
    const body = await response.json() as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return `${prefix}：${body.message}`;
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return `${prefix}：${body.error}`;
    }
  } catch {
    // 忽略错误体解析失败，保留 HTTP 状态即可。
  }

  return prefix;
}

function validateChunkSize(actualSize: number, expectedSize: number, chunkIndex: number): void {
  if (actualSize !== expectedSize) {
    throw new Error(
      `分片 ${chunkIndex + 1} 大小不匹配：期望 ${expectedSize} 字节，实际 ${actualSize} 字节`
    );
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): ArrayBuffer {
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}
