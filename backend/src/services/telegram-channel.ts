import {
  getTelegramChannelRecord,
  listActiveTelegramChannelRecords,
  type TelegramChannelRecord,
  type TelegramChannelStatus
} from "../database";
import { AppError } from "../utils/http";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "../services/telegram";
import type { AppDatabase, AppEnv } from "../runtime";
import { maskSecret } from "../utils/common-util";
import {
  decryptTelegramBotToken,
  normalizeTelegramChannelId,
  telegramRetryAfterSeconds
} from "../utils/telegram-util";

type TelegramRateLimitScope = "sendDocument" | "getFile";

interface TelegramApiSlot {
  scope: TelegramRateLimitScope;
  token?: string;
  channelId?: string;
}

export interface TelegramStorageChannel {
  id: string;
  name: string;
  botToken: string;
  chatId: string;
  status: TelegramChannelStatus;
  isDefault: boolean;
}

interface TelegramUploadSlot extends TelegramApiSlot {
  scope: "sendDocument";
  token: string;
  channelId: string;
  botToken: string;
  chatId: string;
}

async function uploadRateLimitedTelegramDocument(params: {
  env: AppEnv;
  botToken: string;
  chatId: string;
  file: Blob;
  fileName: string;
  telegramSlot: TelegramApiSlot;
}): Promise<Awaited<ReturnType<typeof uploadDocumentToTelegram>>> {
  try {
    return await uploadDocumentToTelegram({
      botToken: params.botToken,
      chatId: params.chatId,
      file: params.file,
      fileName: params.fileName
    });
  } catch (error) {
    await penalizeTelegramApiSlotFromError(params.env, "sendDocument", params.telegramSlot.channelId, error);
    throw error;
  } finally {
    await releaseTelegramApiSlot(params.env, params.telegramSlot);
  }
}

export async function uploadTelegramDocumentWithChannel(params: {
  env: AppEnv;
  db?: AppDatabase;
  file: Blob;
  fileName: string;
  preferredChannelId?: string;
  preferredChannelIndex?: number;
  telegramSlot?: TelegramUploadSlot;
}): Promise<{ telegramDocument: Awaited<ReturnType<typeof uploadDocumentToTelegram>>; channel: TelegramStorageChannel }> {
  const slot = params.telegramSlot ?? await acquireTelegramUploadSlot(params.env, params.db, {
    ...(params.preferredChannelId ? { preferredChannelId: params.preferredChannelId } : {}),
    ...(params.preferredChannelIndex !== undefined ? { preferredChannelIndex: params.preferredChannelIndex } : {})
  });
  const telegramDocument = await uploadRateLimitedTelegramDocument({
    env: params.env,
    botToken: slot.botToken,
    chatId: slot.chatId,
    file: params.file,
    fileName: params.fileName,
    telegramSlot: slot
  });

  return {
    telegramDocument,
    channel: {
      id: slot.channelId,
      name: slot.channelId,
      botToken: slot.botToken,
      chatId: slot.chatId,
      status: "active",
      isDefault: slot.channelId === "default"
    }
  };
}

export async function getRateLimitedTelegramFileUrl(params: {
  env: AppEnv;
  botToken: string;
  fileId: string;
  channelId?: string;
}): Promise<string> {
  await acquireTelegramApiSlot(params.env, "getFile", params.channelId);

  try {
    return await getTelegramFileUrl({
      botToken: params.botToken,
      fileId: params.fileId
    });
  } catch (error) {
    await penalizeTelegramApiSlotFromError(params.env, "getFile", params.channelId, error);
    throw error;
  }
}

async function acquireTelegramUploadSlot(
  env: AppEnv,
  db: AppDatabase | undefined,
  options: { preferredChannelId?: string; preferredChannelIndex?: number } = {}
): Promise<TelegramUploadSlot> {
  const channels = await listUploadTelegramChannels(env, db);
  const channelIds = channels.map((channel) => channel.id);
  const preferredByIndex = Number.isSafeInteger(options.preferredChannelIndex) && channels.length > 0
    ? channels[Math.abs(Number(options.preferredChannelIndex)) % channels.length]?.id
    : undefined;
  const preferredChannelId = options.preferredChannelId ?? preferredByIndex;
  const slot = await acquireTelegramApiSlot(env, "sendDocument", undefined, channelIds, preferredChannelId);
  const selectedChannel = channels.find((channel) => channel.id === slot.channelId) ?? channels[0];

  if (!selectedChannel || !slot.token) {
    throw new AppError(502, "TelegramRateLimiterFailed", "Telegram rate limiter did not return an upload channel");
  }

  return {
    scope: "sendDocument",
    token: slot.token,
    channelId: selectedChannel.id,
    botToken: selectedChannel.botToken,
    chatId: selectedChannel.chatId
  };
}

async function acquireTelegramApiSlot(
  env: AppEnv,
  scope: TelegramRateLimitScope,
  channelId?: string,
  channelIds?: string[],
  preferredChannelId?: string
): Promise<TelegramApiSlot> {
  const normalizedChannelId = normalizeTelegramChannelId(channelId);
  const limiter = env.TELEGRAM_RATE_LIMITER;
  if (!limiter) {
    return {
      scope,
      channelId: normalizedChannelId,
      ...(scope === "sendDocument" ? { token: crypto.randomUUID() } : {})
    };
  }

  const response = await limiter.fetch("https://telegram-rate-limiter/acquire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope,
      channel_id: normalizedChannelId,
      ...(channelIds ? { channel_ids: channelIds } : {}),
      ...(preferredChannelId ? { preferred_channel_id: preferredChannelId } : {})
    })
  });

  if (!response.ok) {
    throw new AppError(502, "TelegramRateLimiterFailed", "Telegram rate limiter failed");
  }

  const body = await response.json().catch(() => ({})) as { token?: unknown; channel_id?: unknown };
  return {
    scope,
    channelId: typeof body.channel_id === "string" && body.channel_id ? body.channel_id : normalizedChannelId,
    ...(typeof body.token === "string" && body.token ? { token: body.token } : {})
  };
}

