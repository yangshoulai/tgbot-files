import { useEffect, useRef, useState } from "react";
import { Music2 } from "lucide-react";
import { hasDirectFileAccess } from "../../../lib/file-access";
import { formatBytes } from "../../../utils";
import { cn } from "../../../lib/cn";
import type { PreviewComponentProps } from "./types";
import { MediaControls } from "./MediaControls";
import { PreviewError } from "./PreviewFrame";
import { Spinner } from "../../ui/Spinner";

interface AudioPreviewProps extends PreviewComponentProps {
  onToggleFullscreen: () => void;
}

const AUDIO_PREVIEW_TIMEOUT_MS = 30_000;

export function AudioPreview({ file, fullscreen, onToggleFullscreen }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const directFile = hasDirectFileAccess(file) ? file : null;
  const coverUrl = file.thumbnail_url && !coverFailed ? file.thumbnail_url : null;

  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setCoverFailed(false);
  }, [file.id]);

  useEffect(() => {
    if (!loading || failed || !directFile) return;

    const timeout = window.setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, AUDIO_PREVIEW_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [directFile, failed, loading]);

  if (!directFile) {
    return <PreviewError message="该音频不提供完整访问链接，无法直接在线播放" dark />;
  }

  return (
    <div className={cn("flex w-full items-center justify-center overflow-hidden bg-surface p-4 text-foreground sm:p-6", fullscreen ? "h-full" : "min-h-72") }>
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="size-20 shrink-0 overflow-hidden rounded-2xl border border-border bg-background shadow-card sm:size-24">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={`${file.file_name} 封面`}
                onError={() => setCoverFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="grid h-full w-full place-items-center bg-primary-soft text-primary-strong">
                <Music2 size={34} />
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground sm:text-lg" title={file.file_name}>{file.file_name}</p>
            <p className="mt-1 text-sm text-muted">{formatBytes(file.size)} · {file.mime_type}</p>
          </div>
        </div>

        {loading ? (
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted">
            <Spinner size={15} />
            音频加载中…
          </div>
        ) : null}

        {failed ? (
          <p className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            音频加载失败，请尝试下载后播放。
          </p>
        ) : null}

        <audio
          ref={audioRef}
          src={file.file_path}
          preload="metadata"
          onLoadStart={() => setLoading(true)}
          onLoadedMetadata={() => {
            setLoading(false);
            setFailed(false);
          }}
          onCanPlay={() => {
            setLoading(false);
            setFailed(false);
          }}
          onPlaying={() => {
            setLoading(false);
            setFailed(false);
          }}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        >
          当前浏览器不支持该音频预览。
        </audio>
        <MediaControls mediaRef={audioRef} fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} compact variant="inline" />
      </div>
    </div>
  );
}
