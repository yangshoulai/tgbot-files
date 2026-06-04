import { Copy, Download, ExternalLink, Zap } from "lucide-react";
import type { FileItem } from "../../api";
import { canUseAcceleratedDownload } from "../../lib/accelerated-download";
import { fileAccessLabel, hasDirectFileAccess } from "../../lib/file-access";
import { fileKind, formatBytes, formatDateTime } from "../../utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { FileVisual } from "../ui/FileVisual";

interface FileDetailDialogProps {
  file: FileItem | null;
  onClose: () => void;
  onCopy: (value: string) => void;
  onAcceleratedDownload?: (file: FileItem) => void;
}

export function FileDetailDialog({ file, onClose, onCopy, onAcceleratedDownload }: FileDetailDialogProps) {
  if (!file) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const kind = fileKind(file);
  const isMultipart = file.storage_backend === "telegram_multipart";
  const directFile = hasDirectFileAccess(file) ? file : null;

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-3">
          <FileVisual
            mimeType={file.mime_type}
            fileName={file.file_name}
            url={directFile ? file.file_path : undefined}
            thumbnailUrl={file.thumbnail_url}
            size="sm"
          />
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
          {directFile ? (
            <>
              <Button variant="secondary" leadingIcon={<Copy size={15} />} onClick={() => onCopy(directFile.url)}>
                复制链接
              </Button>
              <a
                href={directFile.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground shadow-card transition-colors duration-150 hover:border-border-strong hover:bg-background"
              >
                <ExternalLink size={15} />
                打开
              </a>
              <a
                href={directFile.download_url}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-white shadow-card transition-colors duration-150 hover:border-primary-strong hover:bg-primary-strong"
              >
                <Download size={15} />
                下载
              </a>
            </>
          ) : null}
          {onAcceleratedDownload && canUseAcceleratedDownload(file) ? (
            <Button variant="primary" leadingIcon={<Zap size={15} />} onClick={() => onAcceleratedDownload(file)}>
              加速下载
            </Button>
          ) : null}
        </>
      }
      bodyClassName="bg-background/40"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DetailRow label="文件名" value={file.file_name} mono />
        <DetailRow label="MIME 类型" value={file.mime_type} mono />
        <DetailRow label="大小" value={formatBytes(file.size)} />
        <DetailRow label="目录" value={file.directory_path || "/"} mono />
        <DetailRow label="存储方式" value={isMultipart ? `Telegram 分片（${file.chunk_count ?? "?"} 片）` : "Telegram 单文件"} />
        <DetailRow label="访问方式" value={fileAccessLabel(file)} />
        <DetailRow label="MD5" value={isMultipart ? "分片文件不计算整文件 MD5" : file.md5} mono={!isMultipart} />
        <DetailRow label={isMultipart ? "分片记录 ID" : "Telegram ID"} value={file.telegram_file_id} mono />
        <DetailRow label="Telegram Unique ID" value={file.telegram_file_unique_id || "未记录"} mono />
        <DetailRow label="缩略图" value={thumbnailLabel(file)} />
        <DetailRow label="上传时间" value={formatDateTime(file.created_at)} />
        <DetailRow label="上传者" value={file.uploaded_by || "接口上传"} />
        <DetailRow label="备注" value={file.remark || "无备注"} fullWidth />
        <DetailRow label="链接" value={directFile ? directFile.url : "该文件超过直链能力，仅支持控制台加速下载"} mono={Boolean(directFile)} fullWidth />
      </div>
    </Modal>
  );
}

function thumbnailLabel(file: FileItem): string {
  if (file.thumbnail_status === "ready") {
    return file.thumbnail_mime_type
      ? `${file.thumbnail_mime_type} · ${file.thumbnail_size ? formatBytes(file.thumbnail_size) : "大小未记录"}`
      : "已生成";
  }

  if (file.thumbnail_status === "failed") {
    return "生成或上传失败";
  }

  return "无缩略图";
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
    case "video":
      return "success";
    case "audio":
      return "info";
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
