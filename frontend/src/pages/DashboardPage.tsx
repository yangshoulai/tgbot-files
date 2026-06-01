import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, ChevronRight, FolderPlus, MoveRight, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  ApiError,
  DirectoryItem,
  FileItem,
  Pagination as PaginationType,
  SessionResponse,
  createDirectory,
  deleteDirectory,
  deleteFile,
  listDirectories,
  listFiles,
  moveDirectory,
  moveFiles,
  renameDirectory,
  updateFileMetadata
} from "../api";
import { dateInputToIso, formatBytes, formatDateTime, sumFileSize } from "../utils";
import { useToast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Textarea } from "../components/ui/Textarea";
import { Spinner } from "../components/ui/Spinner";
import { MetricsRow, Metric } from "../components/files/MetricsRow";
import { FileTable } from "../components/files/FileTable";
import { Pagination } from "../components/files/Pagination";
import { PreviewDialog } from "../components/files/PreviewDialog";
import { FileDetailDialog } from "../components/files/FileDetailDialog";

type FileTypeFilter = "all" | "image" | "text" | "pdf" | "archive" | "other";

interface DashboardPageProps {
  session: SessionResponse;
  uploadVersion: number;
  copyText: (value: string) => void;
  onDirectoryChange: (path: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

const INITIAL_LIMIT = 20;
const INITIAL_PAGINATION: PaginationType = { page: 1, limit: INITIAL_LIMIT, total: 0, total_pages: 1 };
const FILE_TYPE_OPTIONS: Array<{ value: FileTypeFilter; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "text", label: "文本" },
  { value: "pdf", label: "PDF" },
  { value: "archive", label: "压缩包" },
  { value: "other", label: "其他" }
];

function parentDirectoryPath(path: string): string {
  if (path === "/") return "/";
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function directoryBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const segments = path.split("/").filter(Boolean);
  const breadcrumbs = [{ label: "/", path: "/" }];
  let current = "";

  for (const segment of segments) {
    current += `/${segment}`;
    breadcrumbs.push({ label: segment, path: current });
  }

  return breadcrumbs;
}

function directoryOptionLabel(path: string): string {
  if (path === "/") return "/ 根目录";
  return path;
}

export function DashboardPage({ session, uploadVersion, copyText, onDirectoryChange }: DashboardPageProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [files, setFiles] = useState<FileItem[]>([]);
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [directoryOptions, setDirectoryOptions] = useState<DirectoryItem[]>([]);
  const [currentDirPath, setCurrentDirPath] = useState("/");
  const [pagination, setPagination] = useState<PaginationType>(INITIAL_PAGINATION);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [uploadedFrom, setUploadedFrom] = useState("");
  const [uploadedTo, setUploadedTo] = useState("");
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [loading, setLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [detailFile, setDetailFile] = useState<FileItem | null>(null);
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [editFileName, setEditFileName] = useState("");
  const [editRemark, setEditRemark] = useState("");
  const [savingFile, setSavingFile] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [createDirOpen, setCreateDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFileIds, setMoveFileIds] = useState<string[]>([]);
  const [moveTargetPath, setMoveTargetPath] = useState("/");
  const [moveCreateNew, setMoveCreateNew] = useState(false);
  const [moveNewParentPath, setMoveNewParentPath] = useState("/");
  const [moveNewDirName, setMoveNewDirName] = useState("");
  const [movingFiles, setMovingFiles] = useState(false);
  const [movingDirectory, setMovingDirectory] = useState<DirectoryItem | null>(null);
  const [directoryMoveTargetPath, setDirectoryMoveTargetPath] = useState("/");
  const [movingDirectorySaving, setMovingDirectorySaving] = useState(false);
  const [renamingDirectory, setRenamingDirectory] = useState<DirectoryItem | null>(null);
  const [directoryRenameName, setDirectoryRenameName] = useState("");
  const [renamingDirectorySaving, setRenamingDirectorySaving] = useState(false);

  const loadFiles = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      try {
        const response = await listFiles({
          q: query,
          page: nextPage,
          limit,
          dir: currentDirPath,
          type: typeFilter,
          created_from: dateInputToIso(uploadedFrom, "start"),
          created_to: dateInputToIso(uploadedTo, "end")
        });
        setDirectories(response.directories);
        setFiles(response.files);
        setPagination(response.pagination);
      } catch (error) {
        toast.danger(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [currentDirPath, limit, query, toast, typeFilter, uploadedFrom, uploadedTo]
  );

  const loadDirectoryOptions = useCallback(async () => {
    try {
      const response = await listDirectories(true);
      setDirectoryOptions(response.directories);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }, [toast]);

  useEffect(() => {
    void loadFiles(1);
  }, [loadFiles]);

  useEffect(() => {
    void loadDirectoryOptions();
  }, [loadDirectoryOptions]);

  useEffect(() => {
    onDirectoryChange(currentDirPath);
  }, [currentDirPath, onDirectoryChange]);

  useEffect(() => {
    if (uploadVersion > 0) {
      void loadFiles(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadVersion]);

  useEffect(() => {
    const visibleIds = new Set(files.map((file) => file.id));
    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [files]);

  const metrics = useMemo<Metric[]>(() => {
    const latest = files[0];
    return [
      {
        label: "目录文件",
        value: String(pagination.total),
        hint: `${currentDirPath} · ${pagination.page} / ${pagination.total_pages} 页`
      },
      {
        label: "当前页占用",
        value: formatBytes(sumFileSize(files)),
        hint: `${directories.length} 个子目录 · ${files.length} 个文件`
      },
      {
        label: "最近上传",
        value: latest ? formatDateTime(latest.created_at).slice(5, 16) : "暂无",
        hint: latest?.file_name ?? "尚未上传"
      },
      {
        label: "存储后端",
        value:
          session.config.telegram_bot_token && session.config.telegram_storage_chat_id ? "已连接" : "未配置",
        hint: "Telegram Bot API"
      }
    ];
  }, [currentDirPath, directories.length, files, pagination.page, pagination.total, pagination.total_pages, session.config]);

  async function onDelete(file: FileItem) {
    const ok = await confirm({
      title: "删除该文件索引？",
      description: (
        <>
          将从控制台移除 <span className="font-mono text-foreground">{file.file_name}</span>。
          Telegram 中的原始消息和已分发的签名链接不会被影响。
        </>
      ),
      tone: "danger",
      confirmText: "删除"
    });
    if (!ok) return;

    try {
      await deleteFile(file.id);
      toast.success("索引已删除");
      if (previewFile?.id === file.id) setPreviewFile(null);
      if (detailFile?.id === file.id) setDetailFile(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(file.id);
        return next;
      });
      const targetPage = files.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      await loadFiles(targetPage);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }

  async function onBulkDelete() {
    const targets = files.filter((file) => selectedIds.has(file.id));
    if (targets.length === 0) return;

    const ok = await confirm({
      title: `删除选中的 ${targets.length} 个文件索引？`,
      description: "只会从控制台移除索引；Telegram 中的原始消息和已分发的签名链接不会被影响。",
      tone: "danger",
      confirmText: "批量删除"
    });
    if (!ok) return;

    try {
      await Promise.all(targets.map((file) => deleteFile(file.id)));
      toast.success(`已删除 ${targets.length} 个文件索引`);
      if (previewFile && targets.some((file) => file.id === previewFile.id)) setPreviewFile(null);
      if (detailFile && targets.some((file) => file.id === detailFile.id)) setDetailFile(null);
      setSelectedIds(new Set());
      const targetPage = targets.length === files.length && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      await loadFiles(targetPage);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }

  async function onCreateDirectory() {
    const name = newDirName.trim();
    if (!name) {
      toast.danger("请输入目录名称");
      return;
    }

    setCreatingDir(true);
    try {
      await createDirectory(currentDirPath, name);
      toast.success("目录已创建");
      setCreateDirOpen(false);
      setNewDirName("");
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCreatingDir(false);
    }
  }

  async function onDeleteDirectory(directory: DirectoryItem) {
    const ok = await confirm({
      title: `删除目录 ${directory.name}？`,
      description: (
        <>
          将递归删除 <span className="font-mono text-foreground">{directory.path}</span>{" "}
          下的所有子目录和文件索引。Telegram 中的原始消息和已分发的签名链接不会被影响。
        </>
      ),
      tone: "danger",
      confirmText: "递归删除"
    });
    if (!ok) return;

    try {
      const result = await deleteDirectory(directory.id);
      toast.success(`已删除 ${result.deleted_directories} 个目录、${result.deleted_files} 个文件索引`);
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }

  function openRenameDirectoryDialog(directory: DirectoryItem) {
    setRenamingDirectory(directory);
    setDirectoryRenameName(directory.name);
  }

  async function onRenameDirectory() {
    if (!renamingDirectory) return;

    const name = directoryRenameName.trim();
    if (!name) {
      toast.danger("请输入目录名称");
      return;
    }

    setRenamingDirectorySaving(true);
    try {
      const result = await renameDirectory(renamingDirectory.id, name);
      toast.success(`已重命名 ${result.renamed_directories} 个目录、更新 ${result.updated_files} 个文件索引`);
      setRenamingDirectory(null);
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setRenamingDirectorySaving(false);
    }
  }

  function openMoveDirectoryDialog(directory: DirectoryItem) {
    const currentParent = parentDirectoryPath(directory.path);
    const firstOtherTarget = directoryOptions.find((option) =>
      option.path !== directory.path &&
      !option.path.startsWith(`${directory.path}/`) &&
      option.path !== currentParent
    );
    setMovingDirectory(directory);
    setDirectoryMoveTargetPath(currentParent === "/" && firstOtherTarget ? firstOtherTarget.path : "/");
    void loadDirectoryOptions();
  }

  async function onMoveDirectory() {
    if (!movingDirectory) return;

    setMovingDirectorySaving(true);
    try {
      const result = await moveDirectory(movingDirectory.id, directoryMoveTargetPath);
      toast.success(`已移动 ${result.moved_directories} 个目录、${result.moved_files} 个文件索引到 ${result.directory.path}`);
      setMovingDirectory(null);
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMovingDirectorySaving(false);
    }
  }

  function openMoveDialog(file?: FileItem) {
    const ids = file ? [file.id] : files.filter((item) => selectedIds.has(item.id)).map((item) => item.id);
    if (ids.length === 0) return;
    setMoveFileIds(ids);
    setMoveTargetPath(currentDirPath);
    setMoveNewParentPath(currentDirPath);
    setMoveNewDirName("");
    setMoveCreateNew(false);
    setMoveOpen(true);
    void loadDirectoryOptions();
  }

  function openEditDialog(file: FileItem) {
    setEditingFile(file);
    setEditFileName(file.file_name);
    setEditRemark(file.remark ?? "");
  }

  async function onSaveFileMetadata() {
    if (!editingFile) return;

    const nextName = editFileName.trim();
    if (!nextName) {
      toast.danger("请输入文件名");
      return;
    }

    setSavingFile(true);
    try {
      const response = await updateFileMetadata(editingFile.id, {
        file_name: nextName,
        remark: editRemark
      });
      const updated = response.file;
      setFiles((current) => current.map((file) => (file.id === updated.id ? updated : file)));
      if (previewFile?.id === updated.id) setPreviewFile(updated);
      if (detailFile?.id === updated.id) setDetailFile(updated);
      setEditingFile(null);
      toast.success(updated.file_path !== editingFile.file_path ? "文件信息已保存，链接已更新" : "文件信息已保存");
      await loadFiles(pagination.page);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSavingFile(false);
    }
  }

  async function onMoveSelected() {
    const ids = moveFileIds;
    if (ids.length === 0) return;

    const newName = moveNewDirName.trim();
    if (moveCreateNew && !newName) {
      toast.danger("请输入新目录名称");
      return;
    }

    setMovingFiles(true);
    try {
      const result = await moveFiles(
        moveCreateNew
          ? {
              file_ids: ids,
              new_directory_parent_path: moveNewParentPath,
              new_directory_name: newName
            }
          : {
              file_ids: ids,
              directory_path: moveTargetPath
            }
      );
      toast.success(`已移动 ${result.moved} 个文件到 ${result.directory_path}`);
      setMoveOpen(false);
      setMoveFileIds([]);
      setSelectedIds(new Set());
      await Promise.all([loadFiles(pagination.page), loadDirectoryOptions()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMovingFiles(false);
    }
  }

  function goToDirectory(path: string) {
    setCurrentDirPath(path);
    setSelectedIds(new Set());
  }

  function onCopy(file: FileItem) {
    copyText(file.url);
  }

  function toggleSelected(file: FileItem, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(file.id);
      } else {
        next.delete(file.id);
      }
      return next;
    });
  }

  function togglePage(selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const file of files) {
        if (selected) {
          next.add(file.id);
        } else {
          next.delete(file.id);
        }
      }
      return next;
    });
  }

  const allPageSelected = files.length > 0 && files.every((file) => selectedIds.has(file.id));
  const selectedCount = files.filter((file) => selectedIds.has(file.id)).length;
  const directoryMoveTargets = useMemo(() => {
    if (!movingDirectory) {
      return directoryOptions;
    }

    return directoryOptions.filter((directory) =>
      directory.id !== movingDirectory.id &&
      !directory.path.startsWith(`${movingDirectory.path}/`)
    );
  }, [directoryOptions, movingDirectory]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">控制台</p>
          <h1 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">文件管理</h1>
          <p className="mt-1 text-sm text-muted">上传、检索、预览与分发存储在 Telegram 中的文件。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            leadingIcon={<ArrowUp size={16} />}
            disabled={currentDirPath === "/"}
            onClick={() => goToDirectory(parentDirectoryPath(currentDirPath))}
          >
            返回上级
          </Button>
          <Button
            variant="primary"
            leadingIcon={<FolderPlus size={16} />}
            onClick={() => setCreateDirOpen(true)}
          >
            新建目录
          </Button>
        </div>
      </div>

      <MetricsRow metrics={metrics} />

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-card sm:p-4">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-background/60 px-3 py-2">
          {directoryBreadcrumbs(currentDirPath).map((item, index, array) => (
            <div key={item.path} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => goToDirectory(item.path)}
                className="rounded-md px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-primary-soft hover:text-primary-strong focus-visible:outline-none focus-visible:focus-ring"
              >
                {item.label}
              </button>
              {index < array.length - 1 ? <ChevronRight size={14} className="text-subtle" /> : null}
            </div>
          ))}
          {query.trim() ? (
            <span className="ml-auto rounded-full bg-primary-soft px-2 py-1 text-xs font-medium text-primary-strong">
              当前目录内搜索
            </span>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(240px,1fr)_220px_145px_145px_145px_auto] xl:items-center">
          <Input
            placeholder="搜索文件名、备注"
            leadingIcon={<Search size={15} />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="目录过滤"
            value={currentDirPath}
            onChange={(event) => goToDirectory(event.target.value)}
            className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
          >
            <option value="/">{directoryOptionLabel("/")}</option>
            {directoryOptions.map((directory) => (
              <option key={directory.id} value={directory.path}>
                {directoryOptionLabel(directory.path)}
              </option>
            ))}
          </select>
          <select
            aria-label="文件类型过滤"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as FileTypeFilter)}
            className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
          >
            {FILE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Input
            type="date"
            aria-label="上传开始时间"
            value={uploadedFrom}
            onChange={(event) => setUploadedFrom(event.target.value)}
          />
          <Input
            type="date"
            aria-label="上传结束时间"
            value={uploadedTo}
            onChange={(event) => setUploadedTo(event.target.value)}
          />
          <div className="flex items-center justify-end">
            <IconButton
              variant="default"
              label="刷新"
              onClick={() => void loadFiles(pagination.page)}
            >
              {loading ? <Spinner size={16} /> : <RefreshCw size={16} />}
            </IconButton>
          </div>
        </div>

        {selectedCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2">
            <p className="text-sm font-medium text-danger">已选 {selectedCount} 个文件</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => openMoveDialog()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground shadow-card transition-colors hover:border-border-strong hover:bg-background focus-visible:outline-none focus-visible:focus-ring"
              >
                <MoveRight size={15} />
                移动
              </button>
              <button
                type="button"
                onClick={() => void onBulkDelete()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-sm font-medium text-white shadow-card transition-colors hover:bg-danger-strong focus-visible:outline-none focus-visible:focus-ring"
              >
                <Trash2 size={15} />
                批量删除
              </button>
            </div>
          </div>
        ) : null}

        <FileTable
          directories={directories}
          files={files}
          selectedIds={selectedIds}
          allPageSelected={allPageSelected}
          onOpenDirectory={(directory) => goToDirectory(directory.path)}
          onRenameDirectory={openRenameDirectoryDialog}
          onMoveDirectory={openMoveDirectoryDialog}
          onDeleteDirectory={(directory) => void onDeleteDirectory(directory)}
          onToggleSelected={toggleSelected}
          onTogglePage={togglePage}
          onDetail={setDetailFile}
          onEdit={openEditDialog}
          onMoveFile={openMoveDialog}
          onPreview={setPreviewFile}
          onCopy={onCopy}
          onDelete={onDelete}
        />

        <Pagination
          pagination={pagination}
          onPage={(page) => void loadFiles(page)}
          onLimitChange={(nextLimit) => setLimit(nextLimit)}
        />
      </div>

      <PreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} onCopy={copyText} />
      <FileDetailDialog file={detailFile} onClose={() => setDetailFile(null)} onCopy={copyText} />

      <Modal
        open={Boolean(editingFile)}
        onClose={() => {
          if (!savingFile) setEditingFile(null);
        }}
        title="编辑文件信息"
        description="修改备注不会影响链接；修改文件名会生成新的后台链接，旧链接仍可继续访问。"
        footer={
          <>
            <Button variant="secondary" disabled={savingFile} onClick={() => setEditingFile(null)}>
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
            void onSaveFileMetadata();
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
              onChange={(event) => setEditFileName(event.target.value)}
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
              onChange={(event) => setEditRemark(event.target.value)}
            />
          </div>
          {editingFile && editFileName.trim() && editFileName.trim() !== editingFile.file_name ? (
            <p className="rounded-xl border border-warning/25 bg-warning-soft px-3 py-2 text-xs leading-5 text-warning">
              保存后，列表里复制的新链接会使用新文件名；已经分享出去的旧链接不会失效。
            </p>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={createDirOpen}
        onClose={() => {
          if (!creatingDir) {
            setCreateDirOpen(false);
            setNewDirName("");
          }
        }}
        title="新建目录"
        description={`将在 ${currentDirPath} 下创建子目录`}
        footer={
          <>
            <Button variant="secondary" disabled={creatingDir} onClick={() => setCreateDirOpen(false)}>
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
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreateDirectory();
          }}
        >
          <label htmlFor="directory-name" className="text-xs font-medium text-muted">
            目录名称
          </label>
          <Input
            id="directory-name"
            value={newDirName}
            placeholder="例如 photos"
            maxLength={80}
            disabled={creatingDir}
            onChange={(event) => setNewDirName(event.target.value)}
          />
        </form>
      </Modal>

      <Modal
        open={Boolean(movingDirectory)}
        onClose={() => {
          if (!movingDirectorySaving) setMovingDirectory(null);
        }}
        title="移动目录"
        description={
          movingDirectory
            ? `将 ${movingDirectory.path} 移动到目标目录下，目录名保持为 ${movingDirectory.name}`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" disabled={movingDirectorySaving} onClick={() => setMovingDirectory(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form="move-directory-form"
              variant="primary"
              loading={movingDirectorySaving}
              leadingIcon={<MoveRight size={16} />}
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
            void onMoveDirectory();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="move-directory-target" className="text-xs font-medium text-muted">
              目标父目录
            </label>
            <select
              id="move-directory-target"
              value={directoryMoveTargetPath}
              disabled={movingDirectorySaving}
              onChange={(event) => setDirectoryMoveTargetPath(event.target.value)}
              className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
            >
              <option value="/">{directoryOptionLabel("/")}</option>
              {directoryMoveTargets.map((directory) => (
                <option key={directory.id} value={directory.path}>
                  {directoryOptionLabel(directory.path)}
                </option>
              ))}
            </select>
          </div>
          {movingDirectory ? (
            <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
              会递归更新该目录、所有子目录和其中所有文件索引的虚拟路径；文件公开链接不会变化。
            </p>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={Boolean(renamingDirectory)}
        onClose={() => {
          if (!renamingDirectorySaving) setRenamingDirectory(null);
        }}
        title="重命名目录"
        description={
          renamingDirectory
            ? `重命名 ${renamingDirectory.path}，会递归更新子目录和文件索引路径`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" disabled={renamingDirectorySaving} onClick={() => setRenamingDirectory(null)}>
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
            void onRenameDirectory();
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
              onChange={(event) => setDirectoryRenameName(event.target.value)}
            />
          </div>
          <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
            文件公开链接不会变化；如果同级目录已存在相同名称，保存会被拒绝。
          </p>
        </form>
      </Modal>

      <Modal
        open={moveOpen}
        onClose={() => {
          if (!movingFiles) {
            setMoveOpen(false);
            setMoveFileIds([]);
          }
        }}
        title="移动文件"
        description={`将 ${moveFileIds.length} 个文件移动到其他目录`}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={movingFiles}
              onClick={() => {
                setMoveOpen(false);
                setMoveFileIds([]);
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="move-files-form"
              variant="primary"
              loading={movingFiles}
              leadingIcon={<MoveRight size={16} />}
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
            void onMoveSelected();
          }}
        >
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={moveCreateNew}
              disabled={movingFiles}
              onChange={(event) => setMoveCreateNew(event.target.checked)}
              className="size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring"
            />
            移动到新目录
          </label>

          {moveCreateNew ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="move-new-parent" className="text-xs font-medium text-muted">
                  父目录
                </label>
                <select
                  id="move-new-parent"
                  value={moveNewParentPath}
                  disabled={movingFiles}
                  onChange={(event) => setMoveNewParentPath(event.target.value)}
                  className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
                >
                  <option value="/">{directoryOptionLabel("/")}</option>
                  {directoryOptions.map((directory) => (
                    <option key={directory.id} value={directory.path}>
                      {directoryOptionLabel(directory.path)}
                    </option>
                  ))}
                </select>
              </div>
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
                  onChange={(event) => setMoveNewDirName(event.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="move-target" className="text-xs font-medium text-muted">
                目标目录
              </label>
              <select
                id="move-target"
                value={moveTargetPath}
                disabled={movingFiles}
                onChange={(event) => setMoveTargetPath(event.target.value)}
                className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
              >
                <option value="/">{directoryOptionLabel("/")}</option>
                {directoryOptions.map((directory) => (
                  <option key={directory.id} value={directory.path}>
                    {directoryOptionLabel(directory.path)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