async function releaseTelegramApiSlot(env: AppEnv, slot: TelegramApiSlot): Promise<void> {
  if (slot.scope !== "sendDocument" || !slot.token || !env.TELEGRAM_RATE_LIMITER) {
    return;
  }

  try {
    await env.TELEGRAM_RATE_LIMITER.fetch("https://telegram-rate-limiter/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: slot.scope,
        channel_id: slot.channelId ?? "default",
        token: slot.token
      })
    });
  } catch (error) {
    console.warn("Failed to release Telegram API rate limit slot", {
      scope: slot.scope,
      channel_id: slot.channelId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function penalizeTelegramApiSlotFromError(
  env: AppEnv,
  scope: TelegramRateLimitScope,
  channelId: string | undefined,
  error: unknown
): Promise<void> {
  const retryAfterSeconds = telegramRetryAfterSeconds(error);
  if (!retryAfterSeconds || !env.TELEGRAM_RATE_LIMITER) {
    return;
  }

  try {
    await env.TELEGRAM_RATE_LIMITER.fetch("https://telegram-rate-limiter/penalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        channel_id: channelId ?? "default",
        retry_after_ms: retryAfterSeconds * 1000
      })
    });
  } catch (penaltyError) {
    console.warn("Failed to update Telegram API rate limit penalty", {
      scope,
      channel_id: channelId,
      error: penaltyError instanceof Error ? penaltyError.message : String(penaltyError)
    });
  }
}

function isTelegramChannelConfigured(record: TelegramChannelRecord): boolean {
  return Boolean(record.bot_token_encrypted && record.chat_id.trim());
}

async function materializeTelegramChannel(record: TelegramChannelRecord, env: AppEnv): Promise<TelegramStorageChannel | null> {
  if (!isTelegramChannelConfigured(record)) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    botToken: await decryptTelegramBotToken(record.bot_token_encrypted, env),
    chatId: record.chat_id,
    status: record.status,
    isDefault: record.is_default === 1
  };
}

function defaultEnvTelegramChannel(env: AppEnv): TelegramStorageChannel | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_STORAGE_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    return null;
  }

  return {
    id: "default",
    name: "default",
    botToken,
    chatId,
    status: "active",
    isDefault: true
  };
}

export async function resolveTelegramChannel(env: AppEnv, db: AppDatabase | undefined, channelId: string | null | undefined): Promise<TelegramStorageChannel> {
  const normalizedChannelId = normalizeTelegramChannelId(channelId);

  if (db) {
    const record = await getTelegramChannelRecord(db, normalizedChannelId);
    if (record) {
      const materialized = await materializeTelegramChannel(record, env);
      if (materialized) {
        return materialized;
      }
    }
  }

  if (normalizedChannelId === "default") {
    const fallback = defaultEnvTelegramChannel(env);
    if (fallback) {
      return fallback;
    }
  }

  throw new AppError(500, "TelegramChannelNotConfigured", `Telegram channel '${normalizedChannelId}' is not configured`);
}

async function listUploadTelegramChannels(env: AppEnv, db: AppDatabase | undefined): Promise<TelegramStorageChannel[]> {
  const channels: TelegramStorageChannel[] = [];

  if (db) {
    const records = await listActiveTelegramChannelRecords(db);
    for (const record of records) {
      const materialized = await materializeTelegramChannel(record, env);
      if (materialized) {
        channels.push(materialized);
      } else if (record.id === "default") {
        const fallback = defaultEnvTelegramChannel(env);
        if (fallback) {
          channels.push(fallback);
        }
      }
    }
  }

  if (channels.length === 0) {
    const fallback = defaultEnvTelegramChannel(env);
    if (fallback) {
      channels.push(fallback);
    }
  }

  if (channels.length === 0) {
    throw new AppError(500, "TelegramChannelNotConfigured", "At least one active Telegram channel must be configured");
  }

  return channels;
}

async function serializeTelegramChannelRecord(record: TelegramChannelRecord, env: AppEnv): Promise<Record<string, unknown>> {
  const botToken = record.bot_token_encrypted ? await decryptTelegramBotToken(record.bot_token_encrypted, env) : "";

  return {
    id: record.id,
    name: record.name,
    chat_id: record.chat_id,
    masked_bot_token: maskSecret(botToken),
    configured: Boolean(botToken && record.chat_id.trim()),
    status: record.status,
    is_default: record.is_default === 1,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export {
  type TelegramApiSlot,
  type TelegramUploadSlot,
  type TelegramRateLimitScope,
  uploadRateLimitedTelegramDocument,
  acquireTelegramUploadSlot,
  acquireTelegramApiSlot,
  releaseTelegramApiSlot,
  penalizeTelegramApiSlotFromError,
  isTelegramChannelConfigured,
  materializeTelegramChannel,
  defaultEnvTelegramChannel,
  listUploadTelegramChannels,
  serializeTelegramChannelRecord
};
