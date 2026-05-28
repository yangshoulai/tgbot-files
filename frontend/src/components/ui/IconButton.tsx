import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/cn";

type Variant = "default" | "ghost" | "danger";
type Size = "sm" | "md";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  label: string;
}

const base =
  "inline-grid shrink-0 place-items-center rounded-lg " +
  "transition-[color,background-color,border-color,box-shadow,transform] duration-150 " +
  "focus-visible:outline-none focus-visible:focus-ring active:translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  default:
    "border border-border bg-surface text-muted shadow-card hover:border-border-strong hover:text-foreground hover:bg-background",
  ghost: "border border-transparent bg-transparent text-muted hover:bg-primary-soft hover:text-primary-strong",
  danger:
    "border border-transparent bg-transparent text-danger hover:bg-danger-soft"
};

const sizes: Record<Size, string> = {
  sm: "size-8",
  md: "size-10"
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "default", size = "md", label, className, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    />
  );
});
