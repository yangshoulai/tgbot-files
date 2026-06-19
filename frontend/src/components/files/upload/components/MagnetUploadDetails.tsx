import { memo, useMemo } from "react";
import { Spinner } from "../../../ui/Spinner";
import { formatBytes } from "../../../../utils";
import { cn } from "../../../../lib/cn";
import {
  effectiveMagnetFileName,
  magnetStatusLabel,
  magnetTargetDirectoryPath
} from "../magnet-helpers";
import { CompactConflictActions } from "./ConflictControls";
import { EditableFileName } from "./EditableFileName";
import { HlsMetaPill } from "./HlsUploadDetails";
import type { MagnetFileDecision, MagnetUrlState } from "../types";
import type { MagnetImportFile } from "../../../../api";

export const MagnetUploadDetails = memo(function MagnetUploadDetails({
  magnet,
  maxMultipartBytes,
  directoryPath,
  disabled,
  onToggle,
  onSelectAll,
  onClearSelection,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict,
  onOverwriteAllConflicts
}: {
  magnet: MagnetUrlState;
  maxMultipartBytes: number;
  directoryPath: string;
  disabled: boolean;
  onToggle: (fileIndex: number, selected: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onFileNameChange: (fileIndex: number, value: string) => void;
  onFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onRenameConflict: (fileIndex: number) => void;
  onOverwriteConflict: (fileIndex: number) => void;
  onOverwriteAllConflicts: () => void;
}) {
  const info = magnet.import;
  if (!info) {
    return null;
  }

  const validFiles = useMemo(
    () => info.files.filter((file) => !file.file_name.startsWith("[METADATA]")),
    [info.files]
  );
  const selected = useMemo(() => new Set(magnet.selectedIndexes), [magnet.selectedIndexes]);
  const decisions = magnet.fileDecisions ?? {};
  const magnetStats = useMemo(
    () => {
      let selectedCount = 0;
      let selectedBytes = 0;
      let uploadableCount = 0;
      let selectedConflictCount = 0;

      for (const file of validFiles) {
        if (file.size <= maxMultipartBytes) {
          uploadableCount += 1;
        }
        if (!selected.has(file.file_index)) {
          continue;
        }
        selectedCount += 1;
        selectedBytes += file.size;
        if (decisions[file.file_index]?.conflict) {
          selectedConflictCount += 1;
        }
      }

      return { selectedCount, selectedBytes, uploadableCount, selectedConflictCount };
    },
    [decisions, maxMultipartBytes, selected, validFiles]
  );

  if (info.status === "probing" && validFiles.length === 0) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-background/70 p-3">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} />
          <span>正在解析磁力链接元数据，请稍候...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="[contain:layout_paint] mt-2 flex flex-col gap-2 rounded-lg border border-border bg-background/70 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <HlsMetaPill tone="strong">Magnet</HlsMetaPill>
          <HlsMetaPill>{magnetStatusLabel(info.status)}</HlsMetaPill>
          <HlsMetaPill>{validFiles.length} 个文件</HlsMetaPill>
          <HlsMetaPill>已选 {magnetStats.selectedCount} 个 · {formatBytes(magnetStats.selectedBytes)}</HlsMetaPill>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {magnetStats.selectedConflictCount > 0 ? (
            <button
              type="button"
              disabled={disabled}
              className="rounded-md px-1.5 py-1 font-medium text-warning transition-colors hover:bg-warning-soft disabled:pointer-events-none disabled:opacity-50"
              onClick={onOverwriteAllConflicts}
            >
              全部覆盖冲突
          </button>
          ) : null}
          <button
            type="button"
            disabled={disabled || magnetStats.uploadableCount === 0}
            className="rounded-md px-1.5 py-1 font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-50"
            onClick={onSelectAll}
          >
            全选可上传
          </button>
          <button
            type="button"
            disabled={disabled || magnetStats.selectedCount === 0}
            className="rounded-md px-1.5 py-1 font-medium text-muted transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-50"
            onClick={onClearSelection}
          >
            清空
          </button>
        </div>
      </div>
      {info.error_message ? (
        <p className="rounded-md bg-danger-soft px-2 py-1.5 text-xs text-danger">{info.error_message}</p>
      ) : null}
      <div className="[contain:layout_paint] max-h-60 overflow-auto rounded-lg border border-border bg-surface">
        {validFiles.length > 0 ? (
          <div className="divide-y divide-border">
            {validFiles.map((file) => {
              const tooLarge = file.size > maxMultipartBytes;
              const isSelected = selected.has(file.file_index);
              const decision = decisions[file.file_index];
              return (
                <MagnetFileRow
                  key={file.file_index}
                  file={file}
                  decision={decision}
                  directoryPath={directoryPath}
                  maxMultipartBytes={maxMultipartBytes}
                  disabled={disabled}
                  selected={isSelected}
                  onToggle={onToggle}
                  onFileNameChange={onFileNameChange}
                  onFileNameEditingChange={onFileNameEditingChange}
                  onRenameConflict={onRenameConflict}
                  onOverwriteConflict={onOverwriteConflict}
                />
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4 text-center text-xs text-muted">文件列表解析中</div>
        )}
      </div>
    </div>
  );
}, magnetUploadDetailsPropsEqual);

interface MagnetFileRowProps {
  file: MagnetImportFile;
  decision?: MagnetFileDecision;
  directoryPath: string;
  maxMultipartBytes: number;
  disabled: boolean;
  selected: boolean;
  onToggle: (fileIndex: number, selected: boolean) => void;
  onFileNameChange: (fileIndex: number, value: string) => void;
  onFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onRenameConflict: (fileIndex: number) => void;
  onOverwriteConflict: (fileIndex: number) => void;
}

const MagnetFileRow = memo(function MagnetFileRow({
  file,
  decision,
  directoryPath,
  maxMultipartBytes,
  disabled,
  selected,
  onToggle,
  onFileNameChange,
  onFileNameEditingChange,
  onRenameConflict,
  onOverwriteConflict
}: MagnetFileRowProps) {
  const tooLarge = file.size > maxMultipartBytes;
  const targetDirectoryPath = magnetTargetDirectoryPath(directoryPath, file);
  const targetFileName = effectiveMagnetFileName(file, decision);
  const editorFileName = decision?.editingFileName
    ? decision.fileNameOverride ?? file.file_name
    : targetFileName;
  const disabledRow = disabled || tooLarge;

  return (
    <div
      className={cn(
        "[contain:layout_paint] grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-xs",
        disabledRow ? "opacity-60" : "hover:bg-background"
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={disabledRow}
        onChange={(event) => onToggle(file.file_index, event.currentTarget.checked)}
        className="size-4 accent-[var(--color-primary)]"
      />
      <div className="min-w-0">
        {selected && !tooLarge ? (
          <EditableFileName
            value={editorFileName}
            originalValue={file.file_name}
            editing={Boolean(decision?.editingFileName)}
            conflict={decision?.conflict}
            disabled={disabled}
            onChange={(value) => onFileNameChange(file.file_index, value)}
            onEditingChange={(editing) => onFileNameEditingChange(file.file_index, editing)}
          />
        ) : (
          <span className="block truncate font-medium text-foreground" title={file.path}>{file.path}</span>
        )}
        <p className="truncate text-[11px] text-muted">
          {tooLarge ? (
            <span className="text-danger">超过 {formatBytes(maxMultipartBytes)} 上限</span>
          ) : (
            <>
              <span>{file.mime_type}</span>
              <span> · 目标 {targetDirectoryPath === "/" ? "/" : `${targetDirectoryPath}/`}{targetFileName}</span>
              {decision?.conflict ? <span className="text-warning"> · 目标已有同名文件</span> : null}
              {!decision?.conflict && decision?.conflictAction === "overwrite" ? <span className="text-warning"> · 将覆盖</span> : null}
              {!decision?.conflict && decision?.fileNameOverride ? <span className="text-primary-strong"> · 已改名</span> : null}
            </>
          )}
        </p>
        {file.relative_directory_path ? (
          <p className="truncate text-[11px] text-subtle" title={file.path}>磁力路径：{file.path}</p>
        ) : null}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        <CompactConflictActions
          conflict={selected ? decision?.conflict : undefined}
          disabled={disabled}
          onRename={() => onRenameConflict(file.file_index)}
          onOverwrite={() => onOverwriteConflict(file.file_index)}
        />
        <span className="font-mono text-[11px] text-muted">{formatBytes(file.size)}</span>
      </span>
    </div>
  );
}, (previous, next) =>
  previous.file === next.file &&
  previous.decision === next.decision &&
  previous.directoryPath === next.directoryPath &&
  previous.maxMultipartBytes === next.maxMultipartBytes &&
  previous.disabled === next.disabled &&
  previous.selected === next.selected
);

function magnetUploadDetailsPropsEqual(
  previous: {
    magnet: MagnetUrlState;
    maxMultipartBytes: number;
    directoryPath: string;
    disabled: boolean;
  },
  next: {
    magnet: MagnetUrlState;
    maxMultipartBytes: number;
    directoryPath: string;
    disabled: boolean;
  }
): boolean {
  return previous.magnet === next.magnet &&
    previous.maxMultipartBytes === next.maxMultipartBytes &&
    previous.directoryPath === next.directoryPath &&
    previous.disabled === next.disabled;
}
