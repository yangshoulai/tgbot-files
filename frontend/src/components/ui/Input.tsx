import { InputHTMLAttributes, forwardRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leadingIcon?: ReactNode;
  trailingNode?: ReactNode;
  invalid?: boolean;
  inputClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, inputClassName, leadingIcon, trailingNode, invalid, type = "text", ...rest },
  ref
) {
  return (
    <div
      className={cn(
        "group flex h-11 items-center gap-2 rounded-lg border bg-surface px-3 text-foreground shadow-card",
        "transition-[border-color,box-shadow] duration-150",
        "focus-within:border-primary focus-within:shadow-[0_0_0_4px_var(--color-primary-ring)]",
        invalid
          ? "border-danger focus-within:border-danger focus-within:shadow-[0_0_0_4px_var(--color-danger-soft)]"
          : "border-border hover:border-border-strong",
        className
      )}
    >
      {leadingIcon ? <span className="grid place-items-center text-subtle">{leadingIcon}</span> : null}
      <input
        ref={ref}
        type={type}
        className={cn(
          "h-full w-full min-w-0 border-0 bg-transparent text-[15px] text-foreground outline-none placeholder:text-subtle",
          inputClassName
        )}
        {...rest}
      />
      {trailingNode}
    </div>
  );
});
