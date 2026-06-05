import { useEffect, useState } from "react";
import { Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import type { FileItem } from "../../api";
import { fileKind, formatBytes, previewKind } from "../../utils";
import { hasDirectFileAccess } from "../../lib/file-access";
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
}

export function PreviewDialog({ file, onClose, onCopy }: PreviewDialogProps) {
  const preview = file ? previewKind(file) : null;
  const kind = file ? fileKind(file) : null;
  const [fullscreen, setFullscreen] = useState(false);
  const [textState, setTextState] = useState<TextPreviewState>({ status: "idle", content: "" });

  useEffect(() => {
    if (!file || (preview !== "text" && preview !== "markdown")) {
      setTextState({ status: "idle", content: "" });
      return;
    }

    if (!hasDirectFileAccess(file)) {
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
    setFullscreen(false);
  }, [file?.id]);

  if (!file || !kind) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const directFile = hasDirectFileAccess(file) ? file : null;
  const canCopyContent = (preview === "text" || preview === "markdown") && textState.status === "ready";
  const isMediaPreview = preview === "video" || preview === "audio";
  const toggleFullscreen = () => setFullscreen((value) => !value);

  return (
    <Modal
      open
      onClose={onClose}
      size={fullscreen ? "full" : "xl"}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <FileVisual
            mimeType={file.mime_type}
            fileName={file.file_name}
            url={directFile ? file.file_path : undefined}
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
              leadingIcon={fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              onClick={toggleFullscreen}
            >
              {fullscreen ? "退出全屏" : "全屏"}
            </Button>
          ) : null}
          {directFile ? (
            <a
              href={directFile.download_url}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-white shadow-card transition-colors duration-150 hover:border-primary-strong hover:bg-primary-strong"
            >
              <Download size={15} />
              下载
            </a>
          ) : null}
        </>
      }
      bodyClassName={fullscreen ? "flex bg-background/40" : "bg-background/40"}
    >
      <PreviewFrame fullscreen={fullscreen} tone={previewTone(preview)}>
        {preview === "image" ? (
          <ImagePreview file={file} fullscreen={fullscreen} />
        ) : preview === "video" ? (
          <VideoPreview file={file} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
        ) : preview === "audio" ? (
          <AudioPreview file={file} fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
        ) : preview === "text" ? (
          <TextPreview file={file} state={textState} fullscreen={fullscreen} />
        ) : preview === "markdown" ? (
          <MarkdownPreview state={textState} fullscreen={fullscreen} />
        ) : (
          <UnsupportedPreview file={file} />
        )}
      </PreviewFrame>
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
