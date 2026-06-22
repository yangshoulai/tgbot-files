import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Maximize, Maximize2, Minimize, Minimize2 } from "lucide-react";
import type { FileItem } from "../../api";
import { fileKind, formatBytes, previewKind } from "../../utils";
import {
  hasFileLinkAccess,
  TEXT_PREVIEW_MAX_BYTES
} from "../../lib/file-access";
import {
  buildAutomaticFileCacheUrl,
  buildFileCacheMetadata,
  startPreviewFileCache,
  stopPreviewFileCache
} from "../../lib/file-cache";
import {
  ensureVideoPreviewServiceWorker,
  isVideoPreviewServiceWorkerControlling
} from "../../lib/video-preview-service-worker";
import { cn } from "../../lib/cn";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { FileVisual } from "../ui/FileVisual";
import { PreviewFrame } from "./preview/PreviewFrame";
import { ImagePreview } from "./preview/ImagePreview";
import { VideoPreview } from "./preview/VideoPreview";
import { AudioPreview } from "./preview/AudioPreview";
import { TextPreview } from "./preview/TextPreview";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import { PdfPreview } from "./preview/PdfPreview";
import { OfficePreview } from "./preview/OfficePreview";
import { UnsupportedPreview } from "./preview/UnsupportedPreview";
import { PreviewError, PreviewLoading } from "./preview/PreviewFrame";
import type { TextPreviewState } from "./preview/types";

const TEXT_PREVIEW_TIMEOUT_MS = 30_000;

interface PreviewDialogProps {
  file: FileItem | null;
  minimized?: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onCopy: (value: string) => void;
  onAcceleratedDownload?: (file: FileItem) => void;
  videoPreviewCacheBytes: number;
  videoPreviewConcurrency: number;
}

