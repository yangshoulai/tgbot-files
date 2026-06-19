import { memo } from "react";
import { CheckCircle2, Layers3, Trash2 } from "lucide-react";
import { Spinner } from "../../../ui/Spinner";
import { chunkProgressEqual } from "../equality";
import type { ChunkProgress, ItemStatus } from "../types";

export const ProgressBar = memo(function ProgressBar({ progress }: { progress: ChunkProgress }) {
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="[contain:layout_paint] mt-2 flex flex-col gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out will-change-[width]"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 text-[11px] text-muted">
        <span className="min-w-0 truncate" title={progress.label}>{progress.label}</span>
        <span className="shrink-0">{percent}%{progress.failed ? ` · 失败 ${progress.failed}` : ""}</span>
      </div>
    </div>
  );
}, (previous, next) => chunkProgressEqual(previous.progress, next.progress));

export function StatusBadge({ status, multipart }: { status: ItemStatus; multipart?: boolean }) {
  switch (status) {
    case "uploading":
      return multipart ? <Layers3 size={15} className="text-primary-strong" /> : <Spinner size={14} className="text-primary-strong" />;
    case "done":
      return <CheckCircle2 size={16} className="text-success" />;
    case "error":
      return <Trash2 size={14} className="text-danger" />;
    case "skipped":
      return <span className="text-[11px] text-muted">跳过</span>;
    default:
      return <span className="text-[11px] text-muted">待传</span>;
  }
}
