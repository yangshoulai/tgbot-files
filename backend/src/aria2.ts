import { AppError } from "./http";
import type { AppEnv } from "./runtime";

export interface Aria2File {
  index: string;
  path: string;
  length: string;
  completedLength?: string;
  selected?: string;
}

export interface Aria2Status {
  gid: string;
  status: "active" | "waiting" | "paused" | "error" | "complete" | "removed";
  totalLength?: string;
  completedLength?: string;
  errorCode?: string;
  errorMessage?: string;
  followedBy?: string[];
  following?: string;
  files?: Aria2File[];
  bittorrent?: {
    info?: {
      name?: string;
    };
  };
}

export interface Aria2Config {
  rpcUrl: string;
  rpcSecret: string;
  downloadDir: string;
  metadataTimeoutMs: number;
  downloadMaxBytes: number;
  downloadMinFreeBytes: number;
  downloadRetentionMs: number;
}

export interface Aria2DownloadConfig {
  downloadDir: string;
  downloadMaxBytes: number;
  downloadMinFreeBytes: number;
  downloadRetentionMs: number;
}

let rpcCounter = 0;

export function resolveAria2DownloadConfig(env: AppEnv): Aria2DownloadConfig {
  return {
    downloadDir: env.ARIA2_DOWNLOAD_DIR?.trim() || "/data/aria2/downloads",
    downloadMaxBytes: parseNonNegativeBytes(env.ARIA2_DOWNLOAD_MAX_BYTES, 20 * 1024 * 1024 * 1024, "ARIA2_DOWNLOAD_MAX_BYTES"),
    downloadMinFreeBytes: parseNonNegativeBytes(env.ARIA2_DOWNLOAD_MIN_FREE_BYTES, 5 * 1024 * 1024 * 1024, "ARIA2_DOWNLOAD_MIN_FREE_BYTES"),
    downloadRetentionMs: parseRetentionMs(env.ARIA2_DOWNLOAD_RETENTION_HOURS)
  };
}

export function requireAria2Config(env: AppEnv): Aria2Config {
  const rpcUrl = env.ARIA2_RPC_URL?.trim();
  const rpcSecret = env.ARIA2_RPC_SECRET?.trim();
  const downloadConfig = resolveAria2DownloadConfig(env);

  if (!rpcUrl) {
    throw new AppError(500, "Aria2NotConfigured", "ARIA2_RPC_URL is required for magnet uploads");
  }

  if (!rpcSecret) {
    throw new AppError(500, "Aria2NotConfigured", "ARIA2_RPC_SECRET is required for magnet uploads");
  }

  return {
    rpcUrl,
    rpcSecret,
    ...downloadConfig,
    metadataTimeoutMs: parseMetadataTimeoutMs(env.ARIA2_METADATA_TIMEOUT_SECONDS)
  };
}

export async function aria2AddUri(config: Aria2Config, uris: string[], options: Record<string, string>): Promise<string> {
  return aria2Rpc<string>(config, "aria2.addUri", [uris, options]);
}

export async function aria2TellStatus(config: Aria2Config, gid: string): Promise<Aria2Status> {
  return aria2Rpc<Aria2Status>(config, "aria2.tellStatus", [
    gid,
    [
      "gid",
      "status",
      "totalLength",
      "completedLength",
      "errorCode",
      "errorMessage",
      "followedBy",
      "following",
      "files",
      "bittorrent"
    ]
  ]);
}

export async function aria2ForceRemove(config: Aria2Config, gid: string): Promise<void> {
  await aria2Rpc<string>(config, "aria2.forceRemove", [gid]).catch(async (error) => {
    if (error instanceof AppError && error.error === "Aria2RpcFailed") {
      return;
    }
    throw error;
  });
}

async function aria2Rpc<T>(config: Aria2Config, method: string, params: unknown[]): Promise<T> {
  rpcCounter += 1;
  const payload = {
    jsonrpc: "2.0",
    id: `tgbot-files-${Date.now()}-${rpcCounter}`,
    method,
    params: [`token:${config.rpcSecret}`, ...params]
  };

  let response: Response;
  try {
    response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new AppError(502, "Aria2Unavailable", "aria2 RPC is not reachable");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AppError(502, "Aria2InvalidResponse", "aria2 RPC returned a non-JSON response");
  }

  if (!response.ok) {
    throw new AppError(502, "Aria2RpcFailed", `aria2 RPC returned HTTP ${response.status}`);
  }

  if (!isRecord(body)) {
    throw new AppError(502, "Aria2InvalidResponse", "aria2 RPC returned an invalid response");
  }

  const error = body.error;
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "aria2 RPC failed";
    throw new AppError(502, "Aria2RpcFailed", message, {
      ...(typeof error.code === "number" ? { aria2_code: error.code } : {})
    });
  }

  return body.result as T;
}

function parseMetadataTimeoutMs(value: string | undefined): number {
  const seconds = Number(value || "30");
  const normalized = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 30;
  return Math.min(Math.max(normalized, 5), 300) * 1000;
}

function parseNonNegativeBytes(value: string | undefined, fallback: number, name: string): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(500, "ServerMisconfigured", `${name} must be a non-negative integer`);
  }

  return parsed;
}

function parseRetentionMs(value: string | undefined): number {
  const parsed = Number(value?.trim());
  const hours = Number.isFinite(parsed) ? Math.floor(parsed) : 24;
  const boundedHours = Math.min(24 * 30, Math.max(0, hours));
  return boundedHours * 60 * 60 * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
