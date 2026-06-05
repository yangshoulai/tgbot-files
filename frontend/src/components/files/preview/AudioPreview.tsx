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
    <div className={cn("flex w-full items-center justify-center overflow-hidden bg-[#07110f] p-3 text-white sm:p-4", fullscreen ? "h-full" : "min-h-[28rem] sm:h-[64vh]") }>
      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.04))] p-4 shadow-dialog backdrop-blur sm:rounded-[1.75rem] sm:p-5">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            aria-hidden
            onError={() => setCoverFailed(true)}
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-20 blur-2xl"
          />
        ) : (
          <div className="absolute inset-x-8 top-8 h-24 rounded-full bg-primary/20 blur-3xl" />
        )}
        <div className="relative grid gap-5 md:grid-cols-[minmax(12rem,18rem)_1fr] md:items-center">
          <div className="mx-auto w-full max-w-64 md:max-w-none">
            <div className="aspect-square overflow-hidden rounded-[1.35rem] border border-white/10 bg-black/25 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={`${file.file_name} 封面`}
                  onError={() => setCoverFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="grid h-full w-full place-items-center bg-white/10 text-primary">
                  <Music2 size={54} />
                </span>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <div className="min-w-0 text-center md:text-left">
              <p className="truncate text-lg font-semibold sm:text-xl" title={file.file_name}>{file.file_name}</p>
              <p className="mt-1 text-sm text-white/60">{formatBytes(file.size)} · {file.mime_type}</p>
            </div>

            {!coverUrl ? <WaveBars /> : null}

            {loading ? (
              <div className="inline-flex w-fit items-center gap-2 self-center rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-medium text-white/75 md:self-start">
                <Spinner size={15} className="text-white" />
                音频加载中…
              </div>
            ) : null}

            {failed ? (
              <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-soft">
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
            <MediaControls mediaRef={audioRef} fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

function WaveBars() {
  const heights = [34, 52, 28, 66, 44, 74, 38, 58, 30, 70, 48, 62, 36, 54, 42, 68, 32, 50, 40, 60, 30, 46, 36, 56];
  return (
    <div className="flex h-28 items-center justify-center gap-1.5 rounded-2xl border border-white/10 bg-black/20 px-4">
      {heights.map((height, index) => (
        <span
          key={`${height}-${index}`}
          className="w-1.5 rounded-full bg-gradient-to-t from-primary/40 to-white/80"
          style={{ height }}
        />
      ))}
    </div>
  );
}
