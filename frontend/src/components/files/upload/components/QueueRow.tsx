import { memo, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { FileTypeIcon } from "../../../ui/FileTypeIcon";
import { formatBytes } from "../../../../utils";
import { chunkProgressEqual } from "../equality";
import { CompactConflictActions, conflictTitle } from "./ConflictControls";
import { EditableFileName } from "./EditableFileName";
import { ProgressBar, StatusBadge } from "./ProgressIndicators";
import { ThumbnailPicker, UploadThumbnailVisual, thumbnailHint } from "./ThumbnailPicker";
import { UploadChunkPanel } from "./UploadChunks";
import type {
  ChunkProgress,
  QueueItem,
  UploadChunkState,
  UploadRuntimeStore
} from "../types";

interface QueueRowProps {
  item: QueueItem;
  runtimeStore: UploadRuntimeStore;
  targetDirectoryPath: string;
  onRemove: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onSkipConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailUrl: () => void;
  onThumbnailRemove: () => void;
  onToggleChunks: () => void;
  disabled: boolean;
}

export const QueueRow = memo(function QueueRow({
  item,
  runtimeStore,
  targetDirectoryPath,
  onRemove,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict,
  onSkipConflict,
  onThumbnailChange,
  onThumbnailUrl,
  onThumbnailRemove,
  onToggleChunks,
  disabled
}: QueueRowProps) {
  const status = item.status;
  const fileName = item.fileNameOverride ?? item.file.name;
  return (
    <div className="[contain:layout_paint] flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="self-center">
          <UploadThumbnailVisual
            thumbnail={item.thumbnail}
            fallback={<FileTypeIcon mimeType={item.file.type || "application/octet-stream"} fileName={item.file.name} size="sm" />}
          />
        </span>
        <div className="min-w-0 flex-1">
          <EditableFileName
            value={fileName}
            originalValue={item.file.name}
            editing={Boolean(item.editingFileName)}
            conflict={item.conflict}
            disabled={disabled || status === "uploading" || status === "done" || status === "skipped"}
            onChange={onFileNameChange}
            onEditingChange={onFileNameEditingChange}
          />
          <p className="truncate text-xs text-muted">
            {formatBytes(item.file.size)} · 上传到 {targetDirectoryPath} · 分片上传
            {item.conflict ? <span className="text-warning"> · 目标已有同名文件</span> : null}
            {!item.conflict && item.conflictAction === "overwrite" ? <span className="text-warning"> · 将覆盖同名文件</span> : null}
            {thumbnailHint(item.thumbnail) ? <span> · {thumbnailHint(item.thumbnail)}</span> : null}
            {item.message ? <span className={status === "error" ? "text-danger" : "text-muted"}> · {item.message}</span> : null}
          </p>
          {item.relativePath ? (
            <p className="truncate text-[11px] text-subtle" title={item.relativePath}>
              本地路径：{item.relativePath}
            </p>
          ) : null}
          <LocalUploadRuntimeDetails
            runtimeStore={runtimeStore}
            fallbackProgress={item.progress}
            fallbackChunks={item.chunks}
            expanded={Boolean(item.chunksExpanded)}
            onToggleChunks={onToggleChunks}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5 self-center">
          <QueueStateBadge item={item} multipart={Boolean(item.progress || item.chunks)} />
          <CompactConflictActions
            conflict={item.conflict}
            disabled={disabled}
            onRename={onRenameConflict}
            onOverwrite={onOverwriteConflict}
            onSkip={onSkipConflict}
          />
          <ThumbnailPicker
            disabled={disabled || status === "uploading"}
            onChange={onThumbnailChange}
            onUrl={onThumbnailUrl}
            onRemove={onThumbnailRemove}
            hasThumbnail={item.thumbnail?.status === "ready"}
          />
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={disabled}
              className="h-6 shrink-0 rounded-md border border-primary/30 px-2 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
            >
              {item.retry?.failedChunks.length === 0 ? "继续完成上传" : "重试失败分片"}
            </button>
          ) : null}
          {onStop && status === "uploading" ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="h-6 shrink-0 rounded-md border border-danger/30 px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-40"
            >
              {stopping ? "正在停止" : "停止上传"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="移除"
            onClick={onRemove}
            disabled={disabled || status === "uploading"}
            className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          >
            {status === "done" ? <CheckCircle2 size={13} className="text-success" /> : <X size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}, queueRowPropsEqual);

const LocalUploadRuntimeDetails = memo(function LocalUploadRuntimeDetails({
  runtimeStore,
  fallbackProgress,
  fallbackChunks,
  expanded,
  onToggleChunks
}: {
  runtimeStore: UploadRuntimeStore;
  fallbackProgress?: ChunkProgress;
  fallbackChunks?: UploadChunkState[];
  expanded: boolean;
  onToggleChunks: () => void;
}) {
  const runtime = useSyncExternalStore(
    runtimeStore.subscribe,
    runtimeStore.getSnapshot,
    runtimeStore.getSnapshot
  );
  const progress = runtime.progress ?? fallbackProgress;
  const chunks = runtime.chunks ?? fallbackChunks;

  return (
    <>
      {progress ? <ProgressBar progress={progress} /> : null}
      {chunks ? (
        <div className="mt-2">
          <UploadChunkPanel chunks={chunks} expanded={expanded} onToggle={onToggleChunks} />
        </div>
      ) : null}
    </>
  );
}, (previous, next) =>
  previous.runtimeStore === next.runtimeStore &&
  chunkProgressEqual(previous.fallbackProgress, next.fallbackProgress) &&
  previous.fallbackChunks === next.fallbackChunks &&
  previous.expanded === next.expanded
);

function QueueStateBadge({ item, multipart }: { item: QueueItem; multipart?: boolean }) {
  if (item.conflict) {
    return (
      <span
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-warning-soft px-1.5 text-[11px] font-medium text-warning"
        title={conflictTitle(item.conflict)}
      >
        <AlertTriangle size={11} />
        冲突
      </span>
    );
  }

  if (item.conflictAction === "overwrite") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-warning-soft px-1.5 text-[11px] font-medium text-warning">
        将覆盖
      </span>
    );
  }

  if (item.fileNameOverride && item.status !== "done" && item.status !== "uploading") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-primary-soft px-1.5 text-[11px] font-medium text-primary-strong">
        已改名
      </span>
    );
  }

  return <StatusBadge status={item.status} multipart={multipart} />;
}

function queueRowPropsEqual(previous: QueueRowProps, next: QueueRowProps): boolean {
  return previous.item === next.item &&
    previous.runtimeStore === next.runtimeStore &&
    previous.targetDirectoryPath === next.targetDirectoryPath &&
    previous.disabled === next.disabled &&
    previous.stopping === next.stopping &&
    Boolean(previous.onRetry) === Boolean(next.onRetry) &&
    Boolean(previous.onStop) === Boolean(next.onStop) &&
    Boolean(previous.onRenameConflict) === Boolean(next.onRenameConflict) &&
    Boolean(previous.onOverwriteConflict) === Boolean(next.onOverwriteConflict) &&
    Boolean(previous.onSkipConflict) === Boolean(next.onSkipConflict);
}
