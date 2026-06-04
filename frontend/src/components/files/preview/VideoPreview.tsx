import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { FileItem } from "../../../api";
import { canUseAcceleratedDownload, extractSignedFileToken } from "../../../lib/accelerated-download";
import { hasDirectFileAccess } from "../../../lib/file-access";
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
import { MediaControls } from "./MediaControls";

interface VideoPreviewProps {
  file: FileItem;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

const VIDEO_PREVIEW_TIMEOUT_MS = 30_000;
const VIDEO_CONTROLS_HIDE_DELAY_MS = 1_800;
const VIDEO_LOADING_INDICATOR_DELAY_MS = 360;

export function VideoPreview({ file, fullscreen, onToggleFullscreen }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const loadingTimerRef = useRef<number | null>(null);
  const previewCacheSessionIdRef = useRef(`video-preview-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [ratio, setRatio] = useState({ label: "16:9", value: 16 / 9 });
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsDensity, setControlsDensity] = useState<MediaControlsDensity>("regular");
  const [serviceWorkerState, setServiceWorkerState] = useState<VideoPreviewServiceWorkerState>(initialVideoPreviewServiceWorkerState);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const heightLimit = fullscreen ? "calc(100dvh - 11rem)" : "min(66dvh, 760px)";
  const directFile = hasDirectFileAccess(file) ? file : null;
  const directAccessAvailable = Boolean(directFile);
  const canUseMultipartPreview = canUseAcceleratedDownload(file);
  const signedFileToken = canUseMultipartPreview ? extractSignedFileToken(file.file_path) : null;
  const serviceWorkerReady = serviceWorkerState.status === "controlled";
  const requiresChunkedPreview = !directAccessAvailable && canUseMultipartPreview && Boolean(signedFileToken);
  const chunkedPreviewMetadata = useMemo(
    () => serviceWorkerReady ? buildChunkedVideoPreviewMetadata(file) : null,
    [file.chunk_count, file.chunk_size, file.file_path, file.id, file.mime_type, file.size, file.storage_backend, serviceWorkerReady]
  );
  const chunkedPreviewUrl = chunkedPreviewMetadata ? buildChunkedVideoPreviewUrl(file, chunkedPreviewMetadata) : null;
  const videoSrc = chunkedPreviewUrl ?? (directFile ? file.file_path : null);
  const poster = file.thumbnail_url || undefined;

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

  if (!videoSrc) {
    return (
      <div className="grid w-full place-items-center bg-[#07110f] px-6 py-12 text-center text-white">
        <div className="max-w-md rounded-2xl border border-white/10 bg-white/5 px-6 py-5 shadow-dialog">
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
    <div className={cn("flex w-full items-center justify-center bg-[#07110f] p-3 sm:p-4", fullscreen ? "h-full min-h-0" : "h-[min(66dvh,760px)]") }>
      <div
        ref={frameRef}
        className="relative max-h-full max-w-full overflow-hidden rounded-[1.5rem] bg-black shadow-dialog ring-1 ring-white/10"
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
        {poster ? (
          <img
            src={poster}
            alt="视频缩略图"
            className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-300", loading ? "opacity-70" : "opacity-0")}
            aria-hidden={!loading}
          />
        ) : null}
        <video
          ref={videoRef}
          src={videoSrc}
          poster={poster}
          playsInline
          preload="metadata"
          className="h-full w-full bg-black object-contain"
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
          当前浏览器不支持该视频预览。
        </video>

        {loading ? (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/30 text-white">
            <div className="inline-flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium shadow-card backdrop-blur">
              <Spinner size={18} className="text-white" />
              视频加载中…
            </div>
          </div>
        ) : null}

        {failed ? (
          <div className="absolute inset-x-4 top-4 z-20 rounded-xl border border-danger/30 bg-danger/20 px-3 py-2 text-sm text-white backdrop-blur">
            视频加载失败，请尝试下载后播放。
          </div>
        ) : null}

        <div
          className={cn(
            "absolute bottom-2 left-1/2 z-20 w-[calc(100%-0.75rem)] max-w-[44rem] -translate-x-1/2 transition-all duration-200 ease-out sm:bottom-3 sm:w-[calc(100%-1.5rem)]",
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
          />
        </div>
      </div>
    </div>
  );
}

type MediaControlsDensity = "regular" | "narrow" | "tiny";

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

function toAspectRatio(width: number, height: number): { label: string; value: number } {
  const gcd = greatestCommonDivisor(width, height);
  const normalizedWidth = Math.max(1, Math.round(width / gcd));
  const normalizedHeight = Math.max(1, Math.round(height / gcd));
  return { label: `${normalizedWidth}:${normalizedHeight}`, value: width / height };
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
