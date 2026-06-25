import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  FileItem,
  SessionResponse,
  lookupFiles
} from "../../api";
import {
  clearAutomaticFileCache,
  clearFileCache,
  getFileCacheSummary,
  type FileCacheSummary
} from "../../lib/file-cache";
import { type CacheOperation } from "../../components/files/cache/CacheManagerDialog";
import { useToast } from "../../lib/toast";

const CACHE_LOOKUP_LIMIT = 60;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

interface UseFileCacheManagerOptions {
  files: FileItem[];
  session: SessionResponse;
  toast: ReturnType<typeof useToast>;
}

export function useFileCacheManager({ files, toast }: UseFileCacheManagerOptions) {
  const [cacheSummary, setCacheSummary] = useState<FileCacheSummary | null>(null);
  const [cacheFiles, setCacheFiles] = useState<FileItem[]>([]);
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false);
  const [cacheOperation, setCacheOperation] = useState<CacheOperation>(null);
  const [cacheSummaryLoading, setCacheSummaryLoading] = useState(false);
  const [cacheSummaryError, setCacheSummaryError] = useState<string | null>(null);

  const refreshCacheFilesBySummary = useCallback(async (summary: FileCacheSummary | null) => {
    const entries = summary?.entries ?? [];
    if (entries.length === 0) return;

    const existingIds = new Set([...cacheFiles, ...files].map((file) => file.id));
    const missingIds = Array.from(new Set(entries.map((entry) => entry.fileId)))
      .filter((fileId) => fileId && !existingIds.has(fileId))
      .slice(0, CACHE_LOOKUP_LIMIT);
    if (missingIds.length === 0) return;

    try {
      const response = await lookupFiles(missingIds);
      if (response.files.length === 0) return;
      setCacheFiles((current) => {
        const byId = new Map(current.map((file) => [file.id, file]));
        for (const file of response.files) {
          byId.set(file.id, file);
        }
        return Array.from(byId.values());
      });
    } catch {
      // The cache manager can still show service-worker metadata if lookup fails.
    }
  }, [cacheFiles, files]);

  const refreshCacheSummary = useCallback(async () => {
    setCacheSummaryLoading(true);
    try {
      const summary = await getFileCacheSummary();
      setCacheSummary(summary);
      setCacheSummaryError(null);
      void refreshCacheFilesBySummary(summary);
    } catch (error) {
      setCacheSummaryError(errorMessage(error));
    } finally {
      setCacheSummaryLoading(false);
    }
  }, [refreshCacheFilesBySummary]);

  const refreshCacheManager = useCallback(async () => {
    await refreshCacheSummary();
  }, [refreshCacheSummary]);

  useEffect(() => {
    void refreshCacheSummary();
  }, [refreshCacheSummary]);

  useEffect(() => {
    if (cacheManagerOpen) {
      void refreshCacheSummary();
    }
  }, [cacheManagerOpen, refreshCacheSummary]);

  useEffect(() => {
    if (cacheManagerOpen) {
      void refreshCacheFilesBySummary(cacheSummary);
    }
  }, [cacheManagerOpen, cacheSummary, refreshCacheFilesBySummary]);

  useEffect(() => {
    if (!cacheManagerOpen) return undefined;

    const intervalId = window.setInterval(() => {
      void refreshCacheSummary();
    }, 10_000);

    return () => window.clearInterval(intervalId);
  }, [cacheManagerOpen, refreshCacheSummary]);

  async function onClearFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "clear" });
    try {
      setCacheSummary(await clearFileCache(file.id));
      setCacheSummaryError(null);
      toast.success("缓存已清除");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onClearAutomaticCache() {
    try {
      setCacheSummary(await clearAutomaticFileCache());
      setCacheSummaryError(null);
      toast.success("缓存已清理");
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }

  const cacheFileIndex = useMemo(
    () => new Map([...cacheFiles, ...files].map((file) => [file.id, file])),
    [cacheFiles, files]
  );

  return {
    cacheSummary,
    setCacheSummary,
    cacheSummaryLoading,
    cacheSummaryError,
    setCacheSummaryError,
    cacheFiles,
    cacheManagerOpen,
    setCacheManagerOpen,
    cacheOperation,
    setCacheOperation,
    cacheFileIndex,
    refreshCacheSummary,
    refreshCacheManager,
    onClearFileCache,
    onClearAutomaticCache
  };
}
