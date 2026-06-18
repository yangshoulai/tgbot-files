import {
  deleteTelegramChannelRecord,
  getTelegramChannelRecord,
  getTelegramChannelUsage,
  insertTelegramChannelRecord,
  listTelegramChannelRecords,
  requireDb,
  updateTelegramChannelRecord,
  type TelegramChannelRecord,
  type TelegramChannelStatus
} from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppDatabase, AppEnv } from "../runtime";
import { decryptTelegramBotToken, encryptTelegramBotToken, telegramChannelTokenHash } from "../utils/telegram-util";
import { maskSecret } from "../utils/common-util";
import { normalizeName, readJsonObject } from "../validators/request";

interface TelegramChannelFormInput {
  name: string;
  botToken?: string;
  chatId: string;
  status: TelegramChannelStatus;
}

export async function handleAdminTelegramChannels(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/telegram-channels") {
    const records = await listTelegramChannelRecords(db);
    return jsonResponse({
      ok: true,
      channels: await Promise.all(records.map((record) => serializeTelegramChannelRecord(record, env)))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/telegram-channels") {
    const body = await readJsonObject(request);
    const input = normalizeTelegramChannelForm(body, { creating: true });
    const now = new Date().toISOString();
    const botToken = input.botToken ?? "";
    const botTokenHash = await telegramChannelTokenHash(botToken);

    await requireTelegramChannelUnique(db, {
      name: input.name,
      botTokenHash,
      chatId: input.chatId
    });

    await insertTelegramChannelRecord(db, {
      id: crypto.randomUUID(),
      name: input.name,
      botTokenEncrypted: await encryptTelegramBotToken(botToken, env),
      botTokenHash,
      chatId: input.chatId,
      status: input.status,
      createdAt: now,
      updatedAt: now
    });

    const records = await listTelegramChannelRecords(db);
    const created = records.find((record) => record.name === input.name && record.chat_id === input.chatId);

    return jsonResponse({
      ok: true,
      channel: created ? await serializeTelegramChannelRecord(created, env) : null
    }, 201);
  }

  const match = /^\/api\/admin\/telegram-channels\/([^/]+)$/.exec(url.pathname);
  const id = match?.[1] ? decodeURIComponent(match[1]) : "";

  if (!id) {
    return errorResponse(new AppError(404, "NotFound", "Admin Telegram channel route not found"));
  }

  const existing = await getTelegramChannelRecord(db, id);
  if (!existing) {
    throw new AppError(404, "NotFound", "Telegram channel not found");
  }

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const input = normalizeTelegramChannelForm(body, { creating: false, existing });
    const nextBotTokenEncrypted = input.botToken
      ? await encryptTelegramBotToken(input.botToken, env)
      : existing.bot_token_encrypted;
    const nextBotTokenHash = input.botToken
      ? await telegramChannelTokenHash(input.botToken)
      : existing.bot_token_hash;

    if (!nextBotTokenEncrypted || !nextBotTokenHash) {
      throw new AppError(400, "InvalidBody", "bot_token is required before this Telegram channel can be saved");
    }

    await requireTelegramChannelUnique(db, {
      name: input.name,
      botTokenHash: nextBotTokenHash,
      chatId: input.chatId,
      excludeId: id
    });

    const updated = await updateTelegramChannelRecord(db, {
      id,
      name: existing.is_default === 1 ? "default" : input.name,
      botTokenEncrypted: nextBotTokenEncrypted,
      botTokenHash: nextBotTokenHash,
      chatId: input.chatId,
      status: input.status,
      updatedAt: new Date().toISOString()
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "Telegram channel not found");
    }

    return jsonResponse({ ok: true, channel: await serializeTelegramChannelRecord(updated, env) });
  }

  if (request.method === "DELETE") {
    if (existing.is_default === 1 || existing.id === "default") {
      throw new AppError(400, "DefaultChannelProtected", "default Telegram channel cannot be deleted");
    }

    const usage = await getTelegramChannelUsage(db, id);
    if (usage.files > 0 || usage.chunks > 0) {
      throw new AppError(409, "TelegramChannelInUse", "Telegram channel is still referenced by files or chunks", {
        files: usage.files,
        chunks: usage.chunks
      });
    }

    const deleted = await deleteTelegramChannelRecord(db, id);
    if (!deleted) {
      throw new AppError(404, "NotFound", "Telegram channel not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(405, "MethodNotAllowed", "Unsupported Telegram channel method"));
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

function normalizeTelegramChannelForm(
  body: Record<string, unknown>,
  options: { creating: boolean; existing?: TelegramChannelRecord }
): TelegramChannelFormInput {
  const existing = options.existing;
  const name = existing?.is_default === 1
    ? "default"
    : normalizeName(body.name ?? existing?.name, "Telegram channel name");
  const botTokenValue = body.bot_token === undefined ? undefined : body.bot_token;
  const botToken = normalizeTelegramBotToken(botTokenValue, options.creating);
  const chatId = normalizeTelegramChatId(body.chat_id ?? existing?.chat_id);
  const status = body.status === undefined
    ? existing?.status ?? "active"
    : normalizeTelegramChannelStatus(body.status);

  return {
    name,
    ...(botToken ? { botToken } : {}),
    chatId,
    status
  };
}

function normalizeTelegramBotToken(value: unknown, required: boolean): string | undefined {
  if (typeof value !== "string") {
    if (required) {
      throw new AppError(400, "InvalidBody", "bot_token is required");
    }
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    if (required) {
      throw new AppError(400, "InvalidBody", "bot_token is required");
    }
    return undefined;
  }

  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(normalized)) {
    throw new AppError(400, "InvalidBody", "bot_token format is invalid");
  }

  return normalized;
}

function normalizeTelegramChatId(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "chat_id is required");
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new AppError(400, "InvalidBody", "chat_id is required");
  }

  return normalized.slice(0, 128);
}

function normalizeTelegramChannelStatus(value: unknown): TelegramChannelStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new AppError(400, "InvalidBody", "Telegram channel status must be active or disabled");
}

async function requireTelegramChannelUnique(paramsDb: AppDatabase, params: {
  name: string;
  botTokenHash: string;
  chatId: string;
  excludeId?: string;
}): Promise<void> {
  const records = await listTelegramChannelRecords(paramsDb);
  const conflict = records.find((record) =>
    record.id !== params.excludeId &&
    (record.name === params.name || (record.bot_token_hash === params.botTokenHash && record.chat_id === params.chatId))
  );

  if (!conflict) {
    return;
  }

  if (conflict.name === params.name) {
    throw new AppError(409, "TelegramChannelNameConflict", "Telegram channel name already exists");
  }

  throw new AppError(409, "TelegramChannelTargetConflict", "Telegram bot token and chat_id channel already exists");
}
