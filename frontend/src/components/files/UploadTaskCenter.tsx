import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock3, Layers3, Square, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { cn } from "../../lib/cn";
import type { UploadTaskSnapshot, UploadTaskSnapshotItem } from "./UploadDialog";

interface UploadTaskCenterProps {
  snapshot: UploadTaskSnapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowDetails: () => void;
  onStop: () => void;
  onDelete: (id: string) => void;
}

export function UploadTaskCenter({ snapshot, open, onOpenChange, onShowDetails, onStop, onDelete }: UploadTaskCenterProps) {
  if (!snapshot) return null;

  const hasWork = snapshot.items.some((item) => item.status === "uploading" || item.status === "pending");
  const activeItem = snapshot.activeItemId
    ? snapshot.items.find((item) => item.id === snapshot.activeItemId)
    : snapshot.items.find((item) => item.status === "uploading");
  const headline = activeItem
    ? `${activeItem.title} · ${activeItem.progressPercent}%`
    : uploadTaskSummaryText(snapshot);

  return (
    <aside className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-md sm:bottom-6 sm:right-6">
      <div className="overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-dialog backdrop-blur-xl">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:focus-ring"
          aria-expanded={open}
        >
          <span className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl",
            hasWork ? "bg-primary-soft text-primary-strong" : snapshot.summary.error > 0 ? "bg-danger-soft text-danger" : "bg-success-soft text-success"
          )}>
            {hasWork ? <Layers3 size={17} /> : snapshot.summary.error > 0 ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">上传任务中心</span>
            <span className="block truncate text-xs text-muted">{headline}</span>
          </span>
          {open ? <ChevronDown size={17} className="text-muted" /> : <ChevronUp size={17} className="text-muted" />}
        </button>

        {open ? (
          <div className="border-t border-border bg-background/35 p-3">
            <div className="mb-3 grid grid-cols-4 gap-2 text-center">
              <TaskMetric label="全部" value={snapshot.summary.total} />
              <TaskMetric label="执行中" value={snapshot.summary.uploading} />
              <TaskMetric label="完成" value={snapshot.summary.done} />
              <TaskMetric label="异常" value={snapshot.summary.error} />
            </div>

            <div className="max-h-72 space-y-2 overflow-auto pr-1 scroll-thin">
              {snapshot.items.map((item) => (
                <UploadTaskRow
                  key={`${item.kind}-${item.id}`}
                  item={item}
                  active={snapshot.activeItemId === item.id}
                  onDelete={() => onDelete(item.id)}
                />
              ))}
            </div>

            <div className="mt-3 flex flex-wrap justify-end gap-2">
              {snapshot.running ? (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  leadingIcon={<Square size={13} />}
                  disabled={snapshot.stopRequested}
                  onClick={onStop}
                >
                  {snapshot.stopRequested ? "正在停止" : "停止当前"}
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" onClick={onShowDetails}>
                查看详情
              </Button>
              <IconButton
                variant="ghost"
                size="sm"
                label="收起任务中心"
                onClick={() => onOpenChange(false)}
              >
                <ChevronDown size={15} />
              </IconButton>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function TaskMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-2 py-2">
      <div className="text-sm font-semibold text-foreground">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{label}</div>
    </div>
  );
}

function UploadTaskRow({ item, active, onDelete }: { item: UploadTaskSnapshotItem; active: boolean; onDelete: () => void }) {
  const status = uploadTaskStatusMeta(item);
  const Icon = status.icon;
  return (
    <div className={cn(
      "rounded-xl border bg-surface px-3 py-2.5 shadow-card",
      active ? "border-primary/35" : "border-border"
    )}>
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg", status.bg, status.fg)}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm font-medium text-foreground" title={item.title}>{item.title}</p>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <span className={cn("text-xs font-medium", status.fg)}>{status.label}</span>
              <IconButton
                variant="ghost"
                size="sm"
                label="删除任务"
                disabled={!item.canDelete}
                onClick={onDelete}
                className="size-6 text-subtle hover:bg-danger-soft hover:text-danger"
              >
                <Trash2 size={13} />
              </IconButton>
            </span>
          </div>
          {item.description ? (
            <p className="mt-0.5 truncate text-xs text-muted" title={item.description}>{item.description}</p>
          ) : null}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300 ease-out",
                item.status === "error" ? "bg-danger" : item.status === "done" ? "bg-success" : "bg-primary"
              )}
              style={{ width: `${item.progressPercent}%` }}
            />
          </div>
          {item.progressLabel ? (
            <p className="mt-1 truncate text-[11px] text-muted" title={item.progressLabel}>{item.progressLabel}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function uploadTaskSummaryText(snapshot: UploadTaskSnapshot): string {
  if (snapshot.summary.error > 0) return `${snapshot.summary.error} 个任务需要处理`;
  if (snapshot.summary.done === snapshot.summary.total) return `已完成 ${snapshot.summary.done} 个任务`;
  if (snapshot.summary.pending > 0) return `${snapshot.summary.pending} 个任务等待上传`;
  return `${snapshot.summary.total} 个任务`;
}

function uploadTaskStatusMeta(item: UploadTaskSnapshotItem) {
  switch (item.status) {
    case "uploading":
      return { label: "执行中", bg: "bg-primary-soft", fg: "text-primary-strong", icon: Layers3 };
    case "done":
      return { label: "已完成", bg: "bg-success-soft", fg: "text-success", icon: CheckCircle2 };
    case "error":
      return { label: "异常", bg: "bg-danger-soft", fg: "text-danger", icon: AlertTriangle };
    case "skipped":
      return { label: "已跳过", bg: "bg-border", fg: "text-muted", icon: Clock3 };
    default:
      return { label: "等待中", bg: "bg-border", fg: "text-muted", icon: Clock3 };
  }
}
