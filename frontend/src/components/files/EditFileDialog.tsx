import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import type { FileItem } from "../../api";

interface EditFileDialogProps {
  editingFile: FileItem | null;
  editFileName: string;
  editMimeType: string;
  editRemark: string;
  savingFile: boolean;
  onClose: () => void;
  onChangeFileName: (value: string) => void;
  onChangeMimeType: (value: string) => void;
  onChangeRemark: (value: string) => void;
  onSubmit: () => void;
}

const MIME_TYPE_OPTIONS = [
  { value: "application/octet-stream", label: "通用文件" },
  { value: "image/jpeg", label: "JPEG 图片" },
  { value: "image/png", label: "PNG 图片" },
  { value: "image/webp", label: "WebP 图片" },
  { value: "image/gif", label: "GIF 图片" },
  { value: "video/mp4", label: "MP4 视频" },
  { value: "video/x-matroska", label: "MKV 视频" },
  { value: "video/webm", label: "WebM 视频" },
  { value: "video/quicktime", label: "MOV 视频" },
  { value: "application/vnd.apple.mpegurl", label: "HLS 播放列表" },
  { value: "audio/mpeg", label: "MP3 音频" },
  { value: "audio/wav", label: "WAV 音频" },
  { value: "text/plain", label: "纯文本" },
  { value: "text/markdown", label: "Markdown" },
  { value: "application/pdf", label: "PDF 文档" },
  { value: "application/zip", label: "ZIP 压缩包" },
  { value: "__custom", label: "自定义 MIME" }
];

export function EditFileDialog({
  editingFile,
  editFileName,
  editMimeType,
  editRemark,
  savingFile,
  onClose,
  onChangeFileName,
  onChangeMimeType,
  onChangeRemark,
  onSubmit
}: EditFileDialogProps) {
  const normalizedMimeType = editMimeType.trim().toLowerCase();
  const selectedMimeType = MIME_TYPE_OPTIONS.some((option) => option.value === normalizedMimeType)
    ? normalizedMimeType
    : "__custom";

  return (
    <Modal
      open={Boolean(editingFile)}
      onClose={() => {
        if (!savingFile) onClose();
      }}
      title="编辑文件信息"
      description="修改备注不会影响链接；修改文件名会生成新的后台链接，旧链接仍可继续访问。"
      footer={
        <>
          <Button variant="secondary" disabled={savingFile} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="edit-file-form" variant="primary" loading={savingFile}>
            保存
          </Button>
        </>
      }
    >
      <form
        id="edit-file-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="edit-file-name" className="text-xs font-medium text-muted">
            文件名
          </label>
          <Input
            id="edit-file-name"
            value={editFileName}
            maxLength={180}
            disabled={savingFile}
            onChange={(event) => onChangeFileName(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-file-mime-select" className="text-xs font-medium text-muted">
              文件类型
            </label>
            <select
              id="edit-file-mime-select"
              value={selectedMimeType}
              disabled={savingFile}
              className="h-11 rounded-lg border border-border bg-surface px-3 text-[15px] text-foreground shadow-card outline-none transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
              onChange={(event) => {
                if (event.target.value !== "__custom") {
                  onChangeMimeType(event.target.value);
                }
              }}
            >
              {MIME_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-file-mime" className="text-xs font-medium text-muted">
              MIME
            </label>
            <Input
              id="edit-file-mime"
              value={editMimeType}
              maxLength={120}
              disabled={savingFile}
              placeholder="application/octet-stream"
              inputClassName="font-mono text-sm"
              onChange={(event) => onChangeMimeType(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="edit-file-remark" className="text-xs font-medium text-muted">
            备注
          </label>
          <Textarea
            id="edit-file-remark"
            value={editRemark}
            maxLength={1000}
            disabled={savingFile}
            placeholder="补充说明，留空则清除备注"
            onChange={(event) => onChangeRemark(event.target.value)}
          />
        </div>
        {editingFile && editFileName.trim() && editFileName.trim() !== editingFile.file_name ? (
          <p className="rounded-xl border border-warning/25 bg-warning-soft px-3 py-2 text-xs leading-5 text-warning">
            保存后，列表里复制的新链接会使用新文件名；已经分享出去的旧链接不会失效。
          </p>
        ) : null}
        {editingFile && normalizedMimeType && normalizedMimeType !== editingFile.mime_type ? (
          <p className="rounded-xl border border-border bg-muted px-3 py-2 text-xs leading-5 text-muted">
            文件类型只更新索引和预览识别，不会转换已存储的文件内容。
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
