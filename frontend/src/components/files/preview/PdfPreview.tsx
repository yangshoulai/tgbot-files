import { useEffect, useState } from "react";
import { FileWarning } from "lucide-react";
import { hasFileLinkAccess } from "../../../lib/file-access";
import { cn } from "../../../lib/cn";
import type { PreviewComponentProps } from "./types";
import { PreviewError, PreviewLoading } from "./PreviewFrame";

export function PdfPreview({ file, fullscreen }: PreviewComponentProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const linkFile = hasFileLinkAccess(file) ? file : null;

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [file.id]);

  if (!linkFile) {
    return <PreviewError message="该 PDF 不提供完整访问链接，无法直接预览" />;
  }

  if (failed) {
    return (
      <div className={cn("grid w-full place-items-center px-6 text-center", fullscreen ? "h-full" : "h-[min(72dvh,780px)] min-h-72")}>
        <div className="max-w-md rounded-2xl border border-border bg-background px-6 py-5 shadow-card">
          <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
            <FileWarning size={20} />
          </span>
          <p className="text-sm font-semibold text-foreground">PDF 预览加载失败</p>
          <p className="mt-2 text-xs leading-5 text-muted">
            当前浏览器可能禁用了内置 PDF 阅读器，或文件链接已失效。请尝试下载后查看。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative min-w-0 w-full overflow-hidden bg-background", fullscreen ? "h-full" : "h-[min(76dvh,820px)] max-h-[calc(92dvh-12rem)] min-h-96")}>
      {!loaded ? (
        <div className="absolute inset-0 z-10">
          <PreviewLoading label="加载 PDF 预览…" />
        </div>
      ) : null}
      <iframe
        title={`PDF 预览 ${file.file_name}`}
        src={`${file.file_path}#view=FitH`}
        className={cn("h-full w-full border-0 bg-white transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
        onLoad={() => {
          setLoaded(true);
          setFailed(false);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
