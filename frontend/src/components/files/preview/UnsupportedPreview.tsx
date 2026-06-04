import { FileQuestion } from "lucide-react";
import type { FileItem } from "../../../api";
import { formatBytes } from "../../../utils";

export function UnsupportedPreview({ file }: { file: FileItem }) {
  return (
    <div className="grid w-full place-items-center px-6 py-16 text-center">
      <div className="max-w-md rounded-2xl border border-border bg-background px-6 py-5 shadow-card">
        <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-primary-soft text-primary-strong">
          <FileQuestion size={20} />
        </span>
        <p className="text-sm font-semibold text-foreground">该类型暂不支持直接预览</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          {file.file_name} · {formatBytes(file.size)} · {file.mime_type || "未知 MIME"}
        </p>
      </div>
    </div>
  );
}
