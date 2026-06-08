import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { RotateCcw } from "lucide-react";
import { listFiles, type FileItem } from "../../../api";
import { canUseAcceleratedDownload, extractSignedFileToken } from "../../../lib/accelerated-download";
import { hasFileLinkAccess } from "../../../lib/file-access";
import {
  VIDEO_PREVIEW_CACHE_HEARTBEAT_MS,
  buildChunkedVideoPreviewMetadata,
  buildChunkedVideoPreviewUrl,
  startChunkedVideoPreviewCacheSession,
  stopChunkedVideoPreviewCacheSession
} from "../../../lib/video-preview";
import {
  ensureVideoPreviewServiceWorker,
  isVideoPreviewServiceWorkerControlling
} from "../../../lib/video-preview-service-worker";
import { cn } from "../../../lib/cn";
import { Button } from "../../ui/Button";
import { Spinner } from "../../ui/Spinner";
import { MediaControls, type MediaSubtitleOption } from "./MediaControls";

interface VideoPreviewProps {
  file: FileItem;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

const VIDEO_PREVIEW_TIMEOUT_MS = 30_000;
const VIDEO_CONTROLS_HIDE_DELAY_MS = 1_800;
const VIDEO_LOADING_INDICATOR_DELAY_MS = 360;
const SUBTITLE_PREVIEW_TIMEOUT_MS = 20_000;

export function VideoPreview({ file, fullscreen, onToggleFullscreen }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);
  const previewCacheSessionIdRef = useRef(`video-preview-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [ratio, setRatio] = useState(() => initialAspectRatio(file));
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsDensity, setControlsDensity] = useState<MediaControlsDensity>("regular");
  const [serviceWorkerState, setServiceWorkerState] = useState<VideoPreviewServiceWorkerState>(initialVideoPreviewServiceWorkerState);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [subtitleTracks, setSubtitleTracks] = useState<LoadedSubtitleTrack[]>([]);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null);
  const heightLimit = fullscreen ? "calc(100dvh - 9rem)" : "min(68dvh, 760px)";
  const linkFile = hasFileLinkAccess(file) ? file : null;
  const isHlsPackage = file.storage_backend === "hls_package";
  const directAccessAvailable = Boolean(linkFile);
  const canUseMultipartPreview = canUseAcceleratedDownload(file);
  const signedFileToken = canUseMultipartPreview ? extractSignedFileToken(file.file_path) : null;
  const serviceWorkerReady = serviceWorkerState.status === "controlled";
  const requiresChunkedPreview = !directAccessAvailable && canUseMultipartPreview && Boolean(signedFileToken);
  const chunkedPreviewMetadata = useMemo(
    () => serviceWorkerReady ? buildChunkedVideoPreviewMetadata(file) : null,
    [file.chunk_count, file.chunk_size, file.file_path, file.id, file.mime_type, file.size, file.storage_backend, serviceWorkerReady]
  );
  const chunkedPreviewUrl = chunkedPreviewMetadata ? buildChunkedVideoPreviewUrl(file, chunkedPreviewMetadata) : null;
  const videoSrc = chunkedPreviewUrl ?? (linkFile ? file.file_path : null);
  const poster = file.thumbnail_url || undefined;
  const subtitleOptions = useMemo<MediaSubtitleOption[]>(
    () => subtitleTracks.map((track) => ({ id: track.id, label: track.label })),
    [subtitleTracks]
  );

  useEffect(() => {
    setRatio(initialAspectRatio(file));
  }, [file.id, file.thumbnail_height, file.thumbnail_width]);

  const refreshServiceWorker = useCallback(async () => {
    if (isVideoPreviewServiceWorkerControlling()) {
      setServiceWorkerState({ status: "controlled" });
      return;
    }

    setServiceWorkerState({ status: "checking" });
    const result = await ensureVideoPreviewServiceWorker();

    if (result.controlled) {
      setServiceWorkerState({ status: "controlled" });
      return;
    }

    if (!result.supported) {
      setServiceWorkerState({ status: "unsupported", message: result.error || "当前浏览器不支持 Service Worker" });
      return;
    }

    if (!result.registered) {
      setServiceWorkerState({ status: "failed", message: result.error || "Service Worker 注册失败" });
      return;
    }

    setServiceWorkerState({ status: "need-reload", message: "Service Worker 已注册，但当前页面还没有被它接管" });
  }, []);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const showControls = useCallback(() => {
    clearControlsHideTimer();
    setControlsVisible(true);
  }, [clearControlsHideTimer]);

  const scheduleControlsHide = useCallback((delay = VIDEO_CONTROLS_HIDE_DELAY_MS) => {
    clearControlsHideTimer();
    controlsHideTimerRef.current = window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (activeElement && frameRef.current?.contains(activeElement)) {
        setControlsVisible(true);
        controlsHideTimerRef.current = null;
        return;
      }

      setControlsVisible(false);
      controlsHideTimerRef.current = null;
    }, delay);
  }, [clearControlsHideTimer]);

  const clearLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current === null) return;
    window.clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = null;
  }, []);

  const showLoading = useCallback((immediate = false) => {
    clearLoadingTimer();

    if (immediate) {
      setLoading(true);
      return;
    }

    loadingTimerRef.current = window.setTimeout(() => {
      setLoading(true);
      loadingTimerRef.current = null;
    }, VIDEO_LOADING_INDICATOR_DELAY_MS);
  }, [clearLoadingTimer]);

  const hideLoading = useCallback(() => {
    clearLoadingTimer();
    setLoading(false);
  }, [clearLoadingTimer]);

  useEffect(() => {
    if (videoSrc) {
      showLoading(true);
    } else {
      hideLoading();
    }
    setFailed(false);
  }, [file.id, hideLoading, showLoading, videoSrc]);

  useEffect(() => {
    setControlsVisible(true);
    clearControlsHideTimer();
  }, [clearControlsHideTimer, file.id]);

  useEffect(() => {
    return () => {
      clearControlsHideTimer();
      clearLoadingTimer();
    };
  }, [clearControlsHideTimer, clearLoadingTimer]);

  useEffect(() => {
    const frame = frameRef.current;

    const updateDensity = () => {
      const frameWidth = frame?.clientWidth ?? 0;
      setControlsDensity(controlsDensityForFrame(frameWidth, ratio.value));
    };

    updateDensity();

    if (!frame || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(updateDensity);
    observer.observe(frame);

    return () => observer.disconnect();
  }, [ratio.value]);

  useEffect(() => {
    if (!loading || failed || !videoSrc) return;

    const timeout = window.setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, VIDEO_PREVIEW_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [failed, loading, videoSrc]);

  useEffect(() => {
    if (!requiresChunkedPreview) return;

    if (!("serviceWorker" in navigator)) {
      void refreshServiceWorker();
      return;
    }

    let disposed = false;
    const refresh = () => {
      if (!disposed) {
        setServiceWorkerState(isVideoPreviewServiceWorkerControlling() ? { status: "controlled" } : { status: "checking" });
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", refresh);
    void refreshServiceWorker();
    refresh();

    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener("controllerchange", refresh);
    };
  }, [refreshServiceWorker, requiresChunkedPreview]);

  useEffect(() => {
    if (!chunkedPreviewMetadata || !chunkedPreviewUrl) return;

    const sessionId = previewCacheSessionIdRef.current;
    const keepAlivePreviewCache = () => {
      startChunkedVideoPreviewCacheSession(sessionId, chunkedPreviewMetadata);
    };

    keepAlivePreviewCache();
    const heartbeatId = window.setInterval(keepAlivePreviewCache, VIDEO_PREVIEW_CACHE_HEARTBEAT_MS);

    return () => {
      window.clearInterval(heartbeatId);
      stopChunkedVideoPreviewCacheSession(sessionId);
    };
  }, [chunkedPreviewMetadata, chunkedPreviewUrl]);

  useEffect(() => {
    let disposed = false;
    const subtitleObjectUrls: string[] = [];
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SUBTITLE_PREVIEW_TIMEOUT_MS);

    setSubtitleTracks([]);
    setSelectedSubtitleId(null);

    async function loadSubtitleTracks() {
      const stem = fileStem(file.file_name);
      if (!stem) return;

      const result = await listFiles({
        q: stem,
        dir: file.directory_path || "/",
        limit: "all",
        type: "all"
      });
      if (disposed) return;

      const subtitleFiles = matchingSubtitleFiles(result.files, file);
      const loaded = (await Promise.all(subtitleFiles.map((subtitle) => loadSubtitleFile(subtitle, file.file_name, controller.signal))))
        .filter((track): track is LoadedSubtitleTrack => Boolean(track));
      if (loaded.length === 0) return;

      subtitleObjectUrls.push(...loaded.map((track) => track.src));
      if (disposed) return;
      setSubtitleTracks(loaded);
      setSelectedSubtitleId((current) => {
        if (current && loaded.some((track) => track.id === current)) {
          return current;
        }
        return loaded.length === 1 ? loaded[0]?.id ?? null : null;
      });
    }

    void loadSubtitleTracks()
      .catch(() => {
        if (!disposed) {
          setSubtitleTracks([]);
          setSelectedSubtitleId(null);
        }
      })
      .finally(() => window.clearTimeout(timeoutId));

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      controller.abort();
      subtitleObjectUrls.forEach((src) => URL.revokeObjectURL(src));
    };
  }, [file.directory_path, file.file_name, file.id]);

  useEffect(() => {
    if (!videoRef.current) return undefined;

    const video = videoRef.current;
    const timerId = window.setTimeout(() => {
      Array.from(video.textTracks).forEach((track) => {
        track.mode = selectedSubtitleId && track.kind === "subtitles" && track.id === selectedSubtitleId
          ? "showing"
          : "disabled";
      });
    });

    return () => window.clearTimeout(timerId);
  }, [selectedSubtitleId, subtitleTracks]);

  useEffect(() => {
    if (!isHlsPackage || !videoSrc || !videoRef.current) return undefined;

    const video = videoRef.current;
    let hls: Hls | null = null;

    showLoading(true);
    setFailed(false);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = videoSrc;
      video.load();
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      hideLoading();
      setFailed(true);
      return undefined;
    }

    hls = new Hls({
      xhrSetup(xhr) {
        xhr.withCredentials = true;
      }
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        hideLoading();
        setFailed(true);
      }
    });
    hls.loadSource(videoSrc);
    hls.attachMedia(video);

    return () => {
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [file.id, hideLoading, isHlsPackage, showLoading, videoSrc]);

  if (!videoSrc) {
    return (
      <div className="grid w-full place-items-center bg-[radial-gradient(circle_at_18%_0%,rgba(16,185,129,0.16),transparent_34%),linear-gradient(135deg,#07110f,#101827_58%,#030712)] px-6 py-12 text-center text-white">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/[0.07] px-6 py-5 shadow-[0_24px_70px_rgba(0,0,0,0.36)] ring-1 ring-white/[0.08] backdrop-blur-xl">
          <p className="text-sm font-semibold">该视频暂时无法直接预览</p>
          <p className="mt-2 text-xs leading-6 text-white/65">
            {videoPreviewUnavailableMessage({ canUseMultipartPreview, hasSignedFileToken: Boolean(signedFileToken), serviceWorkerState })}
          </p>
          {requiresChunkedPreview ? (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button variant="secondary" leadingIcon={<RotateCcw size={15} />} onClick={() => void refreshServiceWorker()}>
                重新检查
              </Button>
              {serviceWorkerState.status === "need-reload" ? (
                <Button onClick={() => window.location.reload()}>刷新页面</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_16%_0%,rgba(16,185,129,0.2),transparent_32%),linear-gradient(135deg,#07110f_0%,#101827_58%,#030712_100%)] px-2 py-3 sm:px-5 sm:py-5",
        fullscreen ? "h-full min-h-0" : "min-h-56"
      )}
    >
      <div
        ref={frameRef}
        className="relative isolate max-h-full max-w-full overflow-hidden bg-[#020403] shadow-[0_28px_90px_rgba(0,0,0,0.42)] ring-1 ring-white/12 sm:rounded-[1rem]"
        style={{
          aspectRatio: ratio.label.replace(":", " / "),
          width: `min(100%, calc(${heightLimit} * ${ratio.value}))`
        }}
        onPointerEnter={showControls}
        onPointerMove={showControls}
        onPointerLeave={() => scheduleControlsHide()}
        onTouchStart={() => {
          showControls();
          scheduleControlsHide(3_000);
        }}
        onFocusCapture={showControls}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
            scheduleControlsHide();
          }
        }}
      >
        <video
          ref={videoRef}
          src={isHlsPackage ? undefined : videoSrc ?? undefined}
          poster={poster}
          playsInline
          preload="auto"
          className="h-full w-full bg-[#020403] object-contain"
          onLoadStart={() => showLoading(true)}
          onWaiting={() => showLoading()}
          onSeeking={() => showLoading()}
          onLoadedData={() => {
            hideLoading();
            setFailed(false);
          }}
          onCanPlay={() => {
            hideLoading();
            setFailed(false);
          }}
          onPlaying={() => {
            hideLoading();
            setFailed(false);
          }}
          onSeeked={(event) => {
            if (event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              hideLoading();
              setFailed(false);
            }
          }}
          onError={() => {
            hideLoading();
            setFailed(true);
          }}
          onLoadedMetadata={(event) => {
            const target = event.currentTarget;
            setFailed(false);
            if (target.videoWidth > 0 && target.videoHeight > 0) {
              setRatio(toAspectRatio(target.videoWidth, target.videoHeight));
            }
          }}
        >
          {subtitleTracks.map((track) => (
            <track
              key={track.id}
              id={track.id}
              kind="subtitles"
              src={track.src}
              srcLang={track.language || "und"}
              label={track.label}
              default={track.id === selectedSubtitleId}
            />
          ))}
          当前浏览器不支持该视频预览。
        </video>

        {loading ? (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#020403]/35 text-white backdrop-blur-[2px]">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/10 px-4 py-2 text-sm font-medium shadow-[0_16px_44px_rgba(0,0,0,0.38)] backdrop-blur-xl">
              <Spinner size={18} className="text-white" />
              视频加载中…
            </div>
          </div>
        ) : null}

        {failed ? (
          <div className="absolute inset-x-4 top-4 z-20 rounded-xl border border-danger/30 bg-danger/20 px-3 py-2 text-sm text-white shadow-[0_18px_44px_rgba(0,0,0,0.35)] backdrop-blur-xl">
            视频加载失败，请尝试下载后播放。
          </div>
        ) : null}

        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/82 via-black/30 to-transparent px-2 pb-2 pt-16 transition-all duration-200 ease-out sm:px-4 sm:pb-4 sm:pt-24",
            controlsVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
          )}
        >
          <MediaControls
            mediaRef={videoRef}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
            variant="floating"
            density={controlsDensity}
            interactive={controlsVisible}
            subtitles={subtitleOptions}
            selectedSubtitleId={selectedSubtitleId}
            onSubtitleChange={setSelectedSubtitleId}
          />
        </div>
      </div>
    </div>
  );
}

type MediaControlsDensity = "regular" | "narrow" | "tiny";

interface LoadedSubtitleTrack {
  id: string;
  src: string;
  label: string;
  language?: string;
}

type VideoPreviewServiceWorkerState = {
  status: "checking" | "controlled" | "need-reload" | "unsupported" | "failed";
  message?: string;
};

function initialVideoPreviewServiceWorkerState(): VideoPreviewServiceWorkerState {
  return isVideoPreviewServiceWorkerControlling() ? { status: "controlled" } : { status: "checking" };
}

function videoPreviewUnavailableMessage({
  canUseMultipartPreview,
  hasSignedFileToken,
  serviceWorkerState
}: {
  canUseMultipartPreview: boolean;
  hasSignedFileToken: boolean;
  serviceWorkerState: VideoPreviewServiceWorkerState;
}): string {
  if (!canUseMultipartPreview) return "该视频缺少分片下载元数据，无法通过分片代理进行预览。";
  if (!hasSignedFileToken) return "该视频缺少签名访问令牌，无法生成分片预览地址。";
  if (serviceWorkerState.status === "checking") return "正在注册并等待 Service Worker 接管页面；如果长时间没有变化，请点击“重新检查”。";
  if (serviceWorkerState.status === "need-reload") {
    return serviceWorkerState.message ? `${serviceWorkerState.message}，请点击“刷新页面”后再预览。` : "Service Worker 已注册，但当前页面还没有被它接管，请点击“刷新页面”后再预览。";
  }
  if (serviceWorkerState.status === "unsupported") return serviceWorkerState.message || "当前浏览器不支持 Service Worker，无法预览超过直链上限的视频。";
  if (serviceWorkerState.status === "failed") return serviceWorkerState.message ? `Service Worker 注册或激活失败：${serviceWorkerState.message}` : "Service Worker 注册或激活失败，无法接管分片预览请求。";
  return "Service Worker 已接管页面，但分片预览地址未生成，请重新打开预览窗口。";
}

async function loadSubtitleFile(
  subtitle: FileItem,
  videoFileName: string,
  signal: AbortSignal
): Promise<LoadedSubtitleTrack | null> {
  if (!hasFileLinkAccess(subtitle)) return null;

  const extension = subtitleExtension(subtitle.file_name);
  if (!extension) return null;

  try {
    const response = await fetch(subtitle.file_path, {
      credentials: "include",
      signal
    });
    if (!response.ok) {
      throw new Error(response.statusText || "字幕读取失败");
    }

    const text = await response.text();
    const webVtt = subtitleTextToWebVtt(text, extension);
    const src = URL.createObjectURL(new Blob([webVtt], { type: "text/vtt" }));
    const language = subtitleLanguageCode(subtitle.file_name, videoFileName);

    return {
      id: `subtitle-${subtitle.id}`,
      src,
      label: subtitleLabel(subtitle.file_name, videoFileName, language, extension),
      ...(language ? { language } : {})
    };
  } catch {
    return null;
  }
}

function matchingSubtitleFiles(files: FileItem[], videoFile: FileItem): FileItem[] {
  const videoStem = fileStem(videoFile.file_name);
  const directoryPath = videoFile.directory_path || "/";

  return files
    .filter((candidate) =>
      candidate.id !== videoFile.id &&
      (candidate.directory_path || "/") === directoryPath &&
      subtitleStemMatchesVideo(candidate.file_name, videoStem) &&
      subtitleExtension(candidate.file_name) !== null
    )
    .sort((left, right) =>
      subtitlePriority(left.file_name, videoFile.file_name) - subtitlePriority(right.file_name, videoFile.file_name) ||
      left.file_name.localeCompare(right.file_name)
    );
}

function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim().toLocaleLowerCase();
}

function subtitleStemMatchesVideo(fileName: string, videoStem: string): boolean {
  const subtitleStem = subtitleFileStem(fileName);
  return subtitleStem === videoStem || subtitleStem.startsWith(`${videoStem}.`);
}

function subtitleFileStem(fileName: string): string {
  return fileName.replace(/\.(?:srt|vtt|webvtt)$/i, "").trim().toLocaleLowerCase();
}

function subtitleExtension(fileName: string): "vtt" | "srt" | null {
  const normalized = fileName.toLocaleLowerCase();
  if (normalized.endsWith(".vtt") || normalized.endsWith(".webvtt")) return "vtt";
  if (normalized.endsWith(".srt")) return "srt";
  return null;
}

function subtitlePriority(fileName: string, videoFileName: string): number {
  const hasLanguageSuffix = Boolean(subtitleLanguageSuffix(fileName, videoFileName));
  const extensionPriority = subtitleExtension(fileName) === "vtt" ? 0 : 1;
  return (hasLanguageSuffix ? 10 : 0) + extensionPriority;
}

function subtitleLabel(
  fileName: string,
  videoFileName: string,
  language: string | undefined,
  extension: "vtt" | "srt"
): string {
  const suffix = subtitleLanguageSuffix(fileName, videoFileName);
  const languageLabel = language ? languageName(language) : suffix ? suffix : "默认字幕";
  return `${languageLabel}（${extension.toUpperCase()}）`;
}

function subtitleLanguageCode(fileName: string, videoFileName: string): string | undefined {
  const suffix = subtitleLanguageSuffix(fileName, videoFileName);
  if (!suffix) return undefined;

  const normalized = suffix.replace(/_/g, "-").toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function subtitleLanguageSuffix(fileName: string, videoFileName: string): string | undefined {
  const videoStem = fileStem(videoFileName);
  const subtitleStem = subtitleFileStem(fileName);
  if (!subtitleStem.startsWith(`${videoStem}.`)) {
    return undefined;
  }

  return subtitleStem.slice(videoStem.length + 1) || undefined;
}

function languageName(language: string): string {
  const normalized = language.toLowerCase();
  const direct: Record<string, string> = {
    "zh": "中文",
    "zh-cn": "简体中文",
    "zh-hans": "简体中文",
    "zh-tw": "繁体中文",
    "zh-hk": "繁体中文",
    "zh-hant": "繁体中文",
    en: "English",
    "en-us": "English",
    "en-gb": "English",
    ja: "日本語",
    jp: "日本語",
    ko: "한국어",
    kr: "한국어",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    ru: "Русский",
    it: "Italiano",
    pt: "Português",
    ar: "العربية",
    hi: "हिन्दी"
  };

  return direct[normalized] ?? language;
}

function subtitleTextToWebVtt(text: string, extension: "vtt" | "srt"): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  if (/^WEBVTT(?:\s|$)/i.test(normalized)) {
    return normalized;
  }

  if (extension === "srt") {
    return `WEBVTT\n\n${normalized.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
  }

  return `WEBVTT\n\n${normalized}`;
}

function toAspectRatio(width: number, height: number): { label: string; value: number } {
  const gcd = greatestCommonDivisor(width, height);
  const normalizedWidth = Math.max(1, Math.round(width / gcd));
  const normalizedHeight = Math.max(1, Math.round(height / gcd));
  return { label: `${normalizedWidth}:${normalizedHeight}`, value: width / height };
}

function initialAspectRatio(file: FileItem): { label: string; value: number } {
  const width = Number(file.thumbnail_width);
  const height = Number(file.thumbnail_height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return toAspectRatio(width, height);
  }

  return { label: "16:9", value: 16 / 9 };
}

function controlsDensityForFrame(width: number, aspectRatio: number): MediaControlsDensity {
  if (width > 0 && width < 330) return "tiny";
  if ((width > 0 && width < 430) || aspectRatio < 0.8) return "narrow";
  return "regular";
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}
