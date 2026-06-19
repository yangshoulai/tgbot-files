import type { AppDatabase } from "../runtime";

export const UPLOAD_CONCURRENCY_SETTING_KEY = "upload_concurrency";
export const DEFAULT_UPLOAD_CONCURRENCY = 5;
export const MIN_UPLOAD_CONCURRENCY = 1;
export const MAX_UPLOAD_CONCURRENCY = 32;
export const VIDEO_PREVIEW_CACHE_BYTES_SETTING_KEY = "video_preview_cache_bytes";
export const DEFAULT_VIDEO_PREVIEW_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
export const MIN_VIDEO_PREVIEW_CACHE_BYTES = 256 * 1024 * 1024;
export const MAX_VIDEO_PREVIEW_CACHE_BYTES = 20 * 1024 * 1024 * 1024;
export const TELEGRAM_CHUNK_SIZE_BYTES_SETTING_KEY = "telegram_chunk_size_bytes";
export const TELEGRAM_VIDEO_CHUNK_SIZE_BYTES_SETTING_KEY = "telegram_video_chunk_size_bytes";
export const TELEGRAM_AUDIO_CHUNK_SIZE_BYTES_SETTING_KEY = "telegram_audio_chunk_size_bytes";
export const TELEGRAM_TEXT_CHUNK_SIZE_BYTES_SETTING_KEY = "telegram_text_chunk_size_bytes";
export const TELEGRAM_IMAGE_CHUNK_SIZE_BYTES_SETTING_KEY = "telegram_image_chunk_size_bytes";
export const DEFAULT_TELEGRAM_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TELEGRAM_VIDEO_CHUNK_SIZE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TELEGRAM_AUDIO_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TELEGRAM_TEXT_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TELEGRAM_IMAGE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
export const MIN_TELEGRAM_CHUNK_SIZE_BYTES = 1 * 1024 * 1024;
export const MAX_TELEGRAM_CHUNK_SIZE_BYTES = 18 * 1024 * 1024;

export async function getUploadConcurrencySetting(db: AppDatabase): Promise<number> {
  let row: { value: string } | null = null;
  try {
    row = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(UPLOAD_CONCURRENCY_SETTING_KEY)
      .first<{ value: string }>();
  } catch {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  const parsed = row ? Number(row.value) : DEFAULT_UPLOAD_CONCURRENCY;

  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }

  return clampUploadConcurrency(parsed);
}

export async function setUploadConcurrencySetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  const normalized = clampUploadConcurrency(value);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(UPLOAD_CONCURRENCY_SETTING_KEY, String(normalized), updatedAt)
    .run();

  return normalized;
}

export async function getVideoPreviewCacheBytesSetting(db: AppDatabase): Promise<number> {
  let row: { value: string } | null = null;
  try {
    row = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(VIDEO_PREVIEW_CACHE_BYTES_SETTING_KEY)
      .first<{ value: string }>();
  } catch {
    return DEFAULT_VIDEO_PREVIEW_CACHE_BYTES;
  }
  const parsed = row ? Number(row.value) : DEFAULT_VIDEO_PREVIEW_CACHE_BYTES;

  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_VIDEO_PREVIEW_CACHE_BYTES;
  }

  return clampVideoPreviewCacheBytes(parsed);
}

export async function setVideoPreviewCacheBytesSetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  const normalized = clampVideoPreviewCacheBytes(value);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(VIDEO_PREVIEW_CACHE_BYTES_SETTING_KEY, String(normalized), updatedAt)
    .run();

  return normalized;
}

function clampUploadConcurrency(value: number): number {
  return Math.min(MAX_UPLOAD_CONCURRENCY, Math.max(MIN_UPLOAD_CONCURRENCY, value));
}

function clampVideoPreviewCacheBytes(value: number): number {
  return Math.min(MAX_VIDEO_PREVIEW_CACHE_BYTES, Math.max(MIN_VIDEO_PREVIEW_CACHE_BYTES, value));
}

