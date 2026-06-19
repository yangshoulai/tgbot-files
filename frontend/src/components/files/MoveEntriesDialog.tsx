import { FolderInput } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { DirectoryTree } from "./DirectoryTree";
import type { DirectoryItem } from "../../api";

interface MoveEntriesDialogProps {
  open: boolean;
  movingFiles: boolean;
  moveFileIds: string[];
  moveDirectoryIds: string[];
  moveCreateNew: boolean;
  moveNewDirName: string;
  moveNewParentPath: string;
  moveTargetPath: string;
  bulkMoveTargets: DirectoryItem[];
  onClose: () => void;
  onChangeCreateNew: (value: boolean) => void;
  onChangeNewDirName: (value: string) => void;
  onChangeNewParentPath: (value: string) => void;
  onChangeTargetPath: (value: string) => void;
  onSubmit: () => void;
}

export function MoveEntriesDialog({
  open,
  movingFiles,
  moveFileIds,
  moveDirectoryIds,
  moveCreateNew,
  moveNewDirName,
  moveNewParentPath,
  moveTargetPath,
  bulkMoveTargets,
  onClose,
  onChangeCreateNew,
  onChangeNewDirName,
  onChangeNewParentPath,
  onChangeTargetPath,
  onSubmit
}: MoveEntriesDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!movingFiles) {
          onClose();
        }
      }}
      title="移动项目"
      description={`将 ${moveDirectoryIds.length} 个目录、${moveFileIds.length} 个文件移动到其他目录`}
      size="lg"
      footer={
        <>
          <Button
            variant="secondary"
            disabled={movingFiles}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="move-files-form"
            variant="primary"
            loading={movingFiles}
            leadingIcon={<FolderInput size={16} />}
          >
            移动
          </Button>
        </>
      }
    >
      <form
        id="move-files-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={moveCreateNew}
            disabled={movingFiles}
            onChange={(event) => onChangeCreateNew(event.target.checked)}
            className="size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring"
          />
          移动到新目录
        </label>

        {moveCreateNew ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="move-new-name" className="text-xs font-medium text-muted">
                新目录名称
              </label>
              <Input
                id="move-new-name"
                value={moveNewDirName}
                placeholder="例如 2026"
                maxLength={80}
                disabled={movingFiles}
                onChange={(event) => onChangeNewDirName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">
                父目录
              </span>
              <DirectoryTree
                id="move-new-parent"
                ariaLabel="父目录"
                value={moveNewParentPath}
                directories={bulkMoveTargets}
                disabled={movingFiles}
                onChange={onChangeNewParentPath}
                treeClassName="max-h-[min(30rem,62dvh)]"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">
              目标目录
            </span>
            <DirectoryTree
              id="move-target"
              ariaLabel="目标目录"
              value={moveTargetPath}
              directories={bulkMoveTargets}
              disabled={movingFiles}
              onChange={onChangeTargetPath}
              treeClassName="max-h-[min(30rem,64dvh)]"
            />
          </div>
        )}
      </form>
    </Modal>
  );
}
