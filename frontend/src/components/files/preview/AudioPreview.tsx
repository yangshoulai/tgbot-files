import { useEffect, useRef, useState } from "react";
import { Music2 } from "lucide-react";
import { hasFileLinkAccess } from "../../../lib/file-access";
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
  const linkFile = hasFileLinkAccess(file) ? file : null;
  const coverUrl = file.thumbnail_url && !coverFailed ? file.thumbnail_url : null;

  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setCoverFailed(false);
  }, [file.id]);

  useEffect(() => {
    if (!loading || failed || !linkFile) return;

    const timeout = window.setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, AUDIO_PREVIEW_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [linkFile, failed, loading]);

  if (!linkFile) {
    return <PreviewError message="该音频不提供完整访问链接，无法直接在线播放" dark />;
  }

  return (
    <div
      className={cn(
        "relative isolate flex w-full items-center justify-center overflow-hidden bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,251,246,0.92))] p-4 text-foreground sm:p-6",
        fullscreen ? "h-full" : "min-h-72"
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="absolute -top-14 left-[8%] h-[24rem] w-32 -rotate-12 bg-[linear-gradient(180deg,rgba(16,185,129,0.22),rgba(16,185,129,0.045)_62%,transparent)] blur-sm [clip-path:polygon(34%_0,66%_0,100%_100%,0_100%)] sm:w-44" />
        <span className="absolute -top-16 right-[10%] h-[25rem] w-36 rotate-12 bg-[linear-gradient(180deg,rgba(59,130,246,0.14),rgba(16,185,129,0.04)_58%,transparent)] blur-sm [clip-path:polygon(34%_0,66%_0,100%_100%,0_100%)] sm:w-48" />
        <span className="absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,transparent,rgba(16,185,129,0.08))]" />
      </div>

      <div className="relative flex w-full max-w-3xl flex-col gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="size-20 shrink-0 overflow-hidden rounded-2xl border border-white/80 bg-background shadow-[0_18px_42px_rgba(15,23,42,0.16)] ring-1 ring-border/70 sm:size-24">
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
