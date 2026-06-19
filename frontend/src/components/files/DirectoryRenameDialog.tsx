import { Pencil } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import type { DirectoryItem } from "../../api";

interface DirectoryRenameDialogProps {
  renamingDirectory: DirectoryItem | null;
  renamingDirectorySaving: boolean;
  directoryRenameName: string;
  onClose: () => void;
  onChangeName: (value: string) => void;
  onSubmit: () => void;
}

export function DirectoryRenameDialog({
  renamingDirectory,
  renamingDirectorySaving,
  directoryRenameName,
  onClose,
  onChangeName,
  onSubmit
}: DirectoryRenameDialogProps) {
  return (
    <Modal
      open={Boolean(renamingDirectory)}
      onClose={() => {
        if (!renamingDirectorySaving) onClose();
      }}
      title="重命名目录"
      description={
        renamingDirectory
          ? `重命名 ${renamingDirectory.path}，会递归更新子目录和文件索引路径`
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" disabled={renamingDirectorySaving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="rename-directory-form"
            variant="primary"
            loading={renamingDirectorySaving}
            leadingIcon={<Pencil size={16} />}
          >
            保存
          </Button>
        </>
      }
    >
      <form
        id="rename-directory-form"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rename-directory-name" className="text-xs font-medium text-muted">
            新目录名称
          </label>
          <Input
            id="rename-directory-name"
            value={directoryRenameName}
            maxLength={80}
            disabled={renamingDirectorySaving}
            placeholder="例如 photos"
            onChange={(event) => onChangeName(event.target.value)}
          />
        </div>
        <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
          文件公开链接不会变化；如果同级目录已存在相同名称，保存会被拒绝。
        </p>
      </form>
    </Modal>
  );
}
