import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  FileItem,
  SessionResponse,
  listDirectories,
  listFiles,
  lookupFiles
} from "../../api";
import {
  buildFileCacheMetadata,
  cacheFileManually,
  canCacheFile,
  clearAutomaticFileCache,
  clearFileCache,
  getFileCacheSummary,
  pauseFileCache,
  requestPersistentFileCacheStorage,
  resumeFileCache,
  terminateFileCache,
  type FileCacheSummary
} from "../../lib/file-cache";
import { type CacheOperation } from "../../components/files/cache/CacheManagerDialog";
import { useToast } from "../../lib/toast";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

interface UseFileCacheManagerOptions {
  files: FileItem[];
  session: SessionResponse;
  toast: ReturnType<typeof useToast>;
}

export function useFileCacheManager({ files, session, toast }: UseFileCacheManagerOptions) {
  const [cacheSummary, setCacheSummary] = useState<FileCacheSummary | null>(null);
  const [cacheFiles, setCacheFiles] = useState<FileItem[]>([]);
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false);
  const [cacheOperation, setCacheOperation] = useState<CacheOperation>(null);

  const refreshCacheSummary = useCallback(async () => {
    try {
      setCacheSummary(await getFileCacheSummary());
    } catch {
      setCacheSummary(null);
    }
  }, []);

  const refreshCacheFilesBySummary = useCallback(async (summary: FileCacheSummary | null) => {
    const entries = summary?.entries ?? [];
    if (entries.length === 0) return;

    const existingIds = new Set([...cacheFiles, ...files].map((file) => file.id));
    const missingIds = Array.from(new Set(entries.map((entry) => entry.fileId)))
      .filter((fileId) => fileId && !existingIds.has(fileId))
      .slice(0, 100);
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

  const refreshCacheFileIndex = useCallback(async () => {
    try {
      const directoryResponse = await listDirectories(true);
      const directoryPaths = Array.from(new Set(["/", ...directoryResponse.directories.map((directory) => directory.path)]));
      const responses = await Promise.all(directoryPaths.map((dir) =>
        listFiles({
          q: "",
          dir,
          all: true,
          type: "all"
        })
      ));
      setCacheFiles(responses.flatMap((response) => response.files));
    } catch {
      setCacheFiles([]);
    }
  }, []);

  useEffect(() => {
    void refreshCacheSummary();
  }, [refreshCacheSummary]);

  useEffect(() => {
    if (cacheManagerOpen) {
      void refreshCacheSummary();
      void refreshCacheFileIndex();
    }
  }, [cacheManagerOpen, refreshCacheFileIndex, refreshCacheSummary]);

  useEffect(() => {
    if (cacheManagerOpen) {
      void refreshCacheFilesBySummary(cacheSummary);
    }
  }, [cacheManagerOpen, cacheSummary, refreshCacheFilesBySummary]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshCacheSummary();
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [refreshCacheSummary]);

  async function onCacheFile(file: FileItem) {
    const metadata = buildFileCacheMetadata(file, session.video_preview_cache_bytes, "manual");
    if (!metadata || !canCacheFile(file)) {
      toast.danger("该文件缺少可缓存的访问链接");
      return;
    }

    setCacheOperation({ fileId: file.id, kind: "cache" });
    try {
      await requestPersistentFileCacheStorage();
      await cacheFileManually(metadata);
      await refreshCacheSummary();
      toast.success("文件已加入缓存队列");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onPauseFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "pause" });
    try {
      setCacheSummary(await pauseFileCache(file.id));
      toast.success("缓存已暂停");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onResumeFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "resume" });
    try {
      await requestPersistentFileCacheStorage();
      const metadata = buildFileCacheMetadata(file, Number.MAX_SAFE_INTEGER, "manual");
      setCacheSummary(await resumeFileCache(file.id, metadata ?? undefined));
      toast.success("缓存已继续");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onTerminateFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "terminate" });
    try {
      setCacheSummary(await terminateFileCache(file.id));
      toast.success("缓存已终止");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function resumeFileCacheById(fileId: string) {
    setCacheOperation({ fileId, kind: "resume" });
    try {
      await requestPersistentFileCacheStorage();
      const indexedFile = cacheFileIndex.get(fileId);
      const metadata = indexedFile ? buildFileCacheMetadata(indexedFile, Number.MAX_SAFE_INTEGER, "manual") : null;
      setCacheSummary(await resumeFileCache(fileId, metadata ?? undefined));
      toast.success("缓存已继续");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCacheOperation(null);
    }
  }

  async function onClearFileCache(file: FileItem) {
    setCacheOperation({ fileId: file.id, kind: "clear" });
    try {
      setCacheSummary(await clearFileCache(file.id));
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
      toast.success("自动缓存已清理");
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
    cacheFiles,
    cacheManagerOpen,
    setCacheManagerOpen,
    cacheOperation,
    setCacheOperation,
    cacheFileIndex,
    refreshCacheSummary,
    onCacheFile,
    onPauseFileCache,
    onResumeFileCache,
    onTerminateFileCache,
    resumeFileCacheById,
    onClearFileCache,
    onClearAutomaticCache
  };
}
