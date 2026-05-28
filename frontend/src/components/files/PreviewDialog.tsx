import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import type { FileItem } from "../../api";
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
  const downloadHref = appendDownloadParam(file.file_path);

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
          <a
            href={downloadHref}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-white shadow-card transition-colors duration-150 hover:border-primary-strong hover:bg-primary-strong"
          >
            <Download size={15} />
            下载
          </a>
        </>
      }
      bodyClassName="bg-background/40"
    >
      <div
        className={
          fullscreen
            ? "grid h-full min-h-0 place-items-center overflow-hidden rounded-xl border border-border bg-surface"
            : "grid min-h-72 place-items-center overflow-hidden rounded-xl border border-border bg-surface"
        }
      >
        {preview === "image" ? (
          <img
            src={file.file_path}
            alt={file.file_name}
            className={fullscreen ? "h-full w-full object-contain" : "max-h-[60vh] w-full object-contain"}
            loading="lazy"
          />
        ) : preview === "text" ? (
          <TextPreview state={textState} fullscreen={fullscreen} />
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

function appendDownloadParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function TextPreview({
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
    <pre className={(fullscreen ? "h-full" : "h-[60vh]") + " w-full overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-xs leading-6 text-foreground scroll-thin"}>
      {state.content || "空文本文件"}
    </pre>
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
          code: (props) => <code {...props} className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs" />,
          pre: (props) => <pre {...props} className="mb-3 overflow-auto rounded-xl border border-border bg-surface p-3 font-mono text-xs leading-6 scroll-thin" />,
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
