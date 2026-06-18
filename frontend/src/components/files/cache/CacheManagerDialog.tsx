import { useEffect, useState } from "react";
import { Play, RefreshCw, Square, Trash2 } from "lucide-react";
import type { FileItem } from "../../../api";
import { formatBytes } from "../../../utils";
import { cn } from "../../../lib/cn";
import { hasFileLinkAccess } from "../../../lib/file-access";
import type { FileCacheEntry, FileCacheSummary } from "../../../lib/file-cache";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Modal } from "../../ui/Modal";
import { FileVisual } from "../../ui/FileVisual";

export type CacheOperation = { fileId: string; kind: "cache" | "pause" | "resume" | "terminate" | "clear" } | null;

interface CacheManagerDialogProps {
  open: boolean;
  summary: FileCacheSummary | null;
  operation: CacheOperation;
  cacheFileIndex: Map<string, FileItem>;
  onClose: () => void;
  onRefresh: () => void;
  onClearAutomatic: () => void;
  onPauseFile: (entry: FileCacheEntry) => void;
  onResumeFile: (entry: FileCacheEntry) => void;
  onTerminateFile: (entry: FileCacheEntry) => void;
  onClearFile: (entry: FileCacheEntry) => void;
}

export function CacheManagerDialog({
  open,
  summary,
  operation,
  cacheFileIndex,
  onClose,
  onRefresh,
  onClearAutomatic,
  onPauseFile,
  onResumeFile,
  onTerminateFile,
  onClearFile
}: CacheManagerDialogProps) {
  const entries = summary?.entries ?? [];
  const hasAutomaticEntries = entries.some((entry) => entry.cacheSource !== "manual");
  const [actionEntry, setActionEntry] = useState<FileCacheEntry | null>(null);

  useEffect(() => {
    if (!open) {
      setActionEntry(null);
    }
  }, [open]);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="缓存管理"
        description={`已缓存 ${entries.length} 个文件，手动 ${formatBytes(summary?.manualBytes ?? 0)}，自动 ${formatBytes(summary?.autoBytes ?? 0)}`}
        size="full"
        className="h-[min(88dvh,56rem)] max-h-[88dvh] rounded-2xl border shadow-dialog sm:w-[min(96vw,118rem)] sm:max-w-[118rem]"
        bodyClassName="overflow-auto px-4 py-4 sm:px-5"
        footer={
          <>
            <Button variant="secondary" leadingIcon={<RefreshCw size={15} />} onClick={onRefresh}>
              刷新
            </Button>
            <Button variant="secondary" leadingIcon={<Trash2 size={15} />} disabled={!hasAutomaticEntries} onClick={onClearAutomatic}>
              清理自动缓存
            </Button>
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </>
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-background">
          {entries.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-foreground">暂无缓存文件</p>
              <p className="mt-1 text-xs text-muted">预览文件会产生自动缓存，也可以在文件菜单中手动缓存。</p>
            </div>
          ) : (
            <div className="max-h-[min(70dvh,44rem)] overflow-y-auto overflow-x-hidden scroll-thin">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[12%]" />
                  <col className="w-[20%]" />
                  <col className="w-[13%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 border-b border-border bg-surface">
                  <tr className="text-left text-xs font-medium text-muted">
                    <th className="px-4 py-3">文件</th>
                    <th className="px-3 py-3">类型</th>
                    <th className="px-3 py-3">缓存进度</th>
                    <th className="px-3 py-3">空间</th>
                    <th className="px-3 py-3">状态</th>
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
                              entry.manualCacheStatus === "caching"
                                ? "bg-primary-soft text-primary-strong"
                                : entry.manualCacheStatus === "waiting"
                                  ? "bg-surface text-muted ring-1 ring-border"
                                : entry.manualCacheStatus === "paused"
                                  ? "bg-warning-soft text-warning"
                                  : entry.complete
                                    ? "bg-success-soft text-success"
                                    : "bg-surface text-muted ring-1 ring-border"
                            )}>
                              {statusLabel}
                            </span>
                            <span className="text-xs text-subtle">{entry.cacheSource === "manual" ? "手动缓存" : "自动缓存"}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            {entry.manualCacheStatus === "caching" ? (
                              <CircularCacheAction
                                progress={progress}
                                label="停止或终止缓存"
                                disabled={actionDisabled}
                                onClick={() => setActionEntry(entry)}
                              />
                            ) : null}
                            {entry.manualCacheStatus === "waiting" ? (
                              <IconButton
                                size="sm"
                                variant="default"
                                label="停止或终止缓存"
                                disabled={actionDisabled}
                                onClick={() => setActionEntry(entry)}
                              >
                                <Square size={16} />
                              </IconButton>
                            ) : null}
                            {entry.manualCacheStatus === "paused" ? (
                              <IconButton
                                size="sm"
                                variant="default"
                                label={entryOperation === "resume" ? "继续中" : "继续缓存"}
                                disabled={actionDisabled}
                                onClick={() => onResumeFile(entry)}
                              >
                                <Play size={16} />
                              </IconButton>
                            ) : null}
                            {entry.manualCacheStatus ? (
                              <IconButton
                                size="sm"
                                variant="danger"
                                label={entryOperation === "terminate" ? "终止中" : "终止缓存"}
                                disabled={actionDisabled}
                                onClick={() => onTerminateFile(entry)}
                              >
                                <Trash2 size={16} />
                              </IconButton>
                            ) : (
                              <IconButton
                                size="sm"
                                variant="danger"
                                label={entryOperation === "clear" ? "清理中" : `清除缓存（${formatBytes(entry.cachedBytes)}）`}
                                disabled={actionDisabled || entry.cachedBytes <= 0}
                                onClick={() => onClearFile(entry)}
                              >
                                <Trash2 size={16} />
                              </IconButton>
                            )}
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

      <Modal
        open={Boolean(actionEntry)}
        onClose={() => setActionEntry(null)}
        title="处理正在进行的缓存"
        description="停止会保留已缓存分片，终止会停止并清除缓存。"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setActionEntry(null)}>
              取消
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<Square size={15} />}
              onClick={() => {
                if (!actionEntry) return;
                const entry = actionEntry;
                setActionEntry(null);
                onPauseFile(entry);
              }}
            >
              停止缓存
            </Button>
            <Button
              variant="danger"
              leadingIcon={<Trash2 size={15} />}
              onClick={() => {
                if (!actionEntry) return;
                const entry = actionEntry;
                setActionEntry(null);
                onTerminateFile(entry);
              }}
            >
              终止缓存
            </Button>
          </>
        }
      >
        {actionEntry ? (
          <div className="min-w-0 rounded-xl border border-border bg-background px-3 py-3">
            <p className="truncate text-sm font-semibold text-foreground">{actionEntry.fileName}</p>
            <p className="mt-1 truncate text-xs text-muted">{actionEntry.directoryPath || "/"}</p>
            <p className="mt-3 text-xs text-muted">
              当前进度 {fileCacheProgressPercent(actionEntry)}% · 已缓存 {formatBytes(actionEntry.cachedBytes)}
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function fileCacheProgressPercent(entry: FileCacheEntry): number {
  if (entry.complete) return 100;
  if (entry.size > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedBytes / entry.size) * 100)));
  }
  if (entry.chunkCount > 0) {
    return Math.max(0, Math.min(100, Math.round((entry.cachedChunks / entry.chunkCount) * 100)));
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
    sourceUrl: hasFileLinkAccess(indexedFile) ? indexedFile.file_path : entry.sourceUrl
  };
}

function cacheEntryStatusLabel(entry: FileCacheEntry): string {
  if (entry.manualCacheStatus === "caching") return "缓存中";
  if (entry.manualCacheStatus === "waiting") return "等待中";
  if (entry.manualCacheStatus === "paused") return "已停止";
  if (entry.complete) return "已完成";
  return "部分缓存";
}

function cacheEntryVisualUrl(entry: FileCacheEntry, indexedFile: FileItem | undefined): string | undefined {
  if (indexedFile && hasFileLinkAccess(indexedFile)) {
    return indexedFile.url;
  }

  return entry.sourceUrl;
}

function CircularCacheAction({
  progress,
  disabled,
  label,
  onClick
}: {
  progress: number;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  const normalized = Math.max(0, Math.min(100, progress));

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="relative grid size-9 place-items-center rounded-full text-primary-strong transition-[opacity,transform] duration-150 hover:scale-105 focus-visible:outline-none focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 size-9 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--color-border)" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r="15.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray={`${normalized} 100`}
        />
      </svg>
      <span className="grid size-6 place-items-center rounded-full bg-surface shadow-card">
        <Square size={12} className="fill-current" />
      </span>
    </button>
  );
}
