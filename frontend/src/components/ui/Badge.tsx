import { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "primary";
type Size = "sm" | "md";

interface BadgeProps {
  tone?: Tone;
  size?: Size;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

const tones: Record<Tone, string> = {
  neutral: "border-border bg-background text-muted",
  success: "border-success/30 bg-success-soft text-success",
  danger: "border-danger/30 bg-danger-soft text-danger",
  warning: "border-warning/40 bg-warning-soft text-warning",
  info: "border-info/30 bg-info-soft text-info",
  primary: "border-primary/30 bg-primary-soft text-primary-strong"
};

const sizes: Record<Size, string> = {
  sm: "h-6 px-2 text-[11px]",
  md: "h-7 px-2.5 text-xs"
};

export function Badge({ tone = "neutral", size = "md", icon, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium leading-none",
        tones[tone],
        sizes[size],
        className
      )}
    >
      {icon}
      {children}
    </span>
  );
}
