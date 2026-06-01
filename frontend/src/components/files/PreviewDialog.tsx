import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import { Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import type { FileItem } from "../../api";
import { buildChunkedVideoPreviewUrl } from "../../lib/video-preview";
import { isVideoPreviewServiceWorkerControlling } from "../../lib/video-preview-service-worker";
import { hasDirectFileAccess } from "../../lib/file-access";
import { previewKind } from "../../utils";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";

interface PreviewDialogProps {
  file: FileItem | null;
  onClose: () => void;
  onCopy: (value: string) => void;
}

export function PreviewDialog({ file, onClose, onCopy }: PreviewDialogProps) {
  const preview = file ? previewKind(file) : null;
  const [fullscreen, setFullscreen] = useState(false);
  const [textState, setTextState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    content: string;
    message?: string;
  }>({ status: "idle", content: "" });

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
          setTextState({ status: "ready", content });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTextState({
          status: "error",
          content: "",
          message: error instanceof Error ? error.message : "读取预览内容失败"
        });
      });

    return () => controller.abort();
  }, [file, preview]);

  useEffect(() => {
    setFullscreen(false);
  }, [file?.id]);

  if (!file) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  const canCopyContent = (preview === "text" || preview === "markdown") && textState.status === "ready";
  const directFile = hasDirectFileAccess(file) ? file : null;

  return (
    <Modal
      open
      onClose={onClose}
      size={fullscreen ? "full" : "xl"}
      title={<span title={file.file_name}>{file.file_name}</span>}
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
          <Button
            variant="secondary"
            leadingIcon={fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? "退出全屏" : "全屏"}
          </Button>
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
      <div
        className={
          fullscreen
            ? "flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface"
            : "grid min-h-72 place-items-center overflow-hidden rounded-xl border border-border bg-surface"
        }
      >
        {preview === "image" && directFile ? (
          <img
            src={file.file_path}
            alt={file.file_name}
            className={fullscreen ? "block h-auto max-h-full w-auto max-w-full object-contain" : "h-[60vh] w-full object-contain"}
            loading="lazy"
          />
        ) : preview === "video" ? (
          <VideoPreview file={file} fullscreen={fullscreen} />
        ) : preview === "text" ? (
          <TextPreview file={file} state={textState} fullscreen={fullscreen} />
        ) : preview === "markdown" ? (
          <MarkdownPreview state={textState} fullscreen={fullscreen} />
        ) : (
          <div className="grid place-items-center gap-3 px-6 py-12 text-center">
            <p className="text-sm font-medium text-foreground">该类型暂不支持直接预览</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function VideoPreview({ file, fullscreen }: { file: FileItem; fullscreen: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const [ratio, setRatio] = useState({ label: "16:9", value: 16 / 9 });
  const [serviceWorkerReady, setServiceWorkerReady] = useState(isVideoPreviewServiceWorkerControlling);
  const heightLimit = fullscreen ? "calc(100dvh - 11rem)" : "min(64dvh, 760px)";
  const directFile = hasDirectFileAccess(file) ? file : null;
  const chunkedPreviewUrl = serviceWorkerReady ? buildChunkedVideoPreviewUrl(file) : null;
  const videoSrc = chunkedPreviewUrl ?? (directFile ? file.file_path : null);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;

    const player = new Plyr(node, {
      controls: [
        "play-large",
        "play",
        "progress",
        "current-time",
        "mute",
        "settings"
      ],
      settings: ["speed"],
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      tooltips: { controls: true, seek: true },
      fullscreen: { enabled: false },
      ratio: ratio.label
    });
    playerRef.current = player;

    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [videoSrc]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    let disposed = false;
    const refresh = () => {
      if (!disposed) {
        setServiceWorkerReady(isVideoPreviewServiceWorkerControlling());
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", refresh);
    void navigator.serviceWorker.ready.then(refresh).catch(() => undefined);
    refresh();

    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener("controllerchange", refresh);
    };
  }, []);

  useEffect(() => {
    if (playerRef.current) {
      applyPlyrAspectRatio(videoRef.current, ratio);
    }
  }, [ratio]);

  if (!videoSrc) {
    return (
      <div className="grid w-full place-items-center gap-3 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">该大文件不提供完整访问链接</p>
        <p className="max-w-md text-xs leading-6 text-muted">
          视频预览需要 Service Worker 分片代理接管页面；如果刚部署或首次打开，请刷新页面后再试。
        </p>
      </div>
    );
  }

  return (
    <div className={(fullscreen ? "h-full min-h-0" : "h-[min(64dvh,760px)]") + " flex w-full items-center justify-center bg-foreground p-3 sm:p-4"}>
      <div
        className="max-h-full max-w-full overflow-hidden rounded-xl bg-black shadow-dialog [&_.plyr]:h-full [&_.plyr]:w-full [&_.plyr]:min-w-0 [&_.plyr]:rounded-xl [&_.plyr]:[aspect-ratio:inherit] [&_.plyr__controls]:rounded-b-xl [&_.plyr__video-wrapper]:h-full [&_.plyr__video-wrapper]:w-full [&_.plyr__video-wrapper]:rounded-xl [&_.plyr__video-wrapper]:[aspect-ratio:inherit] [&_.plyr__video-wrapper--fixed-ratio]:[aspect-ratio:inherit]"
        style={{
          aspectRatio: ratio.label.replace(":", " / "),
          width: `min(100%, calc(${heightLimit} * ${ratio.value}))`
        }}
      >
        <video
          ref={videoRef}
          src={videoSrc}
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
          onLoadedMetadata={(event) => {
            const target = event.currentTarget;
            if (target.videoWidth > 0 && target.videoHeight > 0) {
              const nextRatio = toAspectRatio(target.videoWidth, target.videoHeight);
              setRatio(nextRatio);
              applyPlyrAspectRatio(target, nextRatio);
            }
          }}
        >
          当前浏览器不支持该视频预览。
        </video>
      </div>
    </div>
  );
}

function applyPlyrAspectRatio(
  video: HTMLVideoElement | null,
  ratio: { label: string; value: number }
) {
  const player = video?.closest<HTMLElement>(".plyr");
  const wrapper = player?.querySelector<HTMLElement>(".plyr__video-wrapper");
  const cssRatio = ratio.label.replace(":", " / ");

  if (player) {
    player.style.aspectRatio = cssRatio;
  }

  if (wrapper) {
    wrapper.style.aspectRatio = cssRatio;
  }
}

function toAspectRatio(width: number, height: number): { label: string; value: number } {
  const gcd = greatestCommonDivisor(width, height);
  const normalizedWidth = Math.max(1, Math.round(width / gcd));
  const normalizedHeight = Math.max(1, Math.round(height / gcd));

  return {
    label: `${normalizedWidth}:${normalizedHeight}`,
    value: width / height
  };
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

function TextPreview({
  file,
  state,
  fullscreen
}: {
  file: FileItem;
  state: { status: "idle" | "loading" | "ready" | "error"; content: string; message?: string };
  fullscreen: boolean;
}) {
  const language = detectTextLanguage(file);
  const prepared = useMemo(() => prepareTextContent(state.content, language), [state.content, language]);

  if (state.status === "loading" || state.status === "idle") {
    return <PreviewLoading />;
  }

  if (state.status === "error") {
    return <PreviewError message={state.message || "读取预览内容失败"} />;
  }

  return (
    <CodePreview
      content={prepared}
      fullscreen={fullscreen}
      language={language}
      originalContent={state.content}
    />
  );
}

function MarkdownPreview({
  state,
  fullscreen
}: {
  state: { status: "idle" | "loading" | "ready" | "error"; content: string; message?: string };
  fullscreen: boolean;
}) {
  if (state.status === "loading" || state.status === "idle") {
    return <PreviewLoading />;
  }

  if (state.status === "error") {
    return <PreviewError message={state.message || "读取预览内容失败"} />;
  }

  return (
    <div className={(fullscreen ? "h-full" : "h-[60vh]") + " w-full overflow-auto bg-background px-5 py-5 text-sm leading-7 text-foreground scroll-thin"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 {...props} className="mb-4 border-b border-border pb-2 text-2xl font-semibold" />,
          h2: (props) => <h2 {...props} className="mb-3 mt-6 text-xl font-semibold" />,
          h3: (props) => <h3 {...props} className="mb-2 mt-5 text-base font-semibold" />,
          p: (props) => <p {...props} className="mb-3" />,
          a: (props) => <a {...props} target="_blank" rel="noreferrer" className="text-primary-strong underline underline-offset-2" />,
          ul: (props) => <ul {...props} className="mb-3 list-disc pl-5" />,
          ol: (props) => <ol {...props} className="mb-3 list-decimal pl-5" />,
          blockquote: (props) => <blockquote {...props} className="mb-3 border-l-4 border-border pl-3 text-muted" />,
          code: (props) => <code {...props} className="rounded bg-primary-soft px-1.5 py-0.5 font-mono text-xs text-primary-strong" />,
          pre: (props) => <pre {...props} className="mb-3 overflow-auto rounded-xl border border-border bg-foreground p-3 font-mono text-xs leading-6 text-white scroll-thin" />,
          table: (props) => <table {...props} className="mb-3 w-full border-collapse text-sm" />,
          th: (props) => <th {...props} className="border border-border bg-surface px-2 py-1 text-left font-semibold" />,
          td: (props) => <td {...props} className="border border-border px-2 py-1" />
        }}
      >
        {state.content || "空 Markdown 文件"}
      </ReactMarkdown>
    </div>
  );
}

type TextLanguage = "javascript" | "json" | "yaml" | "toml" | "html" | "css" | "xml" | "text";

function detectTextLanguage(file: Pick<FileItem, "mime_type" | "file_name">): TextLanguage {
  const mime = file.mime_type.toLowerCase();
  const name = file.file_name.toLowerCase();
  const extension = name.split(".").pop() || "";

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(extension) || mime.includes("javascript") || mime.includes("typescript")) {
    return "javascript";
  }

  if (extension === "json" || mime === "application/json") {
    return "json";
  }

  if (["yaml", "yml"].includes(extension) || mime.includes("yaml")) {
    return "yaml";
  }

  if (extension === "toml" || mime.includes("toml")) {
    return "toml";
  }

  if (["html", "htm"].includes(extension) || mime === "text/html") {
    return "html";
  }

  if (extension === "css" || mime === "text/css") {
    return "css";
  }

  if (extension === "xml" || mime.includes("xml")) {
    return "xml";
  }

  return "text";
}

function prepareTextContent(content: string, language: TextLanguage): string {
  if (!content) {
    return "空文本文件";
  }

  if (language !== "json") {
    return content;
  }

  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function CodePreview({
  content,
  fullscreen,
  language,
  originalContent
}: {
  content: string;
  fullscreen: boolean;
  language: TextLanguage;
  originalContent: string;
}) {
  const lines = content.split("\n");
  const lineCountLabel = `${lines.length} 行`;
  const formattedLabel = language === "json" && content !== originalContent ? "已格式化" : "原文";

  return (
    <div className={(fullscreen ? "h-full" : "h-[60vh]") + " flex w-full flex-col overflow-hidden bg-foreground text-white"}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-white/[0.04] px-4 py-2 text-xs text-white/70">
        <span className="font-medium text-white">{languageLabel(language)}</span>
        <span className="flex items-center gap-2">
          <span>{formattedLabel}</span>
          <span className="h-1 w-1 rounded-full bg-white/30" />
          <span>{lineCountLabel}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scroll-thin">
        <div className="min-w-max py-2 font-mono text-xs leading-6">
          {lines.map((line, index) => (
            <div key={`${index}-${line}`} className="grid grid-cols-[3.75rem_1fr] hover:bg-white/[0.04]">
              <span className="select-none border-r border-white/10 px-3 text-right text-white/35">
                {index + 1}
              </span>
              <code className="whitespace-pre px-4 text-white/88">
                {highlightLine(line, language)}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function languageLabel(language: TextLanguage): string {
  switch (language) {
    case "javascript":
      return "JavaScript / TypeScript";
    case "json":
      return "JSON";
    case "yaml":
      return "YAML";
    case "toml":
      return "TOML";
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "xml":
      return "XML";
    default:
      return "Text";
  }
}

const tokenPattern =
  /(\/\/.*$|#.*$|<!--.*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|interface|let|new|null|private|protected|public|return|static|switch|this|throw|true|try|type|undefined|var|while|yield)\b|\b\d+(?:\.\d+)?\b|<\/?[A-Za-z][^>]*>|&[A-Za-z0-9#]+;|[{}[\]():,.;=<>+\-*\/])/g;

function highlightLine(line: string, language: TextLanguage): ReactNode[] {
  if (!line) {
    return [""];
  }

  const nodes: ReactNode[] = [];
  const keyMatch =
    language === "json" || language === "yaml" || language === "toml"
      ? /^(\s*)("?[\w.-]+"?)(\s*[:=])/.exec(line)
      : null;

  if (keyMatch) {
    const [, indent, key, separator] = keyMatch;
    const consumed = `${indent}${key}${separator}`;
    nodes.push(indent);
    nodes.push(<span key="key" className="text-sky-300">{key}</span>);
    nodes.push(<span key="separator" className="text-white/45">{separator}</span>);
    nodes.push(...highlightTokens(line.slice(consumed.length), language, consumed.length));
    return nodes;
  }

  return highlightTokens(line, language, 0);
}

function highlightTokens(value: string, language: TextLanguage, offset: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];

    if (index > lastIndex) {
      nodes.push(value.slice(lastIndex, index));
    }

    nodes.push(
      <span key={`${offset + index}-${token}`} className={tokenClass(token, language)}>
        {token}
      </span>
    );
    lastIndex = index + token.length;
  }

  if (lastIndex < value.length) {
    nodes.push(value.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [value];
}

function tokenClass(token: string, language: TextLanguage): string {
  if (token.startsWith("//") || token.startsWith("#") || token.startsWith("<!--")) {
    return "text-white/38";
  }

  if (
    token.startsWith("\"") ||
    token.startsWith("'") ||
    token.startsWith("`") ||
    (language === "html" && token.startsWith("&"))
  ) {
    return "text-emerald-300";
  }

  if (token.startsWith("<") && token.endsWith(">")) {
    return "text-primary-soft";
  }

  if (/^\d/.test(token)) {
    return "text-amber-200";
  }

  if (/^(true|false|null|undefined)$/.test(token)) {
    return "text-amber-200";
  }

  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    return "text-violet-200";
  }

  return "text-white/45";
}

function PreviewLoading() {
  return (
    <div className="flex h-[60vh] w-full items-center justify-center gap-2 text-sm text-muted">
      <Spinner size={18} />
      加载预览内容…
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <div className="grid h-[60vh] w-full place-items-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">预览读取失败</p>
        <p className="mt-1 text-xs text-muted">{message}</p>
      </div>
    </div>
  );
}
