import { FolderInput } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { DirectoryTree } from "./DirectoryTree";
import type { DirectoryItem } from "../../api";

interface DirectoryMoveDialogProps {
  movingDirectory: DirectoryItem | null;
  movingDirectorySaving: boolean;
  directoryMoveTargetPath: string;
  directoryMoveTargets: DirectoryItem[];
  onClose: () => void;
  onChangeTargetPath: (value: string) => void;
  onSubmit: () => void;
}

export function DirectoryMoveDialog({
  movingDirectory,
  movingDirectorySaving,
  directoryMoveTargetPath,
  directoryMoveTargets,
  onClose,
  onChangeTargetPath,
  onSubmit
}: DirectoryMoveDialogProps) {
  return (
    <Modal
      open={Boolean(movingDirectory)}
      onClose={() => {
        if (!movingDirectorySaving) onClose();
      }}
      title="移动目录"
      description={
        movingDirectory
          ? `将 ${movingDirectory.path} 移动到目标目录下，目录名保持为 ${movingDirectory.name}`
          : undefined
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" disabled={movingDirectorySaving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="move-directory-form"
            variant="primary"
            loading={movingDirectorySaving}
            leadingIcon={<FolderInput size={16} />}
          >
            移动目录
          </Button>
        </>
      }
    >
      <form
        id="move-directory-form"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">
            目标父目录
          </span>
          <DirectoryTree
            id="move-directory-target"
            ariaLabel="目标父目录"
            value={directoryMoveTargetPath}
            directories={directoryMoveTargets}
            disabled={movingDirectorySaving}
            onChange={onChangeTargetPath}
            treeClassName="max-h-[min(30rem,64dvh)]"
          />
        </div>
        {movingDirectory ? (
          <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
            会递归更新该目录、所有子目录和其中所有文件索引的虚拟路径；文件公开链接不会变化。
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
