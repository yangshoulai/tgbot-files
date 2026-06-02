import { ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "./IconButton";

type Size = "sm" | "md" | "lg" | "xl" | "full";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: Size;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  hideClose?: boolean;
  initialFocus?: "first" | "none";
  className?: string;
  bodyClassName?: string;
}

const sizes: Record<Size, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
  full: "sm:max-w-none"
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  closeOnEscape = true,
  hideClose = false,
  initialFocus = "first",
  className,
  bodyClassName
}: ModalProps) {
  const headingId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && closeOnEscape) {
        event.preventDefault();
        onClose();
      }

      if (event.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, closeOnEscape]);

  useEffect(() => {
    if (!open || initialFocus === "none") return;
    const handle = window.setTimeout(() => {
      const node = dialogRef.current;
      if (!node) return;
      const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      const target = focusables[0];
      if (target) {
        target.focus();
      } else {
        node.focus();
      }
    }, 60);
    return () => window.clearTimeout(handle);
  }, [open, initialFocus]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) {
          onClose();
        }
      }}
      className={cn(
        "fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 backdrop-blur-sm animate-fade-in sm:items-center",
        size === "full" ? "p-0" : "p-2 sm:p-6"
      )}
      data-size={size}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-dialog animate-dialog-in outline-none",
          size === "full" && "h-[100dvh] max-h-[100dvh] rounded-none border-0 shadow-none sm:w-[100vw]",
          sizes[size],
          className
        )}
      >
        {title || !hideClose ? (
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
            <div className="min-w-0 flex-1">
              {title ? (
                <h2 id={headingId} className="truncate text-base font-semibold text-foreground sm:text-lg">
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p id={descId} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            {!hideClose ? (
              <IconButton variant="ghost" size="sm" label="关闭" onClick={onClose}>
                <X size={16} />
              </IconButton>
            ) : null}
          </div>
        ) : null}

        <div
          className={cn(
            "min-h-0 flex-1 overflow-x-hidden scroll-thin px-5 py-5 sm:px-6",
            size === "full" ? "overflow-hidden px-4 py-4 sm:px-5 sm:py-5" : "overflow-auto",
            bodyClassName
          )}
        >
          {children}
        </div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/50 px-5 py-3 sm:px-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
