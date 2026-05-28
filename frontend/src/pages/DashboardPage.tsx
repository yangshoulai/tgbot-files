import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, Trash2 } from "lucide-react";
import {
  ApiError,
  FileItem,
  Pagination as PaginationType,
  SessionResponse,
  deleteFile,
  listFiles
} from "../api";
import { dateInputToIso, formatBytes, formatDateTime, sumFileSize } from "../utils";
import { useToast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { Input } from "../components/ui/Input";
import { IconButton } from "../components/ui/IconButton";
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

export function DashboardPage({ session, uploadVersion, copyText }: DashboardPageProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [files, setFiles] = useState<FileItem[]>([]);
  const [pagination, setPagination] = useState<PaginationType>(INITIAL_PAGINATION);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [uploadedFrom, setUploadedFrom] = useState("");
  const [uploadedTo, setUploadedTo] = useState("");
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [loading, setLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [detailFile, setDetailFile] = useState<FileItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const loadFiles = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      try {
        const response = await listFiles({
          q: query,
          page: nextPage,
          limit,
          type: typeFilter,
          created_from: dateInputToIso(uploadedFrom, "start"),
          created_to: dateInputToIso(uploadedTo, "end")
        });
        setFiles(response.files);
        setPagination(response.pagination);
      } catch (error) {
        toast.danger(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [limit, query, toast, typeFilter, uploadedFrom, uploadedTo]
  );

  useEffect(() => {
    void loadFiles(1);
  }, [loadFiles]);

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
        label: "全部文件",
        value: String(pagination.total),
        hint: `当前 ${pagination.page} / ${pagination.total_pages} 页`
      },
      {
        label: "当前页占用",
        value: formatBytes(sumFileSize(files)),
        hint: `${files.length} 个文件`
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
  }, [files, pagination.page, pagination.total, pagination.total_pages, session.config]);

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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">控制台</p>
          <h1 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">文件管理</h1>
          <p className="mt-1 text-sm text-muted">上传、检索、预览与分发存储在 Telegram 中的文件。</p>
        </div>
      </div>

      <MetricsRow metrics={metrics} />

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-card sm:p-4">
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(260px,1fr)_150px_150px_150px_auto] lg:items-center">
          <Input
            placeholder="搜索文件名、备注"
            leadingIcon={<Search size={15} />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
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
            <button
              type="button"
              onClick={() => void onBulkDelete()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-sm font-medium text-white shadow-card transition-colors hover:bg-danger-strong focus-visible:outline-none focus-visible:focus-ring"
            >
              <Trash2 size={15} />
              批量删除
            </button>
          </div>
        ) : null}

        <FileTable
          files={files}
          selectedIds={selectedIds}
          allPageSelected={allPageSelected}
          onToggleSelected={toggleSelected}
          onTogglePage={togglePage}
          onDetail={setDetailFile}
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
    </div>
  );
}
