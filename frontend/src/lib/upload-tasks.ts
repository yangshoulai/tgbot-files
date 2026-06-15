import type {
  HlsRetryState,
  MultipartRetryState,
  PersistedHlsUploadTask,
  PersistedLocalUploadTask,
  PersistedMagnetUploadTask,
  PersistedUploadTask,
  PersistedUrlMultipartUploadTask,
  UploadTaskQueue
} from "./upload-task-types";
import type { SourceRequestHeaders } from "../api";

export type {
  HlsRetryState,
  MagnetUploadEntry,
  MultipartRetryState,
  PersistedHlsUploadTask,
  PersistedLocalUploadTask,
  PersistedMagnetUploadTask,
  PersistedUploadTask,
  PersistedUrlMultipartUploadTask,
  UploadTaskQueue
} from "./upload-task-types";

type LegacyPersistedUploadTask =
  | Omit<PersistedLocalUploadTask, "id" | "status" | "updatedAt">
  | Omit<PersistedUrlMultipartUploadTask, "id" | "status" | "updatedAt">
  | Omit<PersistedHlsUploadTask, "id" | "status" | "updatedAt">
  | Omit<PersistedMagnetUploadTask, "id" | "status" | "updatedAt">;

export const UPLOAD_TASK_STORAGE_KEY = "tgbot-files:upload-task-queue:v1";
const LEGACY_UPLOAD_TASK_STORAGE_KEY = "tgbot-files:upload-task:v1";
const UPLOAD_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TASK_LOCK_KEY = "tgbot-files:upload-task-lock:v1";
const UPLOAD_TASK_LOCK_TTL_MS = 15_000;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token"
]);

export function makePersistedTaskId(kind: PersistedUploadTask["kind"], stableId: string): string {
  return `${kind}:${stableId}`;
}

export function readUploadTaskQueue(now = Date.now()): UploadTaskQueue {
  const migrated = readLegacyUploadTask();
  const rawQueue = readRawQueue();
  const tasks = rawQueue.tasks.filter((task) => !isExpiredTask(task, now));
  const merged = migrated && !tasks.some((task) => task.id === migrated.id) ? [...tasks, migrated] : tasks;
  const queue = { version: 1 as const, tasks: merged };
  if (merged.length !== rawQueue.tasks.length || migrated) {
    writeUploadTaskQueue(queue);
    removeLegacyUploadTask();
  }
  return queue;
}

export function writeUploadTaskQueue(queue: UploadTaskQueue): void {
  try {
    window.localStorage.setItem(UPLOAD_TASK_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // 当前上传不依赖持久化成功。
  }
}

export function upsertUploadTask(task: PersistedUploadTask): void {
  const queue = readUploadTaskQueue();
  const nextTask = { ...task, updatedAt: Date.now() } satisfies PersistedUploadTask;
  const exists = queue.tasks.some((item) => item.id === task.id);
  writeUploadTaskQueue({
    version: 1,
    tasks: exists
      ? queue.tasks.map((item) => (item.id === task.id ? nextTask : item))
      : [...queue.tasks, nextTask]
  });
}

export function removeUploadTask(id: string): void {
  const queue = readUploadTaskQueue();
  writeUploadTaskQueue({ version: 1, tasks: queue.tasks.filter((task) => task.id !== id) });
}

export function clearUploadTaskQueue(): void {
  writeUploadTaskQueue({ version: 1, tasks: [] });
}

export function firstResumableUploadTask(): PersistedUploadTask | null {
  const queue = readUploadTaskQueue();
  return queue.tasks.find((task) => task.status !== "done" && task.status !== "cancelled") ?? null;
}

export function sanitizeSourceHeadersForPersistence(headers?: SourceRequestHeaders): {
  headers?: SourceRequestHeaders;
  strippedHeaderNames?: string[];
} {
  if (!headers) return {};
  const safeHeaders: SourceRequestHeaders = {};
  const strippedHeaderNames: string[] = [];

  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      strippedHeaderNames.push(name);
      continue;
    }
    safeHeaders[name] = value;
  }

  return {
    ...(Object.keys(safeHeaders).length > 0 ? { headers: safeHeaders } : {}),
    ...(strippedHeaderNames.length > 0 ? { strippedHeaderNames } : {})
  };
}

export function acquireUploadTaskLock(ownerId: string, now = Date.now()): boolean {
  const current = readLock();
  if (current && current.expiresAt > now && current.ownerId !== ownerId) {
    return false;
  }
  writeLock({ ownerId, expiresAt: now + UPLOAD_TASK_LOCK_TTL_MS });
  return true;
}

export function renewUploadTaskLock(ownerId: string, now = Date.now()): boolean {
  const current = readLock();
  if (current && current.ownerId !== ownerId) {
    return false;
  }
  writeLock({ ownerId, expiresAt: now + UPLOAD_TASK_LOCK_TTL_MS });
  return true;
}

