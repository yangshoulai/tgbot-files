import {
  DEFAULT_TELEGRAM_AUDIO_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_IMAGE_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_TEXT_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_VIDEO_CHUNK_SIZE_BYTES,
  DEFAULT_UPLOAD_CONCURRENCY,
  DEFAULT_VIDEO_PREVIEW_CACHE_BYTES,
  getTelegramAudioChunkSizeBytesSetting,
  getTelegramChunkSizeBytesSetting,
  getTelegramImageChunkSizeBytesSetting,
  getTelegramTextChunkSizeBytesSetting,
  getTelegramVideoChunkSizeBytesSetting,
  getUploadConcurrencySetting,
  getVideoPreviewCacheBytesSetting,
  MAX_TELEGRAM_CHUNK_SIZE_BYTES,
  MAX_UPLOAD_CONCURRENCY,
  MAX_VIDEO_PREVIEW_CACHE_BYTES,
  MIN_TELEGRAM_CHUNK_SIZE_BYTES,
  MIN_UPLOAD_CONCURRENCY,
  MIN_VIDEO_PREVIEW_CACHE_BYTES,
  setTelegramAudioChunkSizeBytesSetting,
  setTelegramChunkSizeBytesSetting,
  setTelegramImageChunkSizeBytesSetting,
  setTelegramTextChunkSizeBytesSetting,
  setTelegramVideoChunkSizeBytesSetting,
  setUploadConcurrencySetting,
  setVideoPreviewCacheBytesSetting
} from "../database";
import {
  DIRECT_MULTIPART_ACCESS_MAX_BYTES,
  MAX_TELEGRAM_MULTIPART_BYTES,
  maxTelegramMultipartChunks
} from "../config/upload-limits";
import { parseMaxFileBytes } from "../utils/http";
import type { AppDatabase, AppEnv } from "../runtime";
import { positiveIntegerField } from "../validators/request";

