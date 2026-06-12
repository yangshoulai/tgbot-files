import { memo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  XCircle
} from "lucide-react";
import { formatBytes } from "../../utils";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export type AcceleratedDownloadStatus =
  | "preparing"
  | "downloading"
  | "partial_failed"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "error";

export type AcceleratedChunkStatus = "queued" | "downloading" | "completed" | "failed";

export interface AcceleratedChunkState {
  index: number;
  size: number;
  downloadedBytes: number;
  status: AcceleratedChunkStatus;
  attempts: number;
  errorMessage?: string;
}

export interface AcceleratedDownloadState {
  fileId: string;
  fileName: string;
  status: AcceleratedDownloadStatus;
  concurrency: number;
  totalBytes: number;
  chunks: AcceleratedChunkState[];
  errorMessage?: string;
}

interface AcceleratedDownloadDialogProps {
  state: AcceleratedDownloadState | null;
  onCancel: () => void;
  onClose: () => void;
  onRetryChunk: (chunkIndex: number) => void;
  onRetryFailed: () => void;
}

export function AcceleratedDownloadDialog({
  state,
  onCancel,
  onClose,
  onRetryChunk,
  onRetryFailed
}: AcceleratedDownloadDialogProps) {
  if (!state) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const stats = summarizeChunks(state);
  const isOpenTask = state.status === "preparing" ||
    state.status === "downloading" ||
    state.status === "partial_failed" ||
    state.status === "finalizing";
  const canRetry = state.status === "partial_failed" && stats.failedChunks > 0;

  return (
    <Modal
      open
      onClose={isOpenTask ? onCancel : onClose}
      closeOnBackdrop={!isOpenTask}
      closeOnEscape={!isOpenTask}
      size="xl"
      title="加速下载"
      description="按 Telegram 既有分片并发下载；失败分片可单独重试，全部完成后写出最终文件。"
      footer={
        <>
          {isOpenTask ? (
            <Button variant="secondary" leadingIcon={<XCircle size={16} />} onClick={onCancel}>
              取消任务
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
          )}
          {canRetry ? (
            <Button variant="primary" leadingIcon={<RotateCcw size={16} />} onClick={onRetryFailed}>
              重试失败分片
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-background/70 p-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary-soft text-primary-strong">
            <StatusIcon status={state.status} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground" title={state.fileName}>
              {state.fileName}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">{statusText(state, stats)}</p>
          </div>
          <span className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary-strong">
            {stats.progress}%
          </span>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-3 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-foreground">整体下载进度</p>
            <p className="text-xs font-medium text-muted">
              {formatBytes(stats.outputBytes)} / {formatBytes(state.totalBytes)}
            </p>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-primary shadow-[0_0_18px_rgba(16,185,129,0.28)] transition-[width] duration-300"
              style={{ width: `${stats.progress}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted lg:grid-cols-4">
            <ProgressStat label="整体进度" value={`${stats.progress}%`} />
            <ProgressStat label="分片完成" value={`${stats.completedChunks} / ${state.chunks.length}`} />
            <ProgressStat label="当前并发" value={`${stats.activeChunks} / ${state.concurrency}`} />
            <ProgressStat label="失败分片" value={`${stats.failedChunks}`} tone={stats.failedChunks > 0 ? "danger" : "default"} />
          </div>
        </div>

        {state.errorMessage ? (
          <p className="rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-xs leading-5 text-danger">
            {state.errorMessage}
          </p>
        ) : null}

        <div className="rounded-2xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">分片状态</p>
              <p className="mt-0.5 text-xs text-muted">每个小方块代表一个 Telegram 分片</p>
            </div>
            <ChunkStatusLegend />
          </div>
          <ChunkStatusGrid
            chunks={state.chunks}
            totalChunks={state.chunks.length}
            onRetryChunk={onRetryChunk}
          />
          {stats.failedChunks > 0 ? (
            <p className="mt-3 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-xs leading-5 text-danger">
              红色分片下载异常，可点击红色小方块单独重试，或使用底部按钮批量重试失败分片。
            </p>
          ) : null}
        </div>

        <p className="rounded-xl border border-info/20 bg-info-soft px-3 py-2 text-xs leading-5 text-info">
          页面刷新或取消任务会丢弃未完成文件；单个分片重试会重新下载该 Telegram 分片并覆盖对应写入位置。
        </p>
      </div>
    </Modal>
  );
}

const MemoizedChunkTile = memo(
  ChunkTile,
  (previous, next) => previous.chunk === next.chunk && previous.totalChunks === next.totalChunks
);

function ChunkStatusGrid({
  chunks,
  totalChunks,
  onRetryChunk
}: {
  chunks: AcceleratedChunkState[];
  totalChunks: number;
  onRetryChunk: (chunkIndex: number) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-border bg-background/70 p-3">
      <div className="flex flex-wrap gap-1.5">
        {chunks.map((chunk) => (
          <MemoizedChunkTile
            key={chunk.index}
            chunk={chunk}
            totalChunks={totalChunks}
            onRetry={() => onRetryChunk(chunk.index)}
          />
        ))}
      </div>
    </div>
  );
}

function ChunkTile({
  chunk,
  totalChunks,
  onRetry
}: {
  chunk: AcceleratedChunkState;
  totalChunks: number;
  onRetry: () => void;
}) {
  const canRetry = chunk.status === "failed";
  const label = `分片 ${chunk.index + 1} / ${totalChunks}：${chunkStatusText(chunk.status)}，${formatBytes(chunk.downloadedBytes)} / ${formatBytes(chunk.size)}${chunk.attempts > 0 ? `，第 ${chunk.attempts} 次` : ""}${chunk.errorMessage ? `，错误：${chunk.errorMessage}` : ""}`;

  if (canRetry) {
    return (
      <button
        type="button"
        aria-label={`${label}，点击重试`}
        title={`${label}，点击重试`}
        onClick={onRetry}
        className={chunkTileClass(chunk.status)}
      />
    );
  }

  return (
    <span
      aria-label={label}
      title={label}
      className={chunkTileClass(chunk.status)}
      role="img"
    />
  );
}

function ChunkStatusLegend() {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-muted">
      <LegendItem className="bg-border" label="等待" />
      <LegendItem className="bg-warning" label="下载中" />
      <LegendItem className="bg-primary" label="已完成" />
      <LegendItem className="bg-danger" label="异常" />
    </div>
  );
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`size-2.5 rounded-[3px] ${className}`} />
      {label}
    </span>
  );
}

function chunkTileClass(status: AcceleratedChunkStatus): string {
  const base = "size-3.5 rounded-[4px] border transition-[background-color,border-color,box-shadow,transform] duration-200 focus-visible:outline-none focus-visible:focus-ring";
  switch (status) {
    case "completed":
      return `${base} border-primary/60 bg-primary shadow-[0_0_0_1px_rgba(16,185,129,0.08)]`;
    case "downloading":
      return `${base} animate-pulse border-warning/70 bg-warning shadow-[0_0_0_3px_rgba(245,158,11,0.12)]`;
    case "failed":
      return `${base} border-danger/70 bg-danger hover:scale-110 hover:shadow-[0_0_0_4px_rgba(239,68,68,0.14)]`;
    case "queued":
    default:
      return `${base} border-border-strong bg-border`;
  }
}

function chunkStatusText(status: AcceleratedChunkStatus): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "downloading":
      return "正在下载";
    case "failed":
      return "异常";
    case "queued":
    default:
      return "等待";
  }
}

function StatusIcon({ status }: { status: AcceleratedDownloadStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={20} />;
    case "cancelled":
    case "error":
      return <XCircle size={20} />;
    case "partial_failed":
      return <AlertTriangle size={20} />;
    case "preparing":
      return <Download size={20} />;
    default:
      return <Loader2 size={20} className="animate-spin" />;
  }
}

function statusText(state: AcceleratedDownloadState, stats: DownloadStats): string {
  switch (state.status) {
    case "preparing":
      return "正在准备本地写入句柄";
    case "downloading":
      return stats.failedChunks > 0
        ? `继续下载剩余分片，已有 ${stats.failedChunks} 个分片失败`
        : "正在并发下载并写入本地文件";
    case "partial_failed":
      return "部分分片失败，可单独重试或批量重试失败分片";
    case "finalizing":
      return "所有分片已完成，正在关闭本地文件";
    case "completed":
      return "下载完成，最终文件已写入本地。";
    case "cancelled":
      return "下载已取消，未完成的本地文件已丢弃。";
    case "error":
      return "任务失败，可重试失败分片或取消后重新开始。";
    default:
      return "正在处理下载任务";
  }
}

function ProgressStat({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className={tone === "danger"
      ? "rounded-xl border border-danger/25 bg-danger-soft px-3 py-2"
      : "rounded-xl border border-border bg-surface px-3 py-2"}
    >
      <p className={tone === "danger" ? "text-[11px] font-medium text-danger" : "text-[11px] font-medium text-muted"}>
        {label}
      </p>
      <p className={tone === "danger" ? "mt-1 font-semibold text-danger" : "mt-1 font-semibold text-foreground"}>
        {value}
      </p>
    </div>
  );
}

interface DownloadStats {
  completedChunks: number;
  failedChunks: number;
  activeChunks: number;
  outputBytes: number;
  progress: number;
}

function summarizeChunks(state: AcceleratedDownloadState): DownloadStats {
  const completedChunks = state.chunks.filter((chunk) => chunk.status === "completed").length;
  const failedChunks = state.chunks.filter((chunk) => chunk.status === "failed").length;
  const activeChunks = state.chunks.filter((chunk) => chunk.status === "downloading").length;
  const outputBytes = state.chunks.reduce((total, chunk) => {
    if (chunk.status === "failed" || chunk.status === "queued") {
      return total;
    }

    return total + Math.min(chunk.downloadedBytes, chunk.size);
  }, 0);
  const progress = state.totalBytes > 0
    ? Math.min(100, Math.round((outputBytes / state.totalBytes) * 100))
    : 0;

  return {
    completedChunks,
    failedChunks,
    activeChunks,
    outputBytes,
    progress
  };
}
