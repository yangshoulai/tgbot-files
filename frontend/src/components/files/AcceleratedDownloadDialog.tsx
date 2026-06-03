import { memo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
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

        <div className="flex flex-col gap-2">
          <div className="h-2 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${stats.progress}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted lg:grid-cols-4">
            <ProgressStat label="整体进度" value={`${formatBytes(stats.outputBytes)} / ${formatBytes(state.totalBytes)}`} />
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

        <div className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
            <p className="text-xs font-semibold text-foreground">分片明细</p>
            <p className="text-xs text-muted">
              每个请求对应一个 Telegram 分片
            </p>
          </div>
          <div className="max-h-[38vh] overflow-auto scroll-thin p-2">
            <div className="grid grid-cols-1 gap-2">
              {state.chunks.map((chunk) => (
                <MemoizedChunkRow
                  key={chunk.index}
                  chunk={chunk}
                  totalChunks={state.chunks.length}
                  onRetry={() => onRetryChunk(chunk.index)}
                />
              ))}
            </div>
          </div>
        </div>

        <p className="rounded-xl border border-info/20 bg-info-soft px-3 py-2 text-xs leading-5 text-info">
          页面刷新或取消任务会丢弃未完成文件；单个分片重试会重新下载该 Telegram 分片并覆盖对应写入位置。
        </p>
      </div>
    </Modal>
  );
}

const MemoizedChunkRow = memo(
  ChunkRow,
  (previous, next) => previous.chunk === next.chunk && previous.totalChunks === next.totalChunks
);

function ChunkRow({
  chunk,
  totalChunks,
  onRetry
}: {
  chunk: AcceleratedChunkState;
  totalChunks: number;
  onRetry: () => void;
}) {
  const progress = chunk.size > 0
    ? Math.min(100, Math.round((Math.min(chunk.downloadedBytes, chunk.size) / chunk.size) * 100))
    : 0;
  const canRetry = chunk.status === "failed";

  return (
    <div className="rounded-xl border border-border bg-background/70 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            分片 {chunk.index + 1} / {totalChunks}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {formatBytes(chunk.downloadedBytes)} / {formatBytes(chunk.size)}
            {chunk.attempts > 0 ? ` · 第 ${chunk.attempts} 次` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ChunkStatusBadge status={chunk.status} />
          {canRetry ? (
            <Button size="sm" variant="secondary" leadingIcon={<RotateCcw size={14} />} onClick={onRetry}>
              重试
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={chunk.status === "failed" ? "h-full rounded-full bg-danger" : "h-full rounded-full bg-primary"}
          style={{ width: `${progress}%` }}
        />
      </div>
      {chunk.errorMessage ? (
        <p className="mt-2 overflow-anywhere text-xs leading-5 text-danger">
          {chunk.errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function ChunkStatusBadge({ status }: { status: AcceleratedChunkStatus }) {
  const config = {
    queued: { label: "等待", className: "bg-border text-muted", icon: Clock3 },
    downloading: { label: "下载中", className: "bg-info-soft text-info", icon: Loader2 },
    completed: { label: "完成", className: "bg-success-soft text-success", icon: CheckCircle2 },
    failed: { label: "失败", className: "bg-danger-soft text-danger", icon: AlertTriangle }
  }[status];
  const Icon = config.icon;

  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold ${config.className}`}>
      <Icon size={13} className={status === "downloading" ? "animate-spin" : undefined} />
      {config.label}
    </span>
  );
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
      return "任务失败，请保留普通下载链接作为兜底。";
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
