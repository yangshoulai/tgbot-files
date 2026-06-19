import { FolderPlus } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { DirectoryTree } from "./DirectoryTree";
import type { DirectoryItem } from "../../api";

interface CreateDirectoryDialogProps {
  open: boolean;
  creatingDir: boolean;
  createDirParentPath: string;
  newDirName: string;
  directoryOptions: DirectoryItem[];
  onClose: () => void;
  onCancel: () => void;
  onChangeParentPath: (value: string) => void;
  onChangeName: (value: string) => void;
  onSubmit: () => void;
}

export function CreateDirectoryDialog({
  open,
  creatingDir,
  createDirParentPath,
  newDirName,
  directoryOptions,
  onClose,
  onCancel,
  onChangeParentPath,
  onChangeName,
  onSubmit
}: CreateDirectoryDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!creatingDir) {
          onClose();
        }
      }}
      title="新建目录"
      description="选择上级目录后创建新的虚拟子目录；默认创建在根目录。"
      size="lg"
      footer={
        <>
          <Button
            variant="secondary"
            disabled={creatingDir}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="create-directory-form"
            variant="primary"
            loading={creatingDir}
            leadingIcon={<FolderPlus size={16} />}
          >
            创建
          </Button>
        </>
      }
    >
      <form
        id="create-directory-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">
            上级目录
          </span>
          <DirectoryTree
            id="create-directory-parent"
            ariaLabel="新目录上级目录"
            value={createDirParentPath}
            directories={directoryOptions}
            disabled={creatingDir}
            onChange={onChangeParentPath}
            treeClassName="max-h-[min(30rem,64dvh)]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="directory-name" className="text-xs font-medium text-muted">
            目录名称
          </label>
          <Input
            id="directory-name"
            value={newDirName}
            placeholder="例如 photos"
            maxLength={80}
            disabled={creatingDir}
            onChange={(event) => onChangeName(event.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}
