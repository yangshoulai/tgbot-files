import {
  deleteStaleHlsUploadData,
  deleteStaleMultipartUploadData,
  requireDb
} from "../database";
import type { AppEnv } from "../runtime";
import { cleanupAria2DownloadCache } from "./aria2-download-cache";

const DEFAULT_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24;
const MIN_STALE_MULTIPART_UPLOAD_TTL_HOURS = 1;
const MAX_STALE_MULTIPART_UPLOAD_TTL_HOURS = 24 * 30;

export async function runScheduledCleanup(env: AppEnv, nowMs = Date.now(), cron = "server"): Promise<void> {
  const result = await cleanupStaleUploads(env, nowMs);

  if (
    result.deletedMultipartUploads > 0 ||
    result.deletedMultipartChunks > 0 ||
    result.deletedHlsAssets > 0 ||
    result.deletedHlsSegments > 0 ||
    result.deletedHlsUploads > 0 ||
    result.deletedHlsChunks > 0 ||
    result.deletedAria2Dirs > 0
  ) {
    console.log("Stale upload cleanup completed", {
      cron,
      expired_before: result.expiredBefore,
      deleted_multipart_uploads: result.deletedMultipartUploads,
      deleted_multipart_chunks: result.deletedMultipartChunks,
      deleted_hls_assets: result.deletedHlsAssets,
      deleted_hls_segments: result.deletedHlsSegments,
      deleted_hls_uploads: result.deletedHlsUploads,
      deleted_hls_chunks: result.deletedHlsChunks,
      deleted_aria2_dirs: result.deletedAria2Dirs,
      deleted_aria2_bytes: result.deletedAria2Bytes,
      aria2_download_bytes: result.aria2DownloadBytes,
      skipped_aria2_dirs: result.skippedAria2Dirs
    });
  }
}

async function cleanupStaleUploads(
  env: AppEnv,
  nowMs: number
): Promise<{
  expiredBefore: string;
  deletedMultipartUploads: number;
  deletedMultipartChunks: number;
  deletedHlsAssets: number;
  deletedHlsSegments: number;
  deletedHlsUploads: number;
  deletedHlsChunks: number;
  deletedAria2Dirs: number;
  deletedAria2Bytes: number;
  aria2DownloadBytes: number;
  skippedAria2Dirs: number;
}> {
  const db = requireDb(env);
  const ttlMs = parseStaleMultipartUploadTtlMs(env.STALE_MULTIPART_UPLOAD_TTL_HOURS);
  const expiredBefore = new Date(nowMs - ttlMs).toISOString();
  const [multipart, hls] = await Promise.all([
    deleteStaleMultipartUploadData(db, expiredBefore),
    deleteStaleHlsUploadData(db, expiredBefore)
  ]);
  const aria2 = await cleanupAria2DownloadCache(env, db, nowMs);

  return {
    expiredBefore,
    deletedMultipartUploads: multipart.deletedUploads,
    deletedMultipartChunks: multipart.deletedChunks,
    deletedHlsAssets: hls.deletedAssets,
    deletedHlsSegments: hls.deletedSegments,
    deletedHlsUploads: hls.deletedUploads,
    deletedHlsChunks: hls.deletedChunks,
    deletedAria2Dirs: aria2.deletedDirs,
    deletedAria2Bytes: aria2.deletedBytes,
    aria2DownloadBytes: aria2.currentBytes,
    skippedAria2Dirs: aria2.skippedDirs
  };
}

function parseStaleMultipartUploadTtlMs(value: string | undefined): number {
  const parsed = Number(value?.trim());
  const hours = Number.isFinite(parsed)
    ? Math.floor(parsed)
    : DEFAULT_STALE_MULTIPART_UPLOAD_TTL_HOURS;
  const boundedHours = Math.min(
    MAX_STALE_MULTIPART_UPLOAD_TTL_HOURS,
    Math.max(MIN_STALE_MULTIPART_UPLOAD_TTL_HOURS, hours)
  );

  return boundedHours * 60 * 60 * 1000;
}