export async function buildAdminSessionPayload(params: {
  env: AppEnv;
  username: string;
  baseUrl: string;
}): Promise<Record<string, unknown>> {
  const settings = await readAdminSettings(params.env.DATABASE);
  const maxFileBytes = parseMaxFileBytes(params.env.MAX_FILE_BYTES);

  return {
    ok: true,
    username: params.username,
    max_file_bytes: maxFileBytes,
    multipart_chunk_bytes: settings.telegramChunkSizeBytes,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access_max_chunks: maxTelegramMultipartChunks(settings.telegramChunkSizeBytes),
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    upload_concurrency: settings.uploadConcurrency,
    upload_concurrency_min: MIN_UPLOAD_CONCURRENCY,
    upload_concurrency_max: MAX_UPLOAD_CONCURRENCY,
    video_preview_cache_bytes: settings.videoPreviewCacheBytes,
    video_preview_cache_bytes_min: MIN_VIDEO_PREVIEW_CACHE_BYTES,
    video_preview_cache_bytes_max: MAX_VIDEO_PREVIEW_CACHE_BYTES,
    telegram_chunk_size_bytes: settings.telegramChunkSizeBytes,
    telegram_video_chunk_size_bytes: settings.telegramVideoChunkSizeBytes,
    telegram_audio_chunk_size_bytes: settings.telegramAudioChunkSizeBytes,
    telegram_text_chunk_size_bytes: settings.telegramTextChunkSizeBytes,
    telegram_image_chunk_size_bytes: settings.telegramImageChunkSizeBytes,
    telegram_chunk_size_bytes_min: MIN_TELEGRAM_CHUNK_SIZE_BYTES,
    telegram_chunk_size_bytes_max: MAX_TELEGRAM_CHUNK_SIZE_BYTES,
    base_url: params.baseUrl,
    config: {
      database: Boolean(params.env.DATABASE),
      telegram_bot_token: hasEnvValue(params.env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: hasEnvValue(params.env.TELEGRAM_STORAGE_CHAT_ID),
      telegram_channels: Boolean(params.env.DATABASE),
      tg_channel_secret: hasEnvValue(params.env.TG_CHANNEL_SECRET || params.env.LINK_SIGNING_SECRET),
      link_signing_secret: hasEnvValue(params.env.LINK_SIGNING_SECRET),
      admin_username: hasEnvValue(params.env.ADMIN_USERNAME),
      admin_password: hasEnvValue(params.env.ADMIN_PASSWORD),
      admin_session_secret: hasEnvValue(params.env.ADMIN_SESSION_SECRET)
    },
    config_values: {
      database: params.env.DATABASE ? "已连接" : "未连接",
      telegram_bot_token: maskSecret(params.env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: params.env.TELEGRAM_STORAGE_CHAT_ID?.trim() || "未配置",
      telegram_channels: params.env.DATABASE ? "设置页可配置" : "需要 SQLite 数据库",
      tg_channel_secret: params.env.TG_CHANNEL_SECRET?.trim()
        ? maskSecret(params.env.TG_CHANNEL_SECRET)
        : "未单独配置，使用签名密钥",
      link_signing_secret: maskSecret(params.env.LINK_SIGNING_SECRET),
      admin_username: params.env.ADMIN_USERNAME?.trim() || "未配置",
      admin_password: maskSecret(params.env.ADMIN_PASSWORD),
      admin_session_secret: params.env.ADMIN_SESSION_SECRET?.trim()
        ? maskSecret(params.env.ADMIN_SESSION_SECRET)
        : "未单独配置，使用签名密钥",
      public_base_url: params.baseUrl,
      max_file_bytes: String(maxFileBytes),
      max_multipart_file_bytes: String(MAX_TELEGRAM_MULTIPART_BYTES),
      direct_access_max_bytes: String(DIRECT_MULTIPART_ACCESS_MAX_BYTES),
      video_preview_cache_bytes: String(settings.videoPreviewCacheBytes)
    }
  };
}

export async function updateAdminSettingsPayload(
  db: AppDatabase,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const current = await readAdminSettings(db);
  const uploadConcurrency = body.upload_concurrency === undefined
    ? current.uploadConcurrency
    : positiveIntegerField(body.upload_concurrency, "upload_concurrency");
  const videoPreviewCacheBytes = body.video_preview_cache_bytes === undefined
    ? current.videoPreviewCacheBytes
    : positiveIntegerField(body.video_preview_cache_bytes, "video_preview_cache_bytes");
  const telegramChunkSizeBytes = body.telegram_chunk_size_bytes === undefined
    ? current.telegramChunkSizeBytes
    : positiveIntegerField(body.telegram_chunk_size_bytes, "telegram_chunk_size_bytes");
  const telegramVideoChunkSizeBytes = body.telegram_video_chunk_size_bytes === undefined
    ? current.telegramVideoChunkSizeBytes
    : positiveIntegerField(body.telegram_video_chunk_size_bytes, "telegram_video_chunk_size_bytes");
  const telegramAudioChunkSizeBytes = body.telegram_audio_chunk_size_bytes === undefined
    ? current.telegramAudioChunkSizeBytes
    : positiveIntegerField(body.telegram_audio_chunk_size_bytes, "telegram_audio_chunk_size_bytes");
  const telegramTextChunkSizeBytes = body.telegram_text_chunk_size_bytes === undefined
    ? current.telegramTextChunkSizeBytes
    : positiveIntegerField(body.telegram_text_chunk_size_bytes, "telegram_text_chunk_size_bytes");
  const telegramImageChunkSizeBytes = body.telegram_image_chunk_size_bytes === undefined
    ? current.telegramImageChunkSizeBytes
    : positiveIntegerField(body.telegram_image_chunk_size_bytes, "telegram_image_chunk_size_bytes");
  const updatedAt = new Date().toISOString();

  const savedUploadConcurrency = await setUploadConcurrencySetting(db, uploadConcurrency, updatedAt);
  const savedVideoPreviewCacheBytes = await setVideoPreviewCacheBytesSetting(db, videoPreviewCacheBytes, updatedAt);
  const savedTelegramChunkSizeBytes = await setTelegramChunkSizeBytesSetting(db, telegramChunkSizeBytes, updatedAt);
  const savedTelegramVideoChunkSizeBytes = await setTelegramVideoChunkSizeBytesSetting(db, telegramVideoChunkSizeBytes, updatedAt);
  const savedTelegramAudioChunkSizeBytes = await setTelegramAudioChunkSizeBytesSetting(db, telegramAudioChunkSizeBytes, updatedAt);
  const savedTelegramTextChunkSizeBytes = await setTelegramTextChunkSizeBytesSetting(db, telegramTextChunkSizeBytes, updatedAt);
  const savedTelegramImageChunkSizeBytes = await setTelegramImageChunkSizeBytesSetting(db, telegramImageChunkSizeBytes, updatedAt);

  return {
    ok: true,
    settings: {
      upload_concurrency: savedUploadConcurrency,
      upload_concurrency_min: MIN_UPLOAD_CONCURRENCY,
      upload_concurrency_max: MAX_UPLOAD_CONCURRENCY,
      video_preview_cache_bytes: savedVideoPreviewCacheBytes,
      video_preview_cache_bytes_min: MIN_VIDEO_PREVIEW_CACHE_BYTES,
      video_preview_cache_bytes_max: MAX_VIDEO_PREVIEW_CACHE_BYTES,
      telegram_chunk_size_bytes: savedTelegramChunkSizeBytes,
      telegram_video_chunk_size_bytes: savedTelegramVideoChunkSizeBytes,
      telegram_audio_chunk_size_bytes: savedTelegramAudioChunkSizeBytes,
      telegram_text_chunk_size_bytes: savedTelegramTextChunkSizeBytes,
      telegram_image_chunk_size_bytes: savedTelegramImageChunkSizeBytes,
      telegram_chunk_size_bytes_min: MIN_TELEGRAM_CHUNK_SIZE_BYTES,
      telegram_chunk_size_bytes_max: MAX_TELEGRAM_CHUNK_SIZE_BYTES
    }
  };
}

async function readAdminSettings(db: AppDatabase | undefined): Promise<{
  uploadConcurrency: number;
  videoPreviewCacheBytes: number;
  telegramChunkSizeBytes: number;
  telegramVideoChunkSizeBytes: number;
  telegramAudioChunkSizeBytes: number;
  telegramTextChunkSizeBytes: number;
  telegramImageChunkSizeBytes: number;
}> {
  return {
    uploadConcurrency: db ? await getUploadConcurrencySetting(db) : DEFAULT_UPLOAD_CONCURRENCY,
    videoPreviewCacheBytes: db ? await getVideoPreviewCacheBytesSetting(db) : DEFAULT_VIDEO_PREVIEW_CACHE_BYTES,
    telegramChunkSizeBytes: db ? await getTelegramChunkSizeBytesSetting(db) : DEFAULT_TELEGRAM_CHUNK_SIZE_BYTES,
    telegramVideoChunkSizeBytes: db ? await getTelegramVideoChunkSizeBytesSetting(db) : DEFAULT_TELEGRAM_VIDEO_CHUNK_SIZE_BYTES,
    telegramAudioChunkSizeBytes: db ? await getTelegramAudioChunkSizeBytesSetting(db) : DEFAULT_TELEGRAM_AUDIO_CHUNK_SIZE_BYTES,
    telegramTextChunkSizeBytes: db ? await getTelegramTextChunkSizeBytesSetting(db) : DEFAULT_TELEGRAM_TEXT_CHUNK_SIZE_BYTES,
    telegramImageChunkSizeBytes: db ? await getTelegramImageChunkSizeBytesSetting(db) : DEFAULT_TELEGRAM_IMAGE_CHUNK_SIZE_BYTES
  };
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function maskSecret(value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    return "未配置";
  }

  if (normalized.length <= 8) {
    return "••••";
  }

  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}
