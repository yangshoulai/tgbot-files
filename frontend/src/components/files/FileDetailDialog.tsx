import { Copy, Download, ExternalLink } from "lucide-react";
import type { FileItem } from "../../api";
import { fileKind, formatBytes, formatDateTime } from "../../utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { FileVisual } from "../ui/FileVisual";

interface FileDetailDialogProps {
  file: FileItem | null;
  onClose: () => void;
  onCopy: (value: string) => void;
}

export function FileDetailDialog({ file, onClose, onCopy }: FileDetailDialogProps) {
  if (!file) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const kind = fileKind(file);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-3">
          <FileVisual mimeType={file.mime_type} fileName={file.file_name} url={file.file_path} size="sm" />
          <span className="min-w-0 truncate" title={file.file_name}>
            {file.file_name}
          </span>
        </span>
      }
      description={
        <span className="inline-flex items-center gap-2">
          <Badge tone={badgeTone(kind.tone)} size="sm">
            {kind.label}
          </Badge>
          <span>
            {formatBytes(file.size)} · {file.mime_type}
          </span>
        </span>
      }
      footer={
        <>
          <Button variant="secondary" leadingIcon={<Copy size={15} />} onClick={() => onCopy(file.url)}>
            复制链接
          </Button>
          <a
            href={file.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground shadow-card transition-colors duration-150 hover:border-border-strong hover:bg-background"
          >
            <ExternalLink size={15} />
            打开
          </a>
          <a
            href={file.download_url}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-white shadow-card transition-colors duration-150 hover:border-primary-strong hover:bg-primary-strong"
          >
            <Download size={15} />
            下载
          </a>
        </>
      }
      bodyClassName="bg-background/40"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DetailRow label="文件名" value={file.file_name} mono />
        <DetailRow label="MIME 类型" value={file.mime_type} mono />
        <DetailRow label="大小" value={formatBytes(file.size)} />
        <DetailRow label="MD5" value={file.md5} mono />
        <DetailRow label="Telegram ID" value={file.telegram_file_id} mono />
        <DetailRow label="Telegram Unique ID" value={file.telegram_file_unique_id || "未记录"} mono />
        <DetailRow label="上传时间" value={formatDateTime(file.created_at)} />
        <DetailRow label="上传者" value={file.uploaded_by || "接口上传"} />
        <DetailRow label="备注" value={file.remark || "无备注"} fullWidth />
        <DetailRow label="链接" value={file.url} mono fullWidth />
      </div>
    </Modal>
  );
}

function DetailRow({
  label,
  value,
  mono,
  fullWidth
}: {
  label: string;
  value: string;
  mono?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={
        fullWidth
          ? "sm:col-span-2 rounded-xl border border-border bg-surface px-3 py-2.5"
          : "rounded-xl border border-border bg-surface px-3 py-2.5"
      }
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={"mt-1 overflow-anywhere text-sm " + (mono ? "font-mono" : "") + " text-foreground"}>
        {value}
      </p>
    </div>
  );
}

function badgeTone(tone: ReturnType<typeof fileKind>["tone"]): "success" | "danger" | "info" | "warning" | "neutral" {
  switch (tone) {
    case "image":
      return "success";
    case "pdf":
      return "danger";
    case "text":
      return "info";
    case "archive":
      return "warning";
    default:
      return "neutral";
  }
}