export function PreviewDialog({
  file,
  minimized = false,
  onClose,
  onMinimize,
  onCopy,
  onAcceleratedDownload,
  videoPreviewCacheBytes,
  videoPreviewConcurrency
}: PreviewDialogProps) {
  const preview = file ? previewKind(file) : null;
  const kind = file ? fileKind(file) : null;
  const fullscreenTargetRef = useRef<HTMLDivElement>(null);
  const previewCacheSessionIdRef = useRef<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [textState, setTextState] = useState<TextPreviewState>({ status: "idle", content: "" });
  const [serviceWorkerState, setServiceWorkerState] = useState<FilePreviewServiceWorkerState>(initialFilePreviewServiceWorkerState);
  const cachePreviewUrl = useMemo(
    () => file ? buildAutomaticFileCacheUrl(file, videoPreviewCacheBytes) : null,
    [
      file?.chunk_count,
      file?.chunk_size,
      file?.directory_path,
      file?.file_name,
      file?.file_path,
      file?.hls_download?.part_count,
      file?.hls_download?.segment_count,
      file?.id,
      file?.mime_type,
      file?.size,
      file?.storage_backend,
      file?.url,
      videoPreviewCacheBytes
    ]
  );
  const previewCacheMetadata = useMemo(
    () => file && preview && preview !== "video"
      ? buildFileCacheMetadata(file, videoPreviewCacheBytes, "auto")
      : null,
    [
      file?.chunk_count,
      file?.chunk_size,
      file?.directory_path,
      file?.file_name,
      file?.file_path,
      file?.hls_download?.part_count,
      file?.hls_download?.segment_count,
      file?.id,
      file?.mime_type,
      file?.size,
      file?.storage_backend,
      file?.url,
      preview,
      videoPreviewCacheBytes
    ]
  );
  const needsFileCachePreview = Boolean(preview && preview !== "video");
  const serviceWorkerReady = !needsFileCachePreview || serviceWorkerState.status === "controlled";
  const fileCachePreviewMessage = needsFileCachePreview
    ? filePreviewUnavailableMessage({
      hasPreviewUrl: Boolean(cachePreviewUrl),
      serviceWorkerState
    })
    : null;
  const fileCachePreviewChecking = needsFileCachePreview && serviceWorkerState.status === "checking";
  const fileCachePreviewError = fileCachePreviewChecking ? null : fileCachePreviewMessage;

  useEffect(() => {
    if (!file || !preview || preview === "video") {
      return;
    }

    let disposed = false;

    async function refreshServiceWorker() {
      if (isVideoPreviewServiceWorkerControlling()) {
        setServiceWorkerState({ status: "controlled" });
      } else {
        setServiceWorkerState({ status: "checking" });
      }

      const result = await ensureVideoPreviewServiceWorker();
      if (disposed) return;

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
    }

    void refreshServiceWorker();

    // 新版本 SW 接管（controllerchange）时清除"未接管"提示，避免部署后停留在需手动刷新的状态。
    const onControllerChange = () => {
      if (!disposed && isVideoPreviewServiceWorkerControlling()) {
        setServiceWorkerState({ status: "controlled" });
      }
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    }

    return () => {
      disposed = true;
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      }
    };
  }, [file?.id, preview]);

  useEffect(() => {
    if (!file || !preview || preview === "video" || !previewCacheMetadata || !serviceWorkerReady) {
      return;
    }

    const sessionId = `file-preview-${file.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    previewCacheSessionIdRef.current = sessionId;
    void startPreviewFileCache(sessionId, previewCacheMetadata).catch((error: unknown) => {
      console.warn("文件预览缓存启动失败", error);
    });

    return () => {
      if (previewCacheSessionIdRef.current === sessionId) {
        previewCacheSessionIdRef.current = null;
      }
      void stopPreviewFileCache(sessionId).catch((error: unknown) => {
        console.warn("文件预览缓存停止失败", error);
      });
    };
  }, [file?.id, preview, previewCacheMetadata, serviceWorkerReady]);

  useEffect(() => {
    if (!file || (preview !== "text" && preview !== "markdown")) {
      setTextState({ status: "idle", content: "" });
      return;
    }

    if (file.size > TEXT_PREVIEW_MAX_BYTES) {
      setTextState({
        status: "error",
        content: "",
        message: `文本文件超过 ${formatBytes(TEXT_PREVIEW_MAX_BYTES)}，请下载后查看`
      });
      return;
    }

    if (!cachePreviewUrl) {
      setTextState({
        status: "error",
        content: "",
        message: "该文件缺少可代理的访问链接，无法通过缓存代理读取文本预览"
      });
      return;
    }

    if (!serviceWorkerReady) {
      setTextState({
        status: "error",
        content: "",
        message: fileCachePreviewMessage || "Service Worker 尚未接管当前页面，请刷新后再预览"
      });
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), TEXT_PREVIEW_TIMEOUT_MS);
    setTextState({ status: "loading", content: "" });

    fetch(cachePreviewUrl, {
      credentials: "include",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(response.statusText || "读取预览内容失败");
        }

        return response.text();
      })
      .then((content) => {
        if (!controller.signal.aborted) {
          window.clearTimeout(timeout);
          setTextState({ status: "ready", content });
        }
      })
      .catch((error: unknown) => {
        window.clearTimeout(timeout);
        if (controller.signal.aborted && controller.signal.reason !== "timeout") return;
        setTextState({
          status: "error",
          content: "",
          message: controller.signal.reason === "timeout"
            ? "读取预览内容超时，请检查网络后重试"
            : error instanceof Error ? error.message : "读取预览内容失败"
        });
      });

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [cachePreviewUrl, file, fileCachePreviewMessage, preview, serviceWorkerReady]);

  useEffect(() => {
    if (!file || preview !== "office" || !cachePreviewUrl || !serviceWorkerReady) return;

    const controller = new AbortController();
    fetch(cachePreviewUrl, {
      credentials: "include",
      signal: controller.signal
    }).catch(() => undefined);

    return () => controller.abort();
  }, [cachePreviewUrl, file, preview, serviceWorkerReady]);

  useEffect(() => {
    setMaximized(false);
    setNativeFullscreen(false);
  }, [file?.id]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setNativeFullscreen(document.fullscreenElement === fullscreenTargetRef.current);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    onFullscreenChange();

    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleNativeFullscreen = useCallback(() => {
    const target = fullscreenTargetRef.current;
    if (!target) return;

    if (document.fullscreenElement === target) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }

    void target.requestFullscreen().catch(() => undefined);
  }, []);

  const closePreview = useCallback(() => {
    if (document.fullscreenElement === fullscreenTargetRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose]);

  const minimizePreview = useCallback(() => {
    if (document.fullscreenElement === fullscreenTargetRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onMinimize();
  }, [onMinimize]);

  if (!file || !kind) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const linkFile = hasFileLinkAccess(file) ? file : null;
  const canAccelerateDownload = Boolean(onAcceleratedDownload);
  const canCopyContent = (preview === "text" || preview === "markdown") && textState.status === "ready";
  const isMediaPreview = preview === "video" || preview === "audio";
  const toggleMaximized = () => setMaximized((value) => !value);

  return (
    <Modal
      open={!minimized}
      onClose={closePreview}
      size={maximized ? "full" : "xl"}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <FileVisual
            mimeType={file.mime_type}
            fileName={file.file_name}
            url={linkFile ? file.file_path : undefined}
            thumbnailUrl={file.thumbnail_url}
            size="sm"
          />
          <span className="min-w-0 truncate" title={file.file_name}>{file.file_name}</span>
        </span>
      }
      description={
        <span className="inline-flex min-w-0 items-center gap-2">
          <Badge tone={badgeTone(kind.tone)} size="sm">
            {kind.label}
          </Badge>
          <span className="truncate">
            {formatBytes(file.size)} · {file.mime_type || "未知 MIME"}
          </span>
        </span>
      }
      footer={
        <>
          {preview === "text" || preview === "markdown" ? (
            <Button
              variant="secondary"
              leadingIcon={<Copy size={15} />}
              onClick={() => canCopyContent && onCopy(textState.content)}
              disabled={!canCopyContent}
            >
              复制内容
            </Button>
          ) : null}
          {!isMediaPreview ? (
            <Button
              variant="secondary"
              leadingIcon={maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              onClick={toggleMaximized}
            >
              {maximized ? "还原" : "最大化"}
            </Button>
          ) : null}
          {!isMediaPreview ? (
            <Button
              variant="secondary"
              leadingIcon={nativeFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
              onClick={toggleNativeFullscreen}
            >
              {nativeFullscreen ? "退出全屏" : "进入全屏"}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            leadingIcon={<Minimize size={15} />}
            onClick={minimizePreview}
          >
            最小化
          </Button>
          {canAccelerateDownload ? (
            <Button
              variant="primary"
              leadingIcon={<Download size={15} />}
              onClick={() => onAcceleratedDownload?.(file)}
            >
              加速下载
            </Button>
          ) : null}
        </>
      }
      bodyClassName={cn(
        "bg-background/40",
        maximized && "flex",
        (isMediaPreview || preview === "image") && "!overflow-hidden"
      )}
    >
      <div ref={fullscreenTargetRef} className="relative flex min-h-0 w-full bg-background">
        {nativeFullscreen && !isMediaPreview ? (
          <button
            type="button"
            onClick={toggleNativeFullscreen}
            className="absolute right-4 top-4 z-30 inline-flex h-9 items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-3 text-xs font-medium text-white shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur-md transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:focus-ring"
            aria-label="退出全屏"
          >
            <Minimize size={14} />
            退出全屏
          </button>
        ) : null}
        <PreviewFrame fullscreen={maximized || nativeFullscreen} tone={previewTone(preview)} className={nativeFullscreen ? "h-screen rounded-none border-0" : undefined}>
          {fileCachePreviewChecking ? (
            <PreviewLoading label="正在准备缓存代理…" dark={preview === "audio"} />
          ) : fileCachePreviewError ? (
            <PreviewError message={fileCachePreviewError} dark={preview === "audio"} />
          ) : preview === "image" && cachePreviewUrl ? (
            <ImagePreview file={file} fullscreen={maximized || nativeFullscreen} previewUrl={cachePreviewUrl} />
          ) : preview === "video" ? (
            <VideoPreview
              file={file}
              maximized={maximized || nativeFullscreen}
              onToggleMaximized={toggleMaximized}
              nativeFullscreen={nativeFullscreen}
              onToggleNativeFullscreen={toggleNativeFullscreen}
              videoPreviewCacheBytes={videoPreviewCacheBytes}
              videoPreviewConcurrency={videoPreviewConcurrency}
            />
          ) : preview === "audio" && cachePreviewUrl ? (
            <AudioPreview
              file={file}
              fullscreen={maximized || nativeFullscreen}
              previewUrl={cachePreviewUrl}
              cacheMaxBytes={videoPreviewCacheBytes}
              onToggleMaximized={toggleMaximized}
              nativeFullscreen={nativeFullscreen}
              onToggleNativeFullscreen={toggleNativeFullscreen}
            />
          ) : preview === "text" ? (
            <TextPreview file={file} state={textState} fullscreen={maximized || nativeFullscreen} />
          ) : preview === "markdown" ? (
            <MarkdownPreview state={textState} fullscreen={maximized || nativeFullscreen} />
          ) : preview === "pdf" && cachePreviewUrl ? (
            <PdfPreview file={file} fullscreen={maximized || nativeFullscreen} previewUrl={cachePreviewUrl} />
          ) : preview === "office" ? (
            <OfficePreview file={file} fullscreen={maximized || nativeFullscreen} />
          ) : (
            <UnsupportedPreview file={file} />
          )}
        </PreviewFrame>
      </div>
    </Modal>
  );
}

type FilePreviewServiceWorkerState = {
  status: "checking" | "controlled" | "need-reload" | "unsupported" | "failed";
  message?: string;
};

function initialFilePreviewServiceWorkerState(): FilePreviewServiceWorkerState {
  return isVideoPreviewServiceWorkerControlling() ? { status: "controlled" } : { status: "checking" };
}

function filePreviewUnavailableMessage({
  hasPreviewUrl,
  serviceWorkerState
}: {
  hasPreviewUrl: boolean;
  serviceWorkerState: FilePreviewServiceWorkerState;
}): string | null {
  if (!hasPreviewUrl) return "该文件缺少可代理的访问链接，无法通过缓存代理预览。";
  if (serviceWorkerState.status === "controlled") return null;
  if (serviceWorkerState.status === "checking") return "正在注册并等待 Service Worker 接管页面；如果长时间没有变化，请刷新页面后再预览。";
  if (serviceWorkerState.status === "need-reload") {
    return serviceWorkerState.message ? `${serviceWorkerState.message}，请刷新页面后再预览。` : "Service Worker 已注册，但当前页面还没有被它接管，请刷新页面后再预览。";
  }
  if (serviceWorkerState.status === "unsupported") return serviceWorkerState.message || "当前浏览器不支持 Service Worker，无法通过缓存代理预览该文件。";
  if (serviceWorkerState.status === "failed") return serviceWorkerState.message ? `Service Worker 注册或激活失败：${serviceWorkerState.message}` : "Service Worker 注册或激活失败，无法接管文件预览请求。";
  return "Service Worker 尚未接管当前页面，请刷新页面后再预览。";
}

function previewTone(preview: ReturnType<typeof previewKind>): "surface" | "dark" | "code" {
  if (preview === "video") return "dark";
  if (preview === "text" || preview === "markdown") return "code";
  return "surface";
}

function badgeTone(tone: ReturnType<typeof fileKind>["tone"]): "success" | "danger" | "info" | "warning" | "neutral" {
  switch (tone) {
    case "image":
    case "video":
      return "success";
    case "audio":
    case "text":
      return "info";
    case "pdf":
      return "danger";
    case "archive":
      return "warning";
    default:
      return "neutral";
  }
}
