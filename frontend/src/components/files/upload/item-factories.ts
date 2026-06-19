import { type SourceRequestHeaders } from "../../../api";
import { type PersistedLocalUploadTask } from "../../../lib/upload-tasks";
import { canAutoGenerateThumbnail } from "../../../lib/thumbnail";
import type { QueueItem, QueuedUrlUploadTask, SourceHeaderRow } from "./types";
import { createUploadRuntimeStore, seedUploadRuntimeStore } from "./runtime-store";
import { normalizeRelativePath, relativeDirectoryPathFor } from "./dropped-files";
import { normalizeHeaderKeyInput } from "./curl-headers";
import { retryFailureProgress } from "./chunk-math";

let counter = 0;

export function makeItem(file: File, options: { relativePath?: string } = {}): QueueItem {
  counter += 1;
  const relativePath = normalizeRelativePath(options.relativePath);
  const relativeDirectoryPath = relativeDirectoryPathFor(relativePath);

  return {
    id: `${Date.now()}-${counter}`,
    file,
    runtimeStore: createUploadRuntimeStore(),
    ...(relativePath ? { relativePath } : {}),
    ...(relativeDirectoryPath ? { relativeDirectoryPath } : {}),
    status: "pending",
    thumbnail: canAutoGenerateThumbnail(file) ? { status: "idle" } : undefined
  };
}

export function makeSourceHeaderRow(name = "", value = ""): SourceHeaderRow {
  counter += 1;
  return {
    id: `source-header-${Date.now()}-${counter}`,
    name: normalizeHeaderKeyInput(name),
    value
  };
}

export function makeQueuedUrlUploadTask(sourceUrl: string, directoryPath: string, remark: string): QueuedUrlUploadTask {
  counter += 1;
  return {
    id: `queued-url-${Date.now()}-${counter}`,
    sourceUrl,
    directoryPath,
    remark
  };
}

export function isLocalItemAwaitingDecision(item: QueueItem): boolean {
  return item.status === "pending" || item.status === "error";
}

export function isUploadableLocalItem(item: QueueItem): boolean {
  return isLocalItemAwaitingDecision(item) && !item.conflict;
}

export function sourceHeaderRowsFromHeaders(headers?: SourceRequestHeaders): SourceHeaderRow[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => makeSourceHeaderRow(name, value));
}

export function extractFirstUrl(value: string): string | undefined {
  const match = value.match(/(?:https?:\/\/|magnet:\?)[^\s<>"']+/i);
  return match?.[0];
}

export function makePlaceholderLocalItem(task: PersistedLocalUploadTask): QueueItem {
  const file = new File([], task.fileName, {
    type: task.mimeType || "application/octet-stream",
    lastModified: task.lastModified
  });
  const item = makeItem(file, { relativePath: task.relativePath });
  const retryProgress = retryFailureProgress(task.retry, "等待重新选择本地文件");
  seedUploadRuntimeStore(item.runtimeStore!, retryProgress);
  return {
    ...item,
    status: "error",
    message: `刷新后需要重新选择同一个文件：${task.fileName}`,
    retry: task.retry,
    progress: retryProgress,
    thumbnail: undefined,
    recoveredLocalPlaceholder: true
  };
}
