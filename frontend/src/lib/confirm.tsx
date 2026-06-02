import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";

type Tone = "default" | "danger";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: Tone;
}

interface InternalState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): ConfirmContextValue["confirm"] {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx.confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<InternalState | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<InternalState | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const next: InternalState = { ...options, resolve };
      pendingRef.current = next;
      setState(next);
      setBusy(false);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setState(null);
    setBusy(false);
    pending?.resolve(value);
  }, []);

  const value = useMemo<ConfirmContextValue>(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        open={state !== null}
        onClose={() => !busy && settle(false)}
        title={state?.title}
        size="sm"
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => settle(false)}>
              {state?.cancelText ?? "取消"}
            </Button>
            <Button
              variant={state?.tone === "danger" ? "danger" : "primary"}
              loading={busy}
              onClick={() => {
                setBusy(true);
                settle(true);
              }}
            >
              {state?.confirmText ?? "确认"}
            </Button>
          </>
        }
      >
        <div className="flex min-w-0 items-start gap-3 overflow-anywhere">
          {state?.tone === "danger" ? (
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
              <AlertTriangle size={18} />
            </span>
          ) : null}
          <div className="min-w-0 text-sm leading-6 text-muted">{state?.description}</div>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}
