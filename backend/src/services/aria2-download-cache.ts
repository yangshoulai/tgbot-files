import {
  cancelMagnetImportRecord,
  listMagnetImportRecordsForAria2Cleanup,
  listProtectedMagnetImportRecordsForAria2Cleanup,
  type MagnetImportRecord
} from "../database";
import {
  aria2Forget,
  requireAria2Config,
  resolveAria2DownloadConfig
} from "../services/aria2";
import { AppError } from "../utils/http";
import type { AppDatabase, AppEnv } from "../runtime";
import { lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";

export const ARIA2_CACHE_DIRECTORY_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function cleanupAria2DownloadCache(
  env: AppEnv,
  db: AppDatabase,
  nowMs: number
): Promise<{ deletedDirs: number; deletedBytes: number; currentBytes: number; skippedDirs: number }> {
  if (!env.ARIA2_DOWNLOAD_DIR?.trim() && !env.ARIA2_RPC_URL?.trim() && !env.ARIA2_RPC_SECRET?.trim()) {
    return { deletedDirs: 0, deletedBytes: 0, currentBytes: 0, skippedDirs: 0 };
  }

  const config = resolveAria2DownloadConfig(env);
  await mkdir(config.downloadDir, { recursive: true });

  const expiredBefore = new Date(nowMs - config.downloadRetentionMs).toISOString();
  const protectedRecords = await listProtectedMagnetImportRecordsForAria2Cleanup(db, expiredBefore);
  const protectedDirs = new Set(
    protectedRecords
      .map((record) => safeAria2DownloadDir(config.downloadDir, record.download_dir))
      .filter((dir): dir is string => Boolean(dir))
  );
  const staleRecords = await listMagnetImportRecordsForAria2Cleanup(db, expiredBefore);
  let deletedDirs = 0;
  let deletedBytes = 0;
  let skippedDirs = 0;
  const deletedPaths = new Set<string>();

  for (const record of staleRecords) {
    const resolvedDir = safeAria2DownloadDir(config.downloadDir, record.download_dir);
    if (!resolvedDir || protectedDirs.has(resolvedDir) || deletedPaths.has(resolvedDir)) {
      skippedDirs += 1;
      continue;
    }

    await forceRemoveAria2MagnetTaskIfConfigured(env, record);
    const result = await deleteAria2DownloadDir(config.downloadDir, resolvedDir);
    if (result.deleted) {
      deletedDirs += 1;
      deletedBytes += result.bytes;
      deletedPaths.add(resolvedDir);
      if (record.status === "downloaded") {
        await cancelMagnetImportRecord(db, record.id, new Date(nowMs).toISOString());
      }
    } else {
      skippedDirs += 1;
    }
  }

  let currentBytes = await directorySizeBytes(config.downloadDir);
  if (config.downloadMaxBytes > 0 && currentBytes > config.downloadMaxBytes) {
    const candidates = await listAria2DownloadCacheCandidates(
      config.downloadDir,
      protectedDirs,
      deletedPaths,
      nowMs - config.downloadRetentionMs
    );
    for (const candidate of candidates) {
      if (currentBytes <= config.downloadMaxBytes) {
        break;
      }

      const result = await deleteAria2DownloadDir(config.downloadDir, candidate.path);
      if (result.deleted) {
        deletedDirs += 1;
        deletedBytes += result.bytes;
        currentBytes = Math.max(0, currentBytes - result.bytes);
        deletedPaths.add(candidate.path);
      } else {
        skippedDirs += 1;
      }
    }
  }

  return {
    deletedDirs,
    deletedBytes,
    currentBytes,
    skippedDirs
  };
}

export async function forgetAria2MagnetTask(config: ReturnType<typeof requireAria2Config>, record: MagnetImportRecord): Promise<void> {
  for (const gid of [record.aria2_metadata_gid, record.aria2_download_gid]) {
    if (!gid) continue;
    await aria2Forget(config, gid).catch((error) => {
      console.warn("Failed to forget aria2 magnet task", {
        import_id: record.id,
        gid,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

export async function forceRemoveAria2MagnetTaskIfConfigured(env: AppEnv, record: MagnetImportRecord): Promise<void> {
  if (!env.ARIA2_RPC_URL?.trim() || !env.ARIA2_RPC_SECRET?.trim()) {
    return;
  }

  const config = requireAria2Config(env);
  await forgetAria2MagnetTask(config, record);
}

export function safeAria2DownloadDir(baseDir: string, targetDir: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedDir = path.resolve(path.isAbsolute(targetDir) ? targetDir : path.join(baseDir, targetDir));

  if (resolvedDir !== resolvedBase && resolvedDir.startsWith(`${resolvedBase}${path.sep}`)) {
    return resolvedDir;
  }

  return null;
}

export async function deleteAria2DownloadDir(
  baseDir: string,
  targetDir: string
): Promise<{ deleted: boolean; bytes: number }> {
  const resolvedDir = safeAria2DownloadDir(baseDir, targetDir);
  if (!resolvedDir) {
    return { deleted: false, bytes: 0 };
  }

  const targetStat = await lstat(resolvedDir).catch(() => null);
  if (!targetStat?.isDirectory()) {
    return { deleted: false, bytes: 0 };
  }

  const bytes = await directorySizeBytes(resolvedDir);
  await rm(resolvedDir, { recursive: true, force: true });
  return { deleted: true, bytes };
}

export async function directorySizeBytes(rootDir: string): Promise<number> {
  const rootStat = await lstat(rootDir).catch(() => null);
  if (!rootStat) {
    return 0;
  }
  if (!rootStat.isDirectory()) {
    return rootStat.isFile() ? rootStat.size : 0;
  }

  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      total += (await lstat(entryPath).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

export async function availableDiskBytes(targetDir: string): Promise<number> {
  await mkdir(targetDir, { recursive: true });
  const stats = await statfs(targetDir);
  return stats.bavail * stats.bsize;
}

export async function listAria2DownloadCacheCandidates(
  downloadDir: string,
  protectedDirs: Set<string>,
  ignoredDirs: Set<string>,
  olderThanMs: number
): Promise<Array<{ path: string; mtimeMs: number; bytes: number }>> {
  const entries = await readdir(downloadDir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ path: string; mtimeMs: number; bytes: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !ARIA2_CACHE_DIRECTORY_NAME_PATTERN.test(entry.name)) {
      continue;
    }

    const entryPath = path.resolve(downloadDir, entry.name);
    if (protectedDirs.has(entryPath) || ignoredDirs.has(entryPath)) {
      continue;
    }

    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat?.isDirectory()) {
      continue;
    }
    if (entryStat.mtimeMs > olderThanMs) {
      continue;
    }

    candidates.push({
      path: entryPath,
      mtimeMs: entryStat.mtimeMs,
      bytes: await directorySizeBytes(entryPath)
    });
  }

  return candidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) {
      return left.mtimeMs - right.mtimeMs;
    }
    return right.bytes - left.bytes;
  });
}

export async function ensureAria2DownloadCapacity(params: {
  env: AppEnv;
  db: AppDatabase;
  additionalBytes: number;
}): Promise<void> {
  const config = resolveAria2DownloadConfig(params.env);
  const additionalBytes = Math.max(0, params.additionalBytes);
  const cleanup = await cleanupAria2DownloadCache(params.env, params.db, Date.now());
  const projectedBytes = cleanup.currentBytes + additionalBytes;

  if (config.downloadMaxBytes > 0 && projectedBytes > config.downloadMaxBytes) {
    throw new AppError(507, "Aria2DownloadStorageLimitExceeded", "aria2 下载目录容量不足，无法开始新的磁力下载", {
      download_dir: config.downloadDir,
      current_bytes: cleanup.currentBytes,
      required_bytes: additionalBytes,
      projected_bytes: projectedBytes,
      max_bytes: config.downloadMaxBytes,
      deleted_bytes: cleanup.deletedBytes
    });
  }

  if (config.downloadMinFreeBytes > 0) {
    const freeBytes = await availableDiskBytes(config.downloadDir);
    if (freeBytes - additionalBytes < config.downloadMinFreeBytes) {
      throw new AppError(507, "Aria2DownloadDiskFreeSpaceTooLow", "磁盘剩余空间不足，无法开始新的磁力下载", {
        download_dir: config.downloadDir,
        free_bytes: freeBytes,
        required_bytes: additionalBytes,
        min_free_bytes: config.downloadMinFreeBytes
      });
    }
  }
}
