import { formatCompactBytes } from "../../../utils";
import { makePersistedTaskId, type PersistedUploadTask } from "../../../lib/upload-tasks";
import type {
  ChunkProgress,
  ItemStatus,
  QueueItem,
  QueuedUrlUploadTask,
  UploadMode,
  UploadRuntimeState,
  UploadTaskSnapshot,
  UploadTaskSnapshotItem,
  UrlUploadState
} from "./types";
import { effectiveDirectoryPath, effectiveFileName } from "./filename-conflict";

export function createUploadTaskSnapshot(params: {
  mode: UploadMode;
  items: QueueItem[];
  localRuntime: Map<string, UploadRuntimeState>;
  urlUpload: UrlUploadState;
  urlRuntime: UploadRuntimeState;
  queuedUrlTasks: QueuedUrlUploadTask[];
  sourceUrl: string;
  uploadDirectoryPath: string;
  activeUploadKind: "local" | "url" | null;
  activeUploadItemId: string | null;
  activePersistedTaskId: string | null;
  stopRequested: boolean;
  running: boolean;
  persistedTasks: PersistedUploadTask[];
}): UploadTaskSnapshot | null {
  const activeItemId = params.activeUploadKind === "url" ? "url" : params.activeUploadItemId;
  const localItems: UploadTaskSnapshotItem[] = params.items.map((item) => {
    const runtime = params.localRuntime.get(item.id);
    const progress = runtime?.progress ?? item.progress;
    const progressPercent = uploadTaskProgressPercent(item.status, progress);
    return {
      id: item.id,
      kind: "local",
      title: effectiveFileName(item),
      description: item.relativePath
        ? `${effectiveDirectoryPath(item, params.uploadDirectoryPath)} · ${formatCompactBytes(item.file.size)}`
        : `${params.uploadDirectoryPath} · ${formatCompactBytes(item.file.size)}`,
      status: item.status,
      progressPercent,
      progressLabel: progress?.label ?? item.message,
      canStop: params.activeUploadKind === "local" && params.activeUploadItemId === item.id && !params.stopRequested,
      canDelete: !(params.activeUploadKind === "local" && params.activeUploadItemId === item.id)
    };
  });

  const hasUrlTask = Boolean(
    params.sourceUrl ||
    params.urlUpload.status !== "pending" ||
    params.urlRuntime.progress ||
    params.urlUpload.progress ||
    params.urlUpload.retry ||
    params.urlUpload.hls?.retry ||
    params.urlUpload.magnet?.import
  );
  const urlItems: UploadTaskSnapshotItem[] = hasUrlTask
    ? [{
        id: "url",
        kind: "url",
        title: params.sourceUrl ? remoteFileLabel(params.sourceUrl) : "远程上传任务",
        description: params.sourceUrl || undefined,
        status: params.urlUpload.status,
        progressPercent: uploadTaskProgressPercent(params.urlUpload.status, params.urlRuntime.progress ?? params.urlUpload.progress),
        progressLabel: params.urlRuntime.progress?.label ?? params.urlUpload.progress?.label ?? params.urlUpload.message,
        canStop: params.activeUploadKind === "url" && !params.stopRequested,
        canDelete: params.activeUploadKind !== "url"
      }]
    : [];

  const queuedUrlItems = params.queuedUrlTasks.map(queuedUrlTaskSnapshotItem);

  const visiblePersistedIds = currentVisiblePersistedTaskIds(params.items, params.urlUpload, params.activePersistedTaskId);
  const persistedItems = params.persistedTasks
    .filter((task) => !visiblePersistedIds.has(task.id))
    .map(persistedTaskSnapshotItem);

  const taskItems = [...localItems, ...urlItems, ...queuedUrlItems, ...persistedItems].filter((item) =>
    item.status !== "pending" || item.progressLabel || item.kind === params.mode
  );
  if (taskItems.length === 0) return null;

  const summary = taskItems.reduce<UploadTaskSnapshot["summary"]>(
    (current, item) => {
      current.total += 1;
      current[item.status] += 1;
      return current;
    },
    { total: 0, pending: 0, uploading: 0, done: 0, error: 0, skipped: 0 }
  );

  return {
    items: taskItems,
    running: params.running,
    stopRequested: params.stopRequested,
    activeItemId,
    summary
  };
}

export function uploadTaskSnapshotKey(snapshot: UploadTaskSnapshot | null): string {
  if (!snapshot) {
    return "empty";
  }

  return JSON.stringify({
    running: snapshot.running,
    stopRequested: snapshot.stopRequested,
    activeItemId: snapshot.activeItemId,
    summary: snapshot.summary,
    items: snapshot.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description,
      status: item.status,
      progressPercent: item.progressPercent,
      progressLabel: item.progressLabel,
      canStop: item.canStop,
      canDelete: item.canDelete
    }))
  });
}

