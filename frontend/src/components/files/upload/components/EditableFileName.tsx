import { useEffect, useRef } from "react";
import { Check, Pencil, X } from "lucide-react";
import { cn } from "../../../../lib/cn";
import { normalizedFileNameOverride } from "../filename-conflict";
import type { FileNameConflictState } from "../types";

export function EditableFileName({
  value,
  originalValue,
  editing,
  conflict,
  disabled,
  onChange,
  onEditingChange
}: {
  value: string;
  originalValue: string;
  editing: boolean;
  conflict?: FileNameConflictState;
  disabled: boolean;
  onChange: (value: string) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const isEditing = editing;
  const isEmpty = value.trim().length === 0;
  const displayValue = normalizedFileNameOverride(value) ?? originalValue;
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cancelValue = useRef(value);
  const wasEditing = useRef(isEditing);

  useEffect(() => {
    if (isEditing && !wasEditing.current) {
      cancelValue.current = value;
    }
    if (!isEditing) {
      cancelValue.current = value;
    }
    wasEditing.current = isEditing;
  }, [isEditing, value]);

  useEffect(() => {
    if (!isEditing || disabled) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [disabled, isEditing]);

  function startEditing() {
    if (disabled) return;
    cancelValue.current = value;
    onEditingChange(true);
  }

  function saveEditing() {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (normalized !== value || conflict) {
      onChange(normalized);
    }
    onEditingChange(false);
  }

  function cancelEditing() {
    if (conflict) {
      closeOnBlur();
      return;
    }
    onChange(cancelValue.current);
    onEditingChange(false);
  }

  function closeOnBlur() {
    const normalized = value.trim();

    if (normalized) {
      if (normalized !== value || conflict) {
        onChange(normalized);
      }
      onEditingChange(false);
      return;
    }

    onChange(conflict?.suggestedName || originalValue);
    onEditingChange(false);
  }

  if (!isEditing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          title={displayValue === originalValue ? displayValue : `${displayValue}（默认：${originalValue}）`}
        >
          {displayValue}
        </span>
        {!disabled ? (
          <button
            type="button"
            aria-label="编辑文件名"
            title="编辑文件名"
            onClick={startEditing}
            className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong focus-visible:outline-none focus-visible:focus-ring"
          >
            <Pencil size={13} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={editorRef}
      className="flex min-w-0 flex-col gap-1"
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) {
          return;
        }
        closeOnBlur();
      }}
    >
      <div
        className={cn(
          "flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg border bg-background px-2 transition-[border-color,box-shadow] duration-150",
          "focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--color-primary-ring)]",
          isEmpty ? "border-danger" : conflict ? "border-warning/45" : "border-border hover:border-border-strong"
        )}
      >
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={conflict?.suggestedName || originalValue}
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-subtle disabled:opacity-60"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveEditing();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
        />
        <button
          type="button"
          aria-label="确认文件名"
          title="确认文件名"
          disabled={disabled || isEmpty}
          onClick={saveEditing}
          className="grid size-6 shrink-0 place-items-center rounded-md text-success transition-colors hover:bg-success-soft disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:focus-ring"
        >
          <Check size={13} />
        </button>
        {!conflict ? (
          <button
            type="button"
            aria-label="取消编辑文件名"
            title="取消编辑"
            disabled={disabled}
            onClick={cancelEditing}
            className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:focus-ring"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      {isEmpty ? <p className="text-xs leading-5 text-danger">文件名不能为空。</p> : null}
    </div>
  );
}