export function releaseUploadTaskLock(ownerId: string): void {
  const current = readLock();
  if (!current || current.ownerId !== ownerId) return;
  try {
    window.localStorage.removeItem(UPLOAD_TASK_LOCK_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function readRawQueue(): UploadTaskQueue {
  try {
    const raw = window.localStorage.getItem(UPLOAD_TASK_STORAGE_KEY);
    if (!raw) return { version: 1, tasks: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: 1, tasks: [] };
    const queue = parsed as Partial<UploadTaskQueue>;
    if (queue.version !== 1 || !Array.isArray(queue.tasks)) return { version: 1, tasks: [] };
    return { version: 1, tasks: queue.tasks.filter(isPersistedUploadTask) };
  } catch {
    return { version: 1, tasks: [] };
  }
}

function readLegacyUploadTask(): PersistedUploadTask | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_UPLOAD_TASK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isLegacyPersistedUploadTask(parsed)) return null;
    return {
      ...parsed,
      id: legacyTaskId(parsed),
      status: parsed.kind === "local" ? "waiting-file" : "queued",
      updatedAt: parsed.savedAt
    };
  } catch {
    return null;
  }
}

function removeLegacyUploadTask(): void {
  try {
    window.localStorage.removeItem(LEGACY_UPLOAD_TASK_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function isExpiredTask(task: PersistedUploadTask, now: number): boolean {
  return now - task.updatedAt > UPLOAD_TASK_TTL_MS;
}

function readLock(): { ownerId: string; expiresAt: number } | null {
  try {
    const raw = window.localStorage.getItem(UPLOAD_TASK_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ownerId?: unknown; expiresAt?: unknown };
    if (typeof parsed.ownerId !== "string" || typeof parsed.expiresAt !== "number") return null;
    return { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeLock(lock: { ownerId: string; expiresAt: number }): void {
  try {
    window.localStorage.setItem(UPLOAD_TASK_LOCK_KEY, JSON.stringify(lock));
  } catch {
    // Ignore storage failures.
  }
}

function isPersistedUploadTask(value: unknown): value is PersistedUploadTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<PersistedUploadTask>;
  if (
    task.version !== 1 ||
    typeof task.id !== "string" ||
    !isPersistedTaskStatus(task.status) ||
    typeof task.savedAt !== "number" ||
    typeof task.updatedAt !== "number" ||
    typeof task.directoryPath !== "string"
  ) {
    return false;
  }

  return isPersistedUploadTaskBody(task);
}

function isLegacyPersistedUploadTask(value: unknown): value is LegacyPersistedUploadTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<PersistedUploadTask>;
  return task.version === 1 &&
    typeof task.savedAt === "number" &&
    typeof task.directoryPath === "string" &&
    isPersistedUploadTaskBody(task);
}

function isPersistedUploadTaskBody(task: Partial<PersistedUploadTask>): boolean {
  switch (task.kind) {
    case "local":
      return typeof task.fileName === "string" && typeof task.size === "number" && isMultipartRetryState(task.retry);
    case "url-multipart":
      return typeof task.sourceUrl === "string" && isMultipartRetryState(task.retry);
    case "hls":
      return typeof task.sourceUrl === "string" && isHlsRetryState(task.retry);
    case "magnet":
      return typeof task.sourceUrl === "string" && typeof task.importId === "string" && Array.isArray(task.selectedIndexes);
    default:
      return false;
  }
}

function isPersistedTaskStatus(value: unknown): value is PersistedUploadTask["status"] {
  return value === "queued" ||
    value === "running" ||
    value === "waiting-file" ||
    value === "failed" ||
    value === "done" ||
    value === "cancelled";
}

function isMultipartRetryState(value: unknown): value is MultipartRetryState {
  if (!value || typeof value !== "object") return false;
  const retry = value as Partial<MultipartRetryState>;
  return (retry.kind === "local" || retry.kind === "url") &&
    typeof retry.uploadId === "string" &&
    typeof retry.size === "number" &&
    typeof retry.chunkSize === "number" &&
    typeof retry.chunkCount === "number" &&
    typeof retry.directAccess === "boolean" &&
    (retry.conflictAction === "error" || retry.conflictAction === "overwrite") &&
    Array.isArray(retry.completedChunks) &&
    Array.isArray(retry.failedChunks);
}

function isHlsRetryState(value: unknown): value is HlsRetryState {
  if (!value || typeof value !== "object") return false;
  const retry = value as Partial<HlsRetryState>;
  return typeof retry.assetId === "string" &&
    typeof retry.fileName === "string" &&
    typeof retry.segmentCount === "number" &&
    typeof retry.previewPlaylistUrl === "string" &&
    (retry.conflictAction === "error" || retry.conflictAction === "overwrite") &&
    Array.isArray(retry.completedSegments) &&
    Array.isArray(retry.failedSegments);
}

function legacyTaskId(task: LegacyPersistedUploadTask): string {
  switch (task.kind) {
    case "local":
      return makePersistedTaskId("local", task.retry.uploadId);
    case "url-multipart":
      return makePersistedTaskId("url-multipart", task.retry.uploadId);
    case "hls":
      return makePersistedTaskId("hls", task.retry.assetId);
    case "magnet":
      return makePersistedTaskId("magnet", task.importId);
  }
}
