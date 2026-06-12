import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "../../../lib/cn";
import { Spinner } from "../../ui/Spinner";

interface PreviewFrameProps {
  fullscreen: boolean;
  tone?: "surface" | "dark" | "code";
  children: ReactNode;
  className?: string;
}

export function PreviewFrame({ fullscreen, tone = "surface", children, className }: PreviewFrameProps) {
  return (
    <div
      className={cn(
        fullscreen
          ? "flex min-h-0 w-full flex-1 overflow-hidden rounded-xl border"
          : "grid min-h-72 w-full overflow-hidden rounded-xl border",
        tone === "dark" ? "border-foreground/20 bg-[#07110f]" : "border-border bg-surface",
        tone === "code" && "bg-white",
        className
      )}
    >
      {children}
    </div>
  );
}

export function PreviewLoading({ label = "加载预览内容…", dark = false }: { label?: string; dark?: boolean }) {
  return (
    <div className={cn("flex h-[60vh] w-full items-center justify-center gap-2 text-sm", dark ? "text-white/80" : "text-muted")}>
      <Spinner size={18} className={dark ? "text-white" : undefined} />
      {label}
    </div>
  );
}

export function PreviewError({ message, dark = false }: { message: string; dark?: boolean }) {
  return (
    <div className={cn("grid h-[60vh] w-full place-items-center px-6 text-center", dark ? "text-white" : "text-foreground")}>
      <div className={cn("max-w-md rounded-2xl border px-5 py-4", dark ? "border-white/10 bg-white/5" : "border-border bg-background")}>
        <span className={cn("mx-auto mb-3 grid size-10 place-items-center rounded-full", dark ? "bg-white/10 text-white" : "bg-danger-soft text-danger")}>
          <AlertCircle size={18} />
        </span>
        <p className="text-sm font-medium">预览读取失败</p>
        <p className={cn("mt-1 text-xs leading-5", dark ? "text-white/65" : "text-muted")}>{message}</p>
      </div>
    </div>
  );
}
