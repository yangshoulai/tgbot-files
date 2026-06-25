import { AlertCircle, RefreshCw, Trash2 } from "lucide-react";
import type { FileItem } from "../../../api";
import { formatBytes, formatDateTime } from "../../../utils";
import { cn } from "../../../lib/cn";
import { hasFileLinkAccess } from "../../../lib/file-access";
import type { FileCacheEntry, FileCacheSummary } from "../../../lib/file-cache";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Modal } from "../../ui/Modal";
import { FileVisual } from "../../ui/FileVisual";
import { Spinner } from "../../ui/Spinner";

export type CacheOperation = { fileId: string; kind: "clear" } | null;

interface CacheManagerDialogProps {
  open: boolean;
  summary: FileCacheSummary | null;
  loading?: boolean;
  error?: string | null;
  operation: CacheOperation;
  cacheFileIndex: Map<string, FileItem>;
  onClose: () => void;
  onRefresh: () => void;
  onClearAutomatic: () => void;
  onClearFile: (entry: FileCacheEntry) => void;
}

export function CacheManagerDialog({
  open,
  summary,
  loading = false,
  error = null,
  operation,
  cacheFileIndex,
  onClose,
  onRefresh,
  onClearAutomatic,
  onClearFile
}: CacheManagerDialogProps) {
  const entries = summary?.entries ?? [];
  const hasCachedEntries = (summary?.totalBytes ?? 0) > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="缓存管理"
      description={`浏览器加载缓存占用 ${formatBytes(summary?.totalBytes ?? 0)}，最近显示 ${entries.length}/${summary?.entryCount ?? entries.length} 个文件`}
      size="full"
      className="h-[min(88dvh,56rem)] max-h-[88dvh] rounded-2xl border shadow-dialog sm:w-[min(96vw,96rem)] sm:max-w-[96rem]"
      bodyClassName="overflow-auto px-4 py-4 sm:px-5"
      footer={
        <>
          <Button variant="secondary" leadingIcon={<RefreshCw size={15} />} loading={loading} onClick={onRefresh}>
            刷新
          </Button>
          <Button variant="secondary" leadingIcon={<Trash2 size={15} />} disabled={!hasCachedEntries} onClick={onClearAutomatic}>
            清理缓存
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
        <div className="overflow-hidden rounded-2xl border border-border bg-background">
          {loading && !summary ? (
            <div className="grid min-h-60 place-items-center px-5 py-10 text-center">
              <div className="flex flex-col items-center gap-3">
                <span className="grid size-11 place-items-center rounded-full bg-primary-soft text-primary-strong">
                  <Spinner size={20} />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">正在读取缓存索引</p>
                  <p className="mt-1 text-xs text-muted">页面刷新后需要等待缓存 Service Worker 接管当前页面。</p>
                </div>
              </div>
            </div>
          ) : error && !summary ? (
            <div className="grid min-h-60 place-items-center px-5 py-10 text-center">
              <div className="flex max-w-md flex-col items-center gap-3">
                <span className="grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
                  <AlertCircle size={20} />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">缓存索引读取失败</p>
                  <p className="mt-1 text-xs leading-5 text-muted">{error}</p>
                </div>
                <Button variant="secondary" size="sm" leadingIcon={<RefreshCw size={15} />} loading={loading} onClick={onRefresh}>
                  重新读取
                </Button>
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-foreground">暂无缓存文件</p>
              <p className="mt-1 text-xs text-muted">预览或下载文件时会自动产生浏览器加载缓存。</p>
            </div>
          ) : (
            <div className="max-h-[min(70dvh,44rem)] overflow-y-auto overflow-x-hidden scroll-thin">
              {error ? (
                <div className="flex items-center gap-2 border-b border-warning/20 bg-warning-soft px-4 py-2 text-xs text-warning">
                  <AlertCircle size={14} className="shrink-0" />
                  <span className="min-w-0 truncate">缓存索引刷新失败，当前显示的是上次读取结果：{error}</span>
                </div>
              ) : null}
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[38%]" />
                  <col className="w-[12%]" />
                  <col className="w-[18%]" />
                  <col className="w-[14%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 border-b border-border bg-surface">
                  <tr className="text-left text-xs font-medium text-muted">
                    <th className="px-4 py-3">文件</th>
                    <th className="px-3 py-3">类型</th>
                    <th className="px-3 py-3">缓存进度</th>
                    <th className="px-3 py-3">空间</th>
                    <th className="px-3 py-3">最近访问</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const indexedFile = cacheFileIndex.get(entry.fileId);
                    const displayFileName = indexedFile?.file_name || entry.fileName;
                    const directoryPath = indexedFile?.directory_path || entry.directoryPath || "/";
                    const displayEntry = mergeCacheEntryWithIndexedFile(entry, indexedFile);
                    const entryOperation = operation?.fileId === entry.fileId ? operation.kind : null;
                    const progress = fileCacheProgressPercent(displayEntry);
                    const statusLabel = cacheEntryStatusLabel(displayEntry);
                    const actionDisabled = Boolean(entryOperation);

                    return (
                      <tr key={entry.fileId} className="border-b border-border last:border-b-0 hover:bg-primary-soft/20">
                        <td className="min-w-0 px-4 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <FileVisual
                              mimeType={indexedFile?.mime_type || entry.mimeType || "application/octet-stream"}
                              fileName={displayFileName}
                              url={cacheEntryVisualUrl(displayEntry, indexedFile)}
                              thumbnailUrl={indexedFile?.thumbnail_url}
                              size="sm"
                              className="size-12 rounded-lg bg-surface"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-foreground" title={displayFileName}>{displayFileName}</p>
                              <p className="mt-1 truncate text-xs text-subtle" title={directoryPath}>{directoryPath}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="w-fit rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted">
                              {entry.kind === "hls" ? "HLS" : entry.kind === "multipart" ? "分片" : "普通"}
                            </span>
                            <span className="truncate text-xs text-subtle" title={entry.mimeType || "未知"}>
                              {entry.mimeType || "未知"}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-2">
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span className="font-medium text-foreground">{progress}%</span>
                              <span className="truncate text-muted">{displayEntry.cachedChunks}/{displayEntry.chunkCount} 分片</span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-border">
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium text-foreground">{formatBytes(displayEntry.cachedBytes)}</span>
                            <span className="text-xs text-muted">共 {formatBytes(displayEntry.size)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 flex-col gap-1.5">
                            <span className={cn(
                              "w-fit rounded-full px-2 py-0.5 text-xs font-medium",
                              entry.complete
                                ? "bg-success-soft text-success"
                                : "bg-surface text-muted ring-1 ring-border"
                            )}>
                              {statusLabel}
                            </span>
                            <span className="text-xs text-subtle">{formatAccessTime(entry.lastAccessed)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <IconButton
                              size="sm"
                              variant="danger"
                              label={entryOperation === "clear" ? "清理中" : `清除缓存（${formatBytes(entry.cachedBytes)}）`}
                              disabled={actionDisabled || entry.cachedBytes <= 0}
                              onClick={() => onClearFile(entry)}
                            >
                              <Trash2 size={16} />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
    </Modal>
  );
}

function fileCacheProgressPercent(entry: FileCacheEntry): number {
  if (entry.chunkCount > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedChunks / entry.chunkCount) * 100)));
  }
  if (entry.complete) return 100;
  if (entry.size > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedBytes / entry.size) * 100)));
  }
  return 0;
}

