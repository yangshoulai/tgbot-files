import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../../lib/cn";
import { PreviewError, PreviewLoading } from "./PreviewFrame";
import type { TextPreviewState } from "./types";

export function MarkdownPreview({ state, fullscreen }: { state: TextPreviewState; fullscreen: boolean }) {
  if (state.status === "loading" || state.status === "idle") {
    return <PreviewLoading />;
  }

  if (state.status === "error") {
    return <PreviewError message={state.message || "读取预览内容失败"} />;
  }

  return (
    <div className={cn("w-full overflow-auto bg-white px-5 py-5 text-sm leading-7 text-foreground scroll-thin", fullscreen ? "h-full" : "h-[64vh]") }>
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
          code: (props) => <code {...props} className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[0.92em] text-foreground ring-1 ring-border/70" />,
          pre: (props) => (
            <pre
              {...props}
              className="mb-4 overflow-auto rounded-xl border border-border bg-[#f8fafc] p-3 font-mono text-xs leading-6 text-[#334155] shadow-card scroll-thin [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:text-[#334155] [&_code]:ring-0"
            />
          ),
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
