import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "./cn";

type Tone = "success" | "danger" | "info";

interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}

interface ToastContextValue {
  push: (text: string, tone?: Tone) => void;
  success: (text: string) => void;
  danger: (text: string) => void;
  info: (text: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

interface ProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: Tone = "success") => {
      counter.current += 1;
      const id = counter.current;
      setItems((current) => [...current, { id, text, tone }]);
      window.setTimeout(() => dismiss(id), 2600);
    },
    [dismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (text) => push(text, "success"),
      danger: (text) => push(text, "danger"),
      info: (text) => push(text, "info")
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

interface ViewportProps {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}

function ToastViewport({ items, onDismiss }: ViewportProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3 sm:bottom-6 sm:left-auto sm:right-6 sm:top-auto sm:items-end sm:px-0">
      {items.map((item) => (
        <ToastCard key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />
      ))}
    </div>,
    document.body
  );
}

interface CardProps {
  item: ToastItem;
  onDismiss: () => void;
}

function ToastCard({ item, onDismiss }: CardProps) {
  const styles = toneStyles[item.tone];
  const Icon = styles.icon;
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-surface px-4 py-3 shadow-dialog animate-toast-in",
        styles.border
      )}
    >
      <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full", styles.iconBg)}>
        <Icon size={14} className={styles.iconFg} />
      </span>
      <p className="min-w-0 flex-1 overflow-anywhere text-sm leading-6 text-foreground">{item.text}</p>
      <button
        type="button"
        aria-label="关闭"
        onClick={onDismiss}
        className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-background hover:text-foreground"
      >
        <X size={14} />
      </button>
    </div>
  );
}

const toneStyles: Record<Tone, { border: string; iconBg: string; iconFg: string; icon: typeof CheckCircle2 }> = {
  success: { border: "border-success/30", iconBg: "bg-success-soft", iconFg: "text-success", icon: CheckCircle2 },
  danger: { border: "border-danger/30", iconBg: "bg-danger-soft", iconFg: "text-danger", icon: AlertTriangle },
  info: { border: "border-info/30", iconBg: "bg-info-soft", iconFg: "text-info", icon: Info }
};
