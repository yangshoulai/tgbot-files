import { Copy, Download, Eye, Folder, FolderOpen, Info, MoveRight, Pencil, Trash2 } from "lucide-react";
import type { DirectoryItem, FileItem } from "../../api";
import { canPreview, formatBytes, formatDateTime } from "../../utils";
import { FileVisual } from "../ui/FileVisual";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";

interface FileTableProps {
  directories: DirectoryItem[];
  files: FileItem[];
  selectedIds: Set<string>;
  allPageSelected: boolean;
  onOpenDirectory: (directory: DirectoryItem) => void;
  onRenameDirectory: (directory: DirectoryItem) => void;
  onMoveDirectory: (directory: DirectoryItem) => void;
  onDeleteDirectory: (directory: DirectoryItem) => void;
  onToggleSelected: (file: FileItem, selected: boolean) => void;
  onTogglePage: (selected: boolean) => void;
  onDetail: (file: FileItem) => void;
  onEdit: (file: FileItem) => void;
  onMoveFile: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
  onCopy: (file: FileItem) => void;
  onDelete: (file: FileItem) => void;
}

const checkboxClass =
  "size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring";

export function FileTable({
  directories,
  files,
  selectedIds,
  allPageSelected,
  onOpenDirectory,
  onRenameDirectory,
  onMoveDirectory,
  onDeleteDirectory,
  onToggleSelected,
  onTogglePage,
  onDetail,
  onEdit,
  onMoveFile,
  onPreview,
  onCopy,
  onDelete
}: FileTableProps) {
  if (files.length === 0 && directories.length === 0) {
    return <EmptyState title="没有文件或子目录" description="试试调整搜索条件，或新建目录、上传文件。" />;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-background/60">
              <th className="w-10 px-4 py-3 text-left font-medium text-muted">
                <input
                  type="checkbox"
                  aria-label="选择当前页文件"
                  checked={allPageSelected}
                  disabled={files.length === 0}
                  onChange={(event) => onTogglePage(event.target.checked)}
                  className={checkboxClass}
                />
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">文件</th>
              <th className="hidden px-4 py-3 text-left font-medium text-muted lg:table-cell">大小</th>
              <th className="hidden px-4 py-3 text-left font-medium text-muted md:table-cell">上传时间</th>
              <th className="px-4 py-3 text-right font-medium text-muted">操作</th>
            </tr>
          </thead>
          <tbody>
            {directories.map((directory) => (
              <tr
                key={directory.id}
                className="border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-primary-soft/25"
              >
                <td className="px-4 py-3 align-middle" />
                <td className="px-4 py-3 align-middle">
                  <button
                    type="button"
                    onClick={() => onOpenDirectory(directory)}
                    className="flex min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:focus-ring"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong">
                      <Folder size={20} />
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-semibold text-foreground" title={directory.name}>
                        {directory.name}
                      </span>
                      <span className="truncate text-xs text-muted">{directory.path}</span>
                    </div>
                  </button>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted lg:table-cell">
                  目录
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                  {formatDateTime(directory.created_at)}
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center justify-end gap-1.5">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="进入目录"
                      onClick={() => onOpenDirectory(directory)}
                    >
                      <FolderOpen size={16} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="重命名目录"
                      onClick={() => onRenameDirectory(directory)}
                    >
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="移动目录"
                      onClick={() => onMoveDirectory(directory)}
                    >
                      <MoveRight size={16} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      size="sm"
                      label="删除目录"
                      onClick={() => onDeleteDirectory(directory)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
            {files.map((file) => (
              <tr
                key={file.id}
                className="border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-primary-soft/25"
              >
                <td className="px-4 py-3 align-middle">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${file.file_name}`}
                    checked={selectedIds.has(file.id)}
                    onChange={(event) => onToggleSelected(file, event.target.checked)}
                    className={checkboxClass}
                  />
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileVisual mimeType={file.mime_type} fileName={file.file_name} url={file.file_path} size="sm" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground" title={file.file_name}>
                        {file.file_name}
                      </span>
                      <span className="truncate text-xs text-muted lg:hidden">
                        {formatBytes(file.size)} · {file.mime_type}
                      </span>
                      <span className="hidden truncate text-xs text-muted lg:inline">{file.mime_type}</span>
                    </div>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-foreground lg:table-cell">
                  {formatBytes(file.size)}
                </td>
                <td className="hidden whitespace-nowrap px-4 py-3 align-middle text-sm text-muted md:table-cell">
                  {formatDateTime(file.created_at)}
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center justify-end gap-1.5">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="详情"
                      onClick={() => onDetail(file)}
                    >
                      <Info size={16} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="编辑文件信息"
                      onClick={() => onEdit(file)}
                    >
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="移动文件"
                      onClick={() => onMoveFile(file)}
                    >
                      <MoveRight size={16} />
                    </IconButton>
                    {canPreview(file) ? (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label="预览"
                        onClick={() => onPreview(file)}
                      >
                        <Eye size={16} />
                      </IconButton>
                    ) : null}
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label="复制链接"
                      onClick={() => onCopy(file)}
                    >
                      <Copy size={16} />
                    </IconButton>
                    <a
                      href={file.download_url}
                      title="下载"
                      aria-label="下载"
                      className="inline-grid size-8 place-items-center rounded-lg border border-transparent bg-transparent text-muted transition-colors duration-150 hover:bg-primary-soft hover:text-primary-strong"
                    >
                      <Download size={16} />
                    </a>
                    <IconButton
                      variant="danger"
                      size="sm"
                      label="删除索引"
                      onClick={() => onDelete(file)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
