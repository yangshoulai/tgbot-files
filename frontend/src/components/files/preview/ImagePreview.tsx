import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { hasFileLinkAccess } from "../../../lib/file-access";
import { cn } from "../../../lib/cn";
import type { PreviewComponentProps } from "./types";
import { PreviewError, PreviewLoading } from "./PreviewFrame";

export function ImagePreview({ file, fullscreen }: PreviewComponentProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const linkFile = hasFileLinkAccess(file) ? file : null;

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [file.id]);

  if (!linkFile) {
    return <PreviewError message="该文件不提供完整访问链接，无法直接预览图片" />;
  }

  if (failed) {
    return (
      <div className={cn("grid w-full place-items-center px-6 text-center", fullscreen ? "h-full" : "h-[min(62dvh,720px)] min-h-72")}>
        <div className="max-w-md rounded-2xl border border-border bg-background px-6 py-5 shadow-card">
          <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
            <ImageOff size={20} />
          </span>
          <p className="text-sm font-semibold text-foreground">图片加载失败</p>
          <p className="mt-2 text-xs leading-5 text-muted">浏览器无法读取该图片资源，请尝试下载后查看。</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative grid min-w-0 w-full place-items-center overflow-hidden bg-[radial-gradient(circle_at_top,var(--color-primary-soft),transparent_28%),linear-gradient(45deg,#f8fafc_25%,transparent_25%),linear-gradient(-45deg,#f8fafc_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f8fafc_75%),linear-gradient(-45deg,transparent_75%,#f8fafc_75%)] bg-[length:auto,24px_24px,24px_24px,24px_24px,24px_24px] bg-[position:center,0_0,0_12px,12px_-12px,-12px_0] p-4", fullscreen ? "h-full" : "h-[min(70dvh,760px)] max-h-[calc(92dvh-12rem)] min-h-72") }>
      {!loaded ? (
        <div className="absolute inset-0 z-10">
          <PreviewLoading label="加载图片预览…" />
        </div>
      ) : null}
      <img
        src={file.file_path}
        alt={file.file_name}
        className={cn(
          "transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
          "block h-full max-h-full w-full max-w-full rounded-xl object-contain shadow-dialog"
        )}
        loading="lazy"
        onLoad={() => {
          setLoaded(true);
          setFailed(false);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
