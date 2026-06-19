import { ApiError } from "../../../api";
import { MULTIPART_UPLOAD_RETRY_DELAY_MS } from "./constants";
import type { UploadAbortContext } from "./types";

export function abortUploadTask(task: UploadAbortContext | null) {
  if (!task) {
    return;
  }

  task.cancelled = true;
  task.abortController.abort();
  for (const controller of task.controllers) {
    controller.abort();
  }
  task.controllers.clear();
}

export function isRetryableChunkUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }

  return error.status === 408 || error.status === 429 || error.status >= 500;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isRetryableMagnetStatusError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }

  if (error instanceof ApiError) {
    return error.status === 408 ||
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504;
  }

  return error instanceof Error;
}

export function errorMessage(error: unknown): string {
  if (isAbortError(error)) {
    return "请求已中止或超时";
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "上传失败";
}

export function retryDelayMs(failedAttempt: number, error: unknown): number {
  const retryAfterSeconds = error instanceof ApiError
    ? Number(error.details?.telegram_retry_after_seconds)
    : Number.NaN;

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5 * 60 * 1000);
  }

  return MULTIPART_UPLOAD_RETRY_DELAY_MS * failedAttempt;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
