import { AppError, requireEnv } from "./http";
import type { AppEnv } from "../runtime";

export function telegramRetryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof AppError)) {
    return undefined;
  }

  const value = error.details?.telegram_retry_after_seconds;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

export function channelCryptoSecret(env: AppEnv): string {
  return requireEnv({ LINK_SIGNING_SECRET: env.TG_CHANNEL_SECRET || env.LINK_SIGNING_SECRET }, "LINK_SIGNING_SECRET");
}

export async function telegramChannelTokenHash(botToken: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(textEncode(botToken)))));
}

export async function encryptTelegramBotToken(botToken: string, env: AppEnv): Promise<string> {
  if (!botToken) {
    return "";
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importTelegramChannelAesKey(env);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(textEncode(botToken))
  ));

  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(cipher)}`;
}

export async function decryptTelegramBotToken(encrypted: string, env: AppEnv): Promise<string> {
  if (!encrypted) {
    return "";
  }

  const [version, ivPart, cipherPart, extra] = encrypted.split(".");
  if (version !== "v1" || !ivPart || !cipherPart || extra !== undefined) {
    throw new AppError(500, "InvalidTelegramChannelSecret", "Telegram channel bot token cannot be decrypted");
  }

  try {
    const key = await importTelegramChannelAesKey(env);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecode(ivPart)) },
      key,
      toArrayBuffer(base64UrlDecode(cipherPart))
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new AppError(500, "InvalidTelegramChannelSecret", "Telegram channel bot token cannot be decrypted");
  }
}

export function normalizeTelegramChannelId(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized || "default";
}

async function importTelegramChannelAesKey(env: AppEnv): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(textEncode(channelCryptoSecret(env))));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function textEncode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(500, "InvalidTelegramChannelSecret", "Invalid base64url secret data");
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(paddingLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