export async function getTelegramChunkSizeBytesSetting(db: AppDatabase): Promise<number> {
  return getTelegramChunkSizeSettingValue(db, TELEGRAM_CHUNK_SIZE_BYTES_SETTING_KEY, DEFAULT_TELEGRAM_CHUNK_SIZE_BYTES);
}

export async function setTelegramChunkSizeBytesSetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  return setTelegramChunkSizeSettingValue(db, TELEGRAM_CHUNK_SIZE_BYTES_SETTING_KEY, value, updatedAt);
}

export async function getTelegramVideoChunkSizeBytesSetting(db: AppDatabase): Promise<number> {
  return getTelegramChunkSizeSettingValue(db, TELEGRAM_VIDEO_CHUNK_SIZE_BYTES_SETTING_KEY, DEFAULT_TELEGRAM_VIDEO_CHUNK_SIZE_BYTES);
}

export async function setTelegramVideoChunkSizeBytesSetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  return setTelegramChunkSizeSettingValue(db, TELEGRAM_VIDEO_CHUNK_SIZE_BYTES_SETTING_KEY, value, updatedAt);
}

export async function getTelegramAudioChunkSizeBytesSetting(db: AppDatabase): Promise<number> {
  return getTelegramChunkSizeSettingValue(db, TELEGRAM_AUDIO_CHUNK_SIZE_BYTES_SETTING_KEY, DEFAULT_TELEGRAM_AUDIO_CHUNK_SIZE_BYTES);
}

export async function setTelegramAudioChunkSizeBytesSetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  return setTelegramChunkSizeSettingValue(db, TELEGRAM_AUDIO_CHUNK_SIZE_BYTES_SETTING_KEY, value, updatedAt);
}

export async function getTelegramTextChunkSizeBytesSetting(db: AppDatabase): Promise<number> {
  return getTelegramChunkSizeSettingValue(db, TELEGRAM_TEXT_CHUNK_SIZE_BYTES_SETTING_KEY, DEFAULT_TELEGRAM_TEXT_CHUNK_SIZE_BYTES);
}

export async function setTelegramTextChunkSizeBytesSetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  return setTelegramChunkSizeSettingValue(db, TELEGRAM_TEXT_CHUNK_SIZE_BYTES_SETTING_KEY, value, updatedAt);
}

export async function getTelegramImageChunkSizeBytesSetting(db: AppDatabase): Promise<number> {
  return getTelegramChunkSizeSettingValue(db, TELEGRAM_IMAGE_CHUNK_SIZE_BYTES_SETTING_KEY, DEFAULT_TELEGRAM_IMAGE_CHUNK_SIZE_BYTES);
}

export async function setTelegramImageChunkSizeBytesSetting(db: AppDatabase, value: number, updatedAt: string): Promise<number> {
  return setTelegramChunkSizeSettingValue(db, TELEGRAM_IMAGE_CHUNK_SIZE_BYTES_SETTING_KEY, value, updatedAt);
}

async function getTelegramChunkSizeSettingValue(db: AppDatabase, key: string, fallback: number): Promise<number> {
  let row: { value: string } | null = null;
  try {
    row = await db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
  } catch {
    return fallback;
  }
  const parsed = row ? Number(row.value) : fallback;

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return clampTelegramChunkSizeBytes(parsed);
}

async function setTelegramChunkSizeSettingValue(db: AppDatabase, key: string, value: number, updatedAt: string): Promise<number> {
  const normalized = clampTelegramChunkSizeBytes(value);
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, String(normalized), updatedAt)
    .run();

  return normalized;
}

function clampTelegramChunkSizeBytes(value: number): number {
  return Math.min(MAX_TELEGRAM_CHUNK_SIZE_BYTES, Math.max(MIN_TELEGRAM_CHUNK_SIZE_BYTES, value));
}