export function uploadTaskSnapshotStructureKey(snapshot: UploadTaskSnapshot | null): string {
  if (!snapshot) {
    return "empty";
  }

  return JSON.stringify({
    running: snapshot.running,
    stopRequested: snapshot.stopRequested,
    activeItemId: snapshot.activeItemId,
    summary: snapshot.summary,
    items: snapshot.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      canStop: item.canStop,
      canDelete: item.canDelete
    }))
  });
}

export function queuedUrlTaskSnapshotItem(task: QueuedUrlUploadTask): UploadTaskSnapshotItem {
  return {
    id: task.id,
    kind: "url",
    title: remoteFileLabel(task.sourceUrl),
    description: `${task.directoryPath} · ${task.sourceUrl}`,
    status: "pending",
    progressPercent: 0,
    progressLabel: "等待上传",
    canStop: false,
    canDelete: true
  };
}

export function uploadTaskProgressPercent(status: ItemStatus, progress?: ChunkProgress): number {
  if (progress?.total) {
    return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));
  }
  if (status === "done") return 100;
  return 0;
}

export function persistedTaskSnapshotItem(task: PersistedUploadTask): UploadTaskSnapshotItem {
  const status = persistedTaskStatusToItemStatus(task.status);
  const progress = persistedTaskProgress(task);
  return {
    id: task.id,
    kind: task.kind === "local" ? "local" : "url",
    title: persistedTaskTitle(task),
    description: persistedTaskDescription(task),
    status,
    progressPercent: progress.percent,
    progressLabel: progress.label,
    canStop: false,
    canDelete: true
  };
}

export function currentVisiblePersistedTaskIds(
  items: QueueItem[],
  urlUpload: UrlUploadState,
  activePersistedTaskId: string | null
): Set<string> {
  const ids = new Set<string>();
  if (activePersistedTaskId) {
    ids.add(activePersistedTaskId);
  }
  for (const item of items) {
    if (item.retry?.kind === "local") {
      ids.add(makePersistedTaskId("local", item.retry.uploadId));
    }
  }
  if (urlUpload.retry?.kind === "url") {
    ids.add(makePersistedTaskId("url-multipart", urlUpload.retry.uploadId));
  }
  const hlsAssetId = urlUpload.hls?.retry?.assetId ?? urlUpload.hls?.assetId;
  if (hlsAssetId) {
    ids.add(makePersistedTaskId("hls", hlsAssetId));
  }
  if (urlUpload.magnet?.import) {
    ids.add(makePersistedTaskId("magnet", urlUpload.magnet.import.id));
  }
  return ids;
}

export function persistedTaskStatusToItemStatus(status: PersistedUploadTask["status"]): ItemStatus {
  switch (status) {
    case "running":
      return "pending";
    case "done":
      return "done";
    case "cancelled":
      return "skipped";
    case "failed":
    case "waiting-file":
      return "error";
    default:
      return "pending";
  }
}

export function persistedTaskTitle(task: PersistedUploadTask): string {
  switch (task.kind) {
    case "local":
      return task.fileName;
    case "hls":
      return task.retry.fileName;
    case "magnet":
      return remoteFileLabel(task.sourceUrl);
    case "url-multipart":
      return task.fileNameOverride || remoteFileLabel(task.sourceUrl);
  }
}

export function persistedTaskDescription(task: PersistedUploadTask): string {
  switch (task.kind) {
    case "local":
      return `${task.directoryPath} · ${formatCompactBytes(task.size)}`;
    case "hls":
      return `${task.directoryPath} · HLS · ${task.retry.segmentCount} 个片段`;
    case "magnet":
      return `${task.directoryPath} · 磁力任务 · ${task.selectedIndexes.length} 个文件`;
    case "url-multipart":
      return `${task.directoryPath} · ${formatCompactBytes(task.retry.size)}`;
  }
}

export function persistedTaskProgress(task: PersistedUploadTask): { percent: number; label: string } {
  if (task.kind === "hls") {
    const total = Math.max(1, task.retry.segmentCount);
    return {
      percent: Math.round((task.retry.completedSegments.length / total) * 100),
      label: task.status === "waiting-file" ? "等待操作" : `已完成 ${task.retry.completedSegments.length}/${total} 个片段`
    };
  }

  if (task.kind === "magnet") {
    return {
      percent: task.status === "done" ? 100 : 0,
      label: task.status === "queued" ? "等待恢复磁力任务" : "磁力任务待处理"
    };
  }

  const total = Math.max(1, task.retry.chunkCount);
  return {
    percent: Math.round((task.retry.completedChunks.length / total) * 100),
    label: task.kind === "local" && task.status === "waiting-file"
      ? "等待重新选择本地文件"
      : `已完成 ${task.retry.completedChunks.length}/${total} 个分片`
  };
}

export function remoteFileLabel(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : url.hostname;
  } catch {
    return "远程文件";
  }
}
