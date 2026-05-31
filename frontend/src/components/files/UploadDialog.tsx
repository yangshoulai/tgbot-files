import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardPaste, FilePlus2, Link2, Trash2, UploadCloud, X } from "lucide-react";
import { ApiError, uploadFile, uploadFileFromUrl } from "../../api";
import { formatBytes } from "../../utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Textarea";
import { Spinner } from "../ui/Spinner";
import { FileTypeIcon } from "../ui/FileTypeIcon";
import { Segmented } from "../ui/Segmented";
import { Input } from "../ui/Input";
import { cn } from "../../lib/cn";

interface UploadDialogProps {
  open: boolean;
  initialFiles: File[];
  maxBytes: number;
  onClose: () => void;
  onUploaded: (uploadedCount: number) => void;
  onError: (message: string) => void;
}

type ItemStatus = "pending" | "uploading" | "done" | "error" | "skipped";
type UploadMode = "file" | "url";

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  message?: string;
}

interface UrlUploadState {
  status: ItemStatus;
  message?: string;
}

let counter = 0;

function makeItem(file: File): QueueItem {
  counter += 1;
  return { id: `${Date.now()}-${counter}`, file, status: "pending" };
}

export function UploadDialog({ open, initialFiles, maxBytes, onClose, onUploaded, onError }: UploadDialogProps) {
  const [mode, setMode] = useState<UploadMode>("file");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [urlUpload, setUrlUpload] = useState<UrlUploadState>({ status: "pending" });
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setMode("file");
      setItems([]);
      setSourceUrl("");
      setUrlUpload({ status: "pending" });
      setRemark("");
      setSubmitting(false);
      setDragOver(false);
      return;
    }
    setMode("file");
    setItems(initialFiles.map(makeItem));
    setSourceUrl("");
    setUrlUpload({ status: "pending" });
  }, [open, initialFiles]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setMode("file");
    setItems((current) => [...current, ...files.map(makeItem)]);
  }, []);

  const handlePick = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list) return;
    addFiles(Array.from(list));
    event.target.value = "";
  };

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  const filePendingCount = items.filter((item) => item.status === "pending" || item.status === "error").length;
  const normalizedSourceUrl = sourceUrl.trim();
  const urlPendingCount = normalizedSourceUrl && urlUpload.status !== "uploading" && urlUpload.status !== "done" ? 1 : 0;
  const pendingCount = mode === "url" ? urlPendingCount : filePendingCount;
  const hasDone = urlUpload.status === "done" || items.some((item) => item.status === "done");

  function handleModeChange(nextMode: UploadMode) {
    if (submitting || mode === nextMode) return;
    setMode(nextMode);
  }

  function handleSourceUrlChange(value: string) {
    setSourceUrl(value);
    setUrlUpload({ status: "pending" });
  }

  function extractFirstUrl(value: string): string | undefined {
    const match = value.match(/https?:\/\/[^\s<>"']+/i);
    return match?.[0];
  }

  function validateSourceUrl(value: string): string | undefined {
    const normalized = value.trim();

    if (!normalized) {
      return "请粘贴要上传的 URL";
    }

    try {
      const url = new URL(normalized);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "仅支持 http/https URL";
      }
    } catch {
      return "请输入完整的 URL，例如 https://example.com/file.pdf";
    }

    return undefined;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (mode === "url") {
      await submitUrlUpload();
      return;
    }
    if (items.length === 0) {
      onError("请选择要上传的文件");
      return;
    }
    const targets = items.filter((item) => item.status === "pending" || item.status === "error");
    if (targets.length === 0) {
      onClose();
      return;
    }

    setSubmitting(true);
    let successCount = 0;

    for (const target of targets) {
      if (target.file.size > maxBytes) {
        setItems((current) =>
          current.map((item) =>
            item.id === target.id
              ? { ...item, status: "error", message: `超过 ${formatBytes(maxBytes)} 上限` }
              : item
          )
        );
        continue;
      }

      setItems((current) =>
        current.map((item) => (item.id === target.id ? { ...item, status: "uploading", message: undefined } : item))
      );

      try {
        const form = new FormData();
        form.set("file", target.file);
        if (remark.trim()) form.set("remark", remark.trim());
        await uploadFile(form);
        successCount += 1;
        setItems((current) =>
          current.map((item) => (item.id === target.id ? { ...item, status: "done", message: undefined } : item))
        );
      } catch (error) {
        const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "上传失败";
        setItems((current) =>
          current.map((item) => (item.id === target.id ? { ...item, status: "error", message } : item))
        );
        onError(message);
      }
    }

    setSubmitting(false);
    if (successCount > 0) {
      onUploaded(successCount);
    }
  }

  async function submitUrlUpload() {
    const error = validateSourceUrl(sourceUrl);
    if (error) {
      setUrlUpload({ status: "error", message: error });
      onError(error);
      return;
    }

    setSubmitting(true);
    setUrlUpload({ status: "uploading" });

    try {
      await uploadFileFromUrl(normalizedSourceUrl, remark.trim() || undefined);
      setUrlUpload({ status: "done", message: "已从 URL 上传" });
      onUploaded(1);
    } catch (uploadError) {
      const message = uploadError instanceof ApiError
        ? uploadError.message
        : uploadError instanceof Error
          ? uploadError.message
          : "URL 上传失败";
      setUrlUpload({ status: "error", message });
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleDropFiles(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    addFiles(files);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="上传文件"
      description={`单文件上限 ${formatBytes(maxBytes)}`}
      size="lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            {hasDone ? "关闭" : "取消"}
          </Button>
          <Button
            type="submit"
            form="upload-form"
            variant="primary"
            loading={submitting}
            leadingIcon={mode === "url" ? <Link2 size={16} /> : <FilePlus2 size={16} />}
            disabled={pendingCount === 0}
          >
            {submitting
              ? mode === "url" ? "拉取中" : "上传中"
              : pendingCount > 0
                ? mode === "url" ? "上传 URL" : `开始上传 ${pendingCount} 个`
                : "无待传文件"}
          </Button>
        </>
      }
    >
      <form id="upload-form" className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex items-center justify-between gap-3">
          <Segmented<UploadMode>
            value={mode}
            onChange={handleModeChange}
            ariaLabel="上传方式"
            options={[
              { value: "file", label: "本地文件", icon: <UploadCloud size={15} /> },
              { value: "url", label: "URL 链接", icon: <Link2 size={15} /> }
            ]}
          />
          <span className="hidden text-xs text-muted sm:inline">单文件上限 {formatBytes(maxBytes)}</span>
        </div>

        {mode === "file" ? (
          <>
            <label
              onDragEnter={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDropFiles}
              className={cn(
                "relative grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed bg-background px-6 py-8 text-center transition-colors duration-150",
                dragOver
                  ? "border-primary bg-primary-soft text-primary-strong"
                  : "border-border hover:border-primary/60 hover:bg-primary-soft/40"
              )}
            >
              <span className="grid size-12 place-items-center rounded-2xl bg-primary-soft text-primary-strong">
                <UploadCloud size={22} />
              </span>
              <p className="text-sm font-medium text-foreground">点击选择文件，或拖拽到这里</p>
              <p className="text-xs text-muted">可同时选择多个文件 · 上限 {formatBytes(maxBytes)}</p>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={handlePick}
              />
            </label>

            {items.length > 0 ? (
              <div className="flex max-h-64 flex-col gap-2 overflow-auto scroll-thin">
                {items.map((item) => (
                  <QueueRow key={item.id} item={item} onRemove={() => removeItem(item.id)} disabled={submitting} />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="upload-source-url" className="text-xs font-medium text-muted">
                粘贴文件 URL
              </label>
              <Input
                id="upload-source-url"
                type="url"
                placeholder="https://example.com/report.pdf"
                value={sourceUrl}
                disabled={submitting}
                invalid={urlUpload.status === "error"}
                leadingIcon={<ClipboardPaste size={15} />}
                onChange={(event) => handleSourceUrlChange(event.target.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  const pastedUrl = extractFirstUrl(pasted);
                  if (pastedUrl) {
                    event.preventDefault();
                    handleSourceUrlChange(pastedUrl);
                  }
                }}
              />
              <p className="text-xs leading-5 text-muted">
                后端会拉取该 URL，并优先根据文件内容、响应头和扩展名识别类型；远端文件同样受
                {" "}{formatBytes(maxBytes)} 上限约束。
              </p>
            </div>

            {normalizedSourceUrl ? (
              <UrlUploadRow
                url={normalizedSourceUrl}
                status={urlUpload.status}
                message={urlUpload.message}
                onClear={() => handleSourceUrlChange("")}
                disabled={submitting}
              />
            ) : null}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="upload-remark" className="text-xs font-medium text-muted">
            备注（可选 · 应用于本次所有文件）
          </label>
          <Textarea
            id="upload-remark"
            placeholder="补充说明，便于后续检索"
            value={remark}
            maxLength={1000}
            onChange={(event) => setRemark(event.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}

interface QueueRowProps {
  item: QueueItem;
  onRemove: () => void;
  disabled: boolean;
}

function QueueRow({ item, onRemove, disabled }: QueueRowProps) {
  const status = item.status;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
      <FileTypeIcon mimeType={item.file.type || "application/octet-stream"} fileName={item.file.name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={item.file.name}>
          {item.file.name}
        </p>
        <p className="truncate text-xs text-muted">
          {formatBytes(item.file.size)}
          {item.message ? <span className="text-danger"> · {item.message}</span> : null}
        </p>
      </div>
      <StatusBadge status={status} />
      <button
        type="button"
        aria-label="移除"
        onClick={onRemove}
        disabled={disabled || status === "uploading"}
        className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
      >
        {status === "done" ? <CheckCircle2 size={14} className="text-success" /> : <X size={14} />}
      </button>
    </div>
  );
}

interface UrlUploadRowProps {
  url: string;
  status: ItemStatus;
  message?: string;
  onClear: () => void;
  disabled: boolean;
}

function UrlUploadRow({ url, status, message, onClear, disabled }: UrlUploadRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
        <Link2 size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={url}>
          {remoteFileLabel(url)}
        </p>
        <p className="truncate text-xs text-muted">
          {url}
          {message ? <span className={status === "error" ? "text-danger" : "text-success"}> · {message}</span> : null}
        </p>
      </div>
      <StatusBadge status={status} />
      <button
        type="button"
        aria-label="清空 URL"
        onClick={onClear}
        disabled={disabled || status === "uploading"}
        className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
      >
        {status === "done" ? <CheckCircle2 size={14} className="text-success" /> : <X size={14} />}
      </button>
    </div>
  );
}

function remoteFileLabel(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : url.hostname;
  } catch {
    return "远程文件";
  }
}

function StatusBadge({ status }: { status: ItemStatus }) {
  switch (status) {
    case "uploading":
      return <Spinner size={14} className="text-primary-strong" />;
    case "done":
      return <CheckCircle2 size={16} className="text-success" />;
    case "error":
      return <Trash2 size={14} className="text-danger" />;
    case "skipped":
      return <span className="text-xs text-muted">跳过</span>;
    default:
      return <span className="text-xs text-muted">待上传</span>;
  }
}