function mergeCacheEntryWithIndexedFile(entry: FileCacheEntry, indexedFile: FileItem | undefined): FileCacheEntry {
  if (!indexedFile) return entry;

  const chunkCount = indexedFile.storage_backend === "hls_package"
    ? Math.max(1, indexedFile.hls_download?.part_count ?? indexedFile.hls_download?.segment_count ?? entry.chunkCount)
    : indexedFile.chunk_count && indexedFile.chunk_count > 0
      ? indexedFile.chunk_count
      : entry.chunkCount;
  const chunkSize = indexedFile.storage_backend === "hls_package"
    ? Math.max(1, Math.ceil(indexedFile.size / chunkCount))
    : indexedFile.chunk_size && indexedFile.chunk_size > 0
      ? indexedFile.chunk_size
      : entry.chunkSize;

  // 缓存记录可能来自 Service Worker，需要用文件索引补齐名称、目录和分片信息。
  return {
    ...entry,
    fileName: indexedFile.file_name || entry.fileName,
    directoryPath: indexedFile.directory_path || entry.directoryPath || "/",
    mimeType: indexedFile.mime_type || entry.mimeType,
    size: indexedFile.size || entry.size,
    chunkSize,
    chunkCount,
    complete: entry.cachedChunks >= chunkCount && chunkCount > 0,
    sourceUrl: hasFileLinkAccess(indexedFile) ? indexedFile.file_path : entry.sourceUrl
  };
}

function cacheEntryStatusLabel(entry: FileCacheEntry): string {
  if (entry.complete) return "已完成";
  return "部分缓存";
}

function formatAccessTime(value: number): string {
  return value > 0 ? formatDateTime(new Date(value).toISOString()) : "未知";
}

function cacheEntryVisualUrl(entry: FileCacheEntry, indexedFile: FileItem | undefined): string | undefined {
  if (indexedFile && hasFileLinkAccess(indexedFile)) {
    return indexedFile.url;
  }

  return entry.sourceUrl;
}
