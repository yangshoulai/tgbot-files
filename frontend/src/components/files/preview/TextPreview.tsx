import { useMemo } from "react";
import type { FileItem } from "../../../api";
import { cn } from "../../../lib/cn";
import { PreviewError, PreviewLoading } from "./PreviewFrame";
import type { TextPreviewState } from "./types";
import { detectTextLanguage, highlightLine, languageLabel, prepareTextContent } from "./text-format";

export function TextPreview({ file, state, fullscreen }: {
  file: FileItem;
  state: TextPreviewState;
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

  const lines = prepared.content.split("\n");
  const lineCountLabel = `${lines.length} 行`;
  const formattedLabel = prepared.formatted ? "已格式化" : "原文";

  return (
    <div className={cn("flex w-full flex-col overflow-hidden bg-white text-[#334155]", fullscreen ? "h-full" : "h-[64vh]") }>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-2 font-medium text-foreground">
          <span className="grid size-2 rounded-full bg-primary" />
          {languageLabel(prepared.language)}
        </span>
        <span className="flex items-center gap-2">
          <span>{formattedLabel}</span>
          <span className="h-1 w-1 rounded-full bg-subtle" />
          <span>{lineCountLabel}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scroll-thin">
        <div className="min-w-max py-2 font-mono text-xs leading-6">
          {lines.map((line, index) => (
            <div key={`${index}-${line}`} className="grid grid-cols-[4rem_1fr] hover:bg-primary-soft/35">
              <span className="select-none border-r border-border bg-background/40 px-3 text-right text-subtle">
                {index + 1}
              </span>
              <code className="whitespace-pre px-4 text-[#334155]">
                {highlightLine(line, prepared.language)}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
