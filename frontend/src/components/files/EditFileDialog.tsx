import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import type { FileItem } from "../../api";

interface EditFileDialogProps {
  editingFile: FileItem | null;
  editFileName: string;
  editRemark: string;
  savingFile: boolean;
  onClose: () => void;
  onChangeFileName: (value: string) => void;
  onChangeRemark: (value: string) => void;
  onSubmit: () => void;
}

export function EditFileDialog({
  editingFile,
  editFileName,
  editRemark,
  savingFile,
  onClose,
  onChangeFileName,
  onChangeRemark,
  onSubmit
}: EditFileDialogProps) {
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
      </form>
    </Modal>
  );
}
