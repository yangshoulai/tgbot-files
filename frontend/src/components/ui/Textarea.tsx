import { TextareaHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/cn";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 4, ...rest },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "block w-full resize-y rounded-lg border bg-surface px-3 py-2.5 text-[15px] leading-7 text-foreground shadow-card",
        "transition-[border-color,box-shadow] duration-150 placeholder:text-subtle outline-none",
        "focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]",
        invalid
          ? "border-danger focus:border-danger focus:shadow-[0_0_0_4px_var(--color-danger-soft)]"
          : "border-border hover:border-border-strong",
        className
      )}
      {...rest}
    />
  );
});
