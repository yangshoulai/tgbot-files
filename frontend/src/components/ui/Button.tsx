import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  block?: boolean;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium leading-none whitespace-nowrap " +
  "transition-[color,background-color,border-color,box-shadow,transform] duration-150 " +
  "focus-visible:outline-none focus-visible:focus-ring active:translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-50 border";

const variants: Record<Variant, string> = {
  primary:
    "border-primary bg-primary text-white shadow-card hover:bg-primary-strong hover:border-primary-strong",
  secondary:
    "border-border bg-surface text-foreground shadow-card hover:border-border-strong hover:bg-background",
  ghost: "border-transparent bg-transparent text-foreground hover:bg-primary-soft hover:text-primary-strong",
  danger:
    "border-danger bg-danger text-white shadow-card hover:bg-danger-strong hover:border-danger-strong",
  "danger-ghost":
    "border-transparent bg-transparent text-danger hover:bg-danger-soft"
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-base"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    leadingIcon,
    trailingIcon,
    block,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(base, variants[variant], sizes[size], block && "w-full", className)}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  );
});
