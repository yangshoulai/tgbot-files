import { memo, useMemo } from "react";
import { CheckCircle2, Layers3, Trash2 } from "lucide-react";
import { Spinner } from "../../../ui/Spinner";
import { formatBytes } from "../../../../utils";
import { cn } from "../../../../lib/cn";
import { MAX_RENDERABLE_CHUNKS } from "../constants";
import type { UploadChunkState, UploadChunkStatus } from "../types";

export const UploadChunkPanel = memo(function UploadChunkPanel({
  chunks,
  expanded,
  onToggle
}: {
  chunks: UploadChunkState[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const stats = useMemo(() => uploadChunkStats(chunks), [chunks]);

  return (
    <div className="[contain:layout_paint] rounded-lg border border-border bg-background/70 p-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 text-left text-[11px] text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Layers3 size={13} className="shrink-0 text-primary-strong" />
          <span className="truncate">
            分片：{stats.completed}/{chunks.length} 完成
            {stats.uploading > 0 ? ` · ${stats.uploading} 上传中` : ""}
            {stats.failed > 0 ? ` · ${stats.failed} 失败` : ""}
          </span>
        </span>
        <span className="shrink-0 font-medium text-primary-strong">
          {expanded ? "收起详情" : "分片详情"}
        </span>
      </button>
      {expanded ? <UploadChunkList chunks={chunks} /> : null}
    </div>
  );
});

export const UploadChunkList = memo(function UploadChunkList({ chunks, title = "分片明细" }: { chunks: UploadChunkState[]; title?: string }) {
  const stats = useMemo(() => uploadChunkStats(chunks), [chunks]);
  const shouldLimitRender = chunks.length > MAX_RENDERABLE_CHUNKS;
  const visibleChunks = useMemo(
    () => shouldLimitRender ? chunks.slice(0, MAX_RENDERABLE_CHUNKS) : chunks,
    [chunks, shouldLimitRender]
  );

  return (
    <div className="[contain:layout_paint] mt-2 border-t border-border pt-2">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>
          {title}：{stats.completed}/{chunks.length} 完成
          {stats.uploading > 0 ? ` · ${stats.uploading} 上传中` : ""}
          {stats.failed > 0 ? ` · ${stats.failed} 失败` : ""}
        </span>
        {shouldLimitRender ? <span>显示前 {MAX_RENDERABLE_CHUNKS} 个分片</span> : <span>每片状态实时更新</span>}
      </div>
      <div className="grid max-h-40 gap-1 overflow-auto pr-1 scroll-thin sm:grid-cols-2">
        {visibleChunks.map((chunk) => (
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
            {chunk.size > 0 ? <span className="shrink-0 opacity-70">{formatBytes(chunk.size)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
});

export function uploadChunkStats(chunks: UploadChunkState[]): { completed: number; failed: number; uploading: number } {
  return chunks.reduce(
    (stats, chunk) => {
      if (chunk.status === "completed") {
        stats.completed += 1;
      } else if (chunk.status === "failed") {
        stats.failed += 1;
      } else if (chunk.status === "uploading") {
        stats.uploading += 1;
      }
      return stats;
    },
    { completed: 0, failed: 0, uploading: 0 }
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
