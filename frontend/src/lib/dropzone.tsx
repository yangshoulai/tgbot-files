import { ReactNode, useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

interface GlobalDropzoneProps {
  enabled: boolean;
  onDrop: (files: File[]) => void;
  label?: ReactNode;
  hint?: ReactNode;
}

export function GlobalDropzone({ enabled, onDrop, label = "释放以上传文件", hint = "支持任意文件类型" }: GlobalDropzoneProps) {
  const [active, setActive] = useState(false);
  const counter = useRef(0);

  useEffect(() => {
    if (!enabled) {
      counter.current = 0;
      setActive(false);
      return;
    }

    function hasFiles(event: DragEvent): boolean {
      const types = event.dataTransfer?.types;
      if (!types) return false;
      for (let index = 0; index < types.length; index += 1) {
        if (types[index] === "Files") return true;
      }
      return false;
    }

    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return;
      counter.current += 1;
      setActive(true);
    }

    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
    }

    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return;
      counter.current = Math.max(0, counter.current - 1);
      if (counter.current === 0) setActive(false);
    }

    function onDropEvent(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      counter.current = 0;
      setActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onDrop(files);
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDropEvent);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDropEvent);
    };
  }, [enabled, onDrop]);

  if (!enabled || !active) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[55] grid place-items-center bg-foreground/40 px-6 backdrop-blur-sm animate-fade-in">
      <div className="grid place-items-center gap-3 rounded-3xl border-2 border-dashed border-primary bg-surface/95 px-10 py-12 text-center shadow-dialog">
        <span className="grid size-16 place-items-center rounded-2xl bg-primary-soft text-primary-strong">
          <UploadCloud size={32} />
        </span>
        <p className="text-xl font-semibold text-foreground">{label}</p>
        <p className="text-sm text-muted">{hint}</p>
      </div>
    </div>
  );
}
