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
  const directFile = hasDirectFileAccess(file) ? file : null;

  useEffect(() => {
    setLoading(true);
    setFailed(false);
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
    <div className={cn("flex w-full items-center justify-center overflow-hidden bg-[#07110f] p-4 text-white", fullscreen ? "h-full" : "h-[64vh]") }>
      <div className="relative grid w-full max-w-4xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_20%_0%,rgba(52,211,153,0.28),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.04))] p-5 shadow-dialog backdrop-blur">
        <div className="absolute inset-x-8 top-8 h-24 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex flex-col gap-6">
          <div className="flex items-start gap-4">
            <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-white/10 text-primary ring-1 ring-white/10">
              <Music2 size={28} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-semibold" title={file.file_name}>{file.file_name}</p>
              <p className="mt-1 text-sm text-white/60">{formatBytes(file.size)} · {file.mime_type}</p>
            </div>
          </div>

          <WaveBars />

          {loading ? (
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-medium text-white/75">
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
