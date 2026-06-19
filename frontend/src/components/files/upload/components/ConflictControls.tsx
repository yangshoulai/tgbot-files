import { AlertTriangle } from "lucide-react";
import { Button } from "../../../ui/Button";
import type { FileNameConflictState } from "../types";

export function ConflictSummary({
  count,
  disabled,
  onOverwriteAll,
  onSkipAll
}: {
  count: number;
  disabled: boolean;
  onOverwriteAll: () => void;
  onSkipAll: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warning/35 bg-warning-soft/45 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2 text-sm text-warning">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">发现 {count} 个同名文件</p>
          <p className="text-xs leading-5 text-warning/85">可以批量处理，也可以在下方逐项选择。</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onOverwriteAll}
        >
          全部覆盖
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onSkipAll}
        >
          全部忽略
        </Button>
      </div>
    </div>
  );
}

export function CompactConflictActions({
  conflict,
  disabled,
  onRename,
  onOverwrite,
  onSkip
}: {
  conflict?: FileNameConflictState;
  disabled: boolean;
  onRename?: () => void;
  onOverwrite?: () => void;
  onSkip?: () => void;
}) {
  if (!conflict) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={onOverwrite}
        title={`覆盖 ${conflict.fileName}`}
        disabled={disabled || !onOverwrite}
        className="h-6 rounded px-1.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-40"
      >
        覆盖
      </button>
      <button
        type="button"
        onClick={onRename}
        title={`改名为 ${conflict.suggestedName}`}
        disabled={disabled || !onRename}
        className="h-6 rounded px-1.5 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
      >
        改名
      </button>
      {onSkip ? (
        <button
          type="button"
          onClick={onSkip}
          disabled={disabled}
          className="h-6 rounded px-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          忽略
        </button>
      ) : null}
    </span>
  );
}

export function conflictTitle(conflict: FileNameConflictState): string {
  const separator = conflict.directoryPath.endsWith("/") ? "" : "/";
  return `${conflict.source === "batch" ? "本次队列重复" : "目标目录已存在"}：${conflict.directoryPath}${separator}${conflict.fileName}`;
}

export function ConflictResolutionActions({
  conflict,
  disabled,
  onRename,
  onOverwrite,
  onSkip
}: {
  conflict?: FileNameConflictState;
  disabled: boolean;
  onRename?: () => void;
  onOverwrite?: () => void;
  onSkip?: () => void;
}) {
  if (!conflict) {
    return null;
  }

  const title = conflict.source === "batch" ? "本次队列已有相同目标路径" : "目标目录已存在同名文件";

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2 rounded-lg border border-warning/35 bg-warning-soft/50 px-2.5 py-2 text-xs leading-5 text-warning">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="break-all text-warning/90">
          <span className="font-semibold">{conflict.directoryPath}</span>
          {conflict.directoryPath.endsWith("/") ? "" : "/"}
          <span className="font-semibold">{conflict.fileName}</span>
        </p>
        {conflict.message ? <p className="text-warning/80">{conflict.message}</p> : null}
      </div>
      <span className="flex min-w-0 flex-wrap gap-1.5">
        {onRename ? (
          <button
            type="button"
            onClick={onRename}
            onPointerDown={(event) => event.preventDefault()}
            title={`重命名为 ${conflict.suggestedName}`}
            disabled={disabled}
            className="min-w-0 max-w-full rounded-md border border-warning/35 bg-surface px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="block max-w-full truncate">重命名为 {conflict.suggestedName}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={onOverwrite}
          onPointerDown={(event) => event.preventDefault()}
          title={`覆盖 ${conflict.fileName}`}
          disabled={disabled || !onOverwrite}
          className="rounded-md border border-danger/30 px-2.5 py-1 font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-50"
        >
          覆盖原文件
        </button>
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            onPointerDown={(event) => event.preventDefault()}
            disabled={disabled}
            className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-muted transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            忽略此文件
          </button>
        ) : null}
      </span>
    </div>
  );
}
