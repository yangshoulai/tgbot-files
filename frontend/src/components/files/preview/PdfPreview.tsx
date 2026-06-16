import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileWarning, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { hasFileLinkAccess } from "../../../lib/file-access";
import { cn } from "../../../lib/cn";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import type { PreviewComponentProps } from "./types";
import { PreviewError, PreviewLoading } from "./PreviewFrame";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfState =
  | { status: "idle" | "loading" }
  | { status: "ready"; document: pdfjsLib.PDFDocumentProxy; pageCount: number }
  | { status: "error"; message: string };

const MIN_SCALE = 0.7;
const MAX_SCALE = 2.2;
const SCALE_STEP = 0.2;

export function PdfPreview({ file, fullscreen, previewUrl }: PreviewComponentProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const linkFile = hasFileLinkAccess(file) ? file : null;
  const [state, setState] = useState<PdfState>({ status: "idle" });
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!linkFile) {
      setState({ status: "idle" });
      return;
    }

    let disposed = false;
    const loadingTask = pdfjsLib.getDocument({
      url: previewUrl || file.file_path,
      withCredentials: true
    });

    setState({ status: "loading" });
    setPageNumber(1);

    loadingTask.promise
      .then((document) => {
        if (disposed) {
          return;
        }
        setState({ status: "ready", document, pageCount: document.numPages });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "PDF 读取失败"
        });
      });

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      void loadingTask.destroy();
    };
  }, [file.file_path, file.id, linkFile, previewUrl]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    setRendering(true);
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    state.document.getPage(pageNumber)
      .then((page) => {
        if (disposed) return undefined;
        const viewport = page.getViewport({ scale });
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("当前浏览器无法创建 PDF 渲染画布");
        }

        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);

        const task = page.render({ canvas, canvasContext: context, viewport });
        renderTaskRef.current = task;
        return task.promise;
      })
      .then(() => {
        if (!disposed) {
          setRendering(false);
        }
      })
      .catch((error: unknown) => {
        if (disposed || isPdfRenderCancelled(error)) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "PDF 页面渲染失败"
        });
        setRendering(false);
      });

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [pageNumber, scale, state]);

  useEffect(() => {
    setScale(1.2);
  }, [file.id]);

  if (!linkFile) {
    return <PreviewError message="该 PDF 不提供完整访问链接，无法直接预览" />;
  }

  switch (state.status) {
    case "idle":
    case "loading":
      return <PreviewLoading label="加载 PDF 预览…" />;
    case "error":
      return <PdfPreviewError message={state.message} />;
    case "ready":
      break;
  }

  const pageCount = state.pageCount;

  return (
    <div className={cn("flex min-w-0 w-full flex-col bg-background", fullscreen ? "h-full" : "h-[min(76dvh,820px)] max-h-[calc(92dvh-12rem)] min-h-96")}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <IconButton
            size="sm"
            label="上一页"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <span className="min-w-24 text-center text-xs font-medium text-muted">
            {pageNumber} / {pageCount}
          </span>
          <IconButton
            size="sm"
            label="下一页"
            disabled={pageNumber >= pageCount}
            onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            size="sm"
            label="缩小"
            disabled={scale <= MIN_SCALE}
            onClick={() => setScale((value) => Math.max(MIN_SCALE, Number((value - SCALE_STEP).toFixed(1))))}
          >
            <ZoomOut size={15} />
          </IconButton>
          <Button variant="secondary" size="sm" onClick={() => setScale(1.2)}>
            {Math.round(scale * 100)}%
          </Button>
          <IconButton
            size="sm"
            label="放大"
            disabled={scale >= MAX_SCALE}
            onClick={() => setScale((value) => Math.min(MAX_SCALE, Number((value + SCALE_STEP).toFixed(1))))}
          >
            <ZoomIn size={15} />
          </IconButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-[#f3f4f6] px-4 py-5">
        {rendering ? (
          <div className="absolute inset-0 z-10 bg-background/55 backdrop-blur-[1px]">
            <PreviewLoading label="渲染 PDF 页面…" />
          </div>
        ) : null}
        <div className="mx-auto flex w-max min-w-0 max-w-full justify-center">
          <canvas ref={canvasRef} className="max-w-full rounded-sm bg-white shadow-dialog" />
        </div>
      </div>
    </div>
  );
}

function PdfPreviewError({ message }: { message: string }) {
  return (
    <div className="grid w-full place-items-center px-6 py-16 text-center">
      <div className="max-w-md rounded-2xl border border-border bg-background px-6 py-5 shadow-card">
        <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
          <FileWarning size={20} />
        </span>
        <p className="text-sm font-semibold text-foreground">PDF 预览加载失败</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          {message || "浏览器无法读取该 PDF，请尝试下载后查看。"}
        </p>
      </div>
    </div>
  );
}

function isPdfRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}
