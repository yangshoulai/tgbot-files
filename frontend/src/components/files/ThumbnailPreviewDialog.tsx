import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import type { FileItem } from "../../api";
import { formatBytes } from "../../utils";
import { Modal } from "../ui/Modal";
import { Badge } from "../ui/Badge";
import { Spinner } from "../ui/Spinner";
import { cn } from "../../lib/cn";

interface ThumbnailPreviewDialogProps {
  file: FileItem | null;
  onClose: () => void;
}

export function ThumbnailPreviewDialog({ file, onClose }: ThumbnailPreviewDialogProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = file?.thumbnail_url || null;

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [file?.id, thumbnailUrl]);

  if (!file || !thumbnailUrl) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const dimensions =
    file.thumbnail_width && file.thumbnail_height
      ? `${file.thumbnail_width} x ${file.thumbnail_height}`
      : "尺寸未记录";
  const size = file.thumbnail_size ? formatBytes(file.thumbnail_size) : "大小未记录";

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="min-w-0 truncate" title={file.file_name}>
          {file.file_name}
        </span>
      }
      description={
        <span className="inline-flex min-w-0 items-center gap-2">
          <Badge tone="primary" size="sm">
            缩略图
          </Badge>
          <span className="truncate">
            {dimensions} · {size}
          </span>
        </span>
      }
      bodyClassName="bg-background/40"
    >
      <div className="relative h-[min(72dvh,780px)] min-h-72 w-full overflow-hidden rounded-xl border border-border bg-background">
        {!loaded && !failed ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-sm text-muted">
            <Spinner size={18} />
            加载缩略图…
          </div>
        ) : null}
        {failed ? (
          <div className="max-w-md rounded-2xl border border-border bg-background px-6 py-5 text-center shadow-card">
            <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
              <ImageOff size={20} />
            </span>
            <p className="text-sm font-semibold text-foreground">缩略图加载失败</p>
            <p className="mt-2 text-xs leading-5 text-muted">浏览器无法读取该缩略图资源。</p>
          </div>
        ) : (
          <div className="absolute inset-4 flex min-h-0 min-w-0 items-center justify-center">
            <img
              src={thumbnailUrl}
              alt={`${file.file_name} 缩略图`}
              className={cn(
                "block max-h-full max-w-full rounded-xl object-contain shadow-dialog transition-opacity duration-200",
                loaded ? "opacity-100" : "opacity-0"
              )}
              style={{ width: "auto", height: "auto" }}
              onLoad={() => {
                setLoaded(true);
                setFailed(false);
              }}
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
