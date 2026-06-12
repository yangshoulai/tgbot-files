import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Download, Maximize, Maximize2, Minimize, Minimize2 } from "lucide-react";
import type { FileItem } from "../../api";
import { fileKind, formatBytes, previewKind } from "../../utils";
import {
  hasFileLinkAccess,
  TEXT_PREVIEW_MAX_BYTES
} from "../../lib/file-access";
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
import { UnsupportedPreview } from "./preview/UnsupportedPreview";
import type { TextPreviewState } from "./preview/types";

const TEXT_PREVIEW_TIMEOUT_MS = 30_000;

interface PreviewDialogProps {
  file: FileItem | null;
  onClose: () => void;
  onCopy: (value: string) => void;
  onAcceleratedDownload?: (file: FileItem) => void;
  videoPreviewCacheBytes: number;
  videoPreviewConcurrency: number;
}

export function PreviewDialog({ file, onClose, onCopy, onAcceleratedDownload, videoPreviewCacheBytes, videoPreviewConcurrency }: PreviewDialogProps) {
  const preview = file ? previewKind(file) : null;
  const kind = file ? fileKind(file) : null;
  const fullscreenTargetRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [textState, setTextState] = useState<TextPreviewState>({ status: "idle", content: "" });

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

    if (!hasFileLinkAccess(file)) {
      setTextState({
        status: "error",
        content: "",
        message: "该文件不提供完整访问链接，无法直接读取文本预览"
      });
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), TEXT_PREVIEW_TIMEOUT_MS);
    setTextState({ status: "loading", content: "" });

    fetch(file.file_path, { signal: controller.signal })
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
  }, [file, preview]);

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
      open
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
      bodyClassName={maximized ? "flex bg-background/40" : "bg-background/40"}
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
          {preview === "image" ? (
            <ImagePreview file={file} fullscreen={maximized || nativeFullscreen} />
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
          ) : preview === "audio" ? (
            <AudioPreview
              file={file}
              fullscreen={maximized || nativeFullscreen}
              onToggleMaximized={toggleMaximized}
              nativeFullscreen={nativeFullscreen}
              onToggleNativeFullscreen={toggleNativeFullscreen}
            />
          ) : preview === "text" ? (
            <TextPreview file={file} state={textState} fullscreen={maximized || nativeFullscreen} />
          ) : preview === "markdown" ? (
            <MarkdownPreview state={textState} fullscreen={maximized || nativeFullscreen} />
          ) : (
            <UnsupportedPreview file={file} />
          )}
        </PreviewFrame>
      </div>
    </Modal>
  );
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
