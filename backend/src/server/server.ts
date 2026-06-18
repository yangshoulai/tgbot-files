import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest, runScheduledCleanup } from "../route";
import type { AppEnv } from "../runtime";
import { createLocalTelegramRateLimiter } from "./local-rate-limiter";
import { createStaticAssetHandler } from "./static-assets";
import { openSqliteDatabase } from "./sqlite-db";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

loadDotEnv(firstExistingPath([
  process.env.ENV_FILE,
  path.join(process.cwd(), ".env"),
  path.join(repoRoot, ".env")
]));

const host = process.env.HOST || "0.0.0.0";
const port = parsePort(process.env.PORT);
const databasePath = path.resolve(process.env.SQLITE_DB_PATH || process.env.DATABASE_PATH || "/data/tgbot-files.sqlite");
const cleanupIntervalMs = parseCleanupIntervalMs(process.env.CLEANUP_INTERVAL_MINUTES);
const migrationsDir = firstExistingPath([
  process.env.SQLITE_MIGRATIONS_DIR,
  path.join(process.cwd(), "backend/migrations"),
  path.join(process.cwd(), "migrations"),
  path.join(repoRoot, "backend/migrations")
]);
const staticDir = firstExistingPath([
  process.env.STATIC_DIR,
  process.env.ASSETS_DIR,
  path.join(process.cwd(), "frontend/dist"),
  path.join(process.cwd(), "../frontend/dist"),
  path.join(repoRoot, "frontend/dist")
]);

if (!migrationsDir) {
  throw new Error("Missing migrations directory. Set SQLITE_MIGRATIONS_DIR or run from the repo root.");
}

if (!staticDir) {
  throw new Error("Missing frontend dist directory. Run pnpm build:frontend or set STATIC_DIR.");
}

const env: AppEnv = {
  STATIC_ASSETS: createStaticAssetHandler(staticDir),
  DATABASE: openSqliteDatabase({ databasePath, migrationsDir }),
  TELEGRAM_RATE_LIMITER: createLocalTelegramRateLimiter(),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_STORAGE_CHAT_ID: process.env.TELEGRAM_STORAGE_CHAT_ID || "",
  LINK_SIGNING_SECRET: process.env.LINK_SIGNING_SECRET || "",
  ...optionalEnv("ADMIN_USERNAME"),
  ...optionalEnv("ADMIN_PASSWORD"),
  ...optionalEnv("ADMIN_SESSION_SECRET"),
  ...optionalEnv("PUBLIC_BASE_URL"),
  ...optionalEnv("MAX_FILE_BYTES"),
  ...optionalEnv("STALE_MULTIPART_UPLOAD_TTL_HOURS"),
  ...optionalEnv("TG_CHANNEL_SECRET"),
  ...optionalEnv("ARIA2_RPC_URL"),
  ...optionalEnv("ARIA2_RPC_SECRET"),
  ...optionalEnv("ARIA2_DOWNLOAD_DIR"),
  ...optionalEnv("ARIA2_METADATA_TIMEOUT_SECONDS"),
  ...optionalEnv("ARIA2_DOWNLOAD_MAX_BYTES"),
  ...optionalEnv("ARIA2_DOWNLOAD_MIN_FREE_BYTES"),
  ...optionalEnv("ARIA2_DOWNLOAD_RETENTION_HOURS"),
  ...optionalEnv("ARIA2_BT_TRACKERS"),
  ...optionalEnv("ARIA2_SPLIT"),
  ...optionalEnv("ARIA2_MAX_CONNECTION_PER_SERVER"),
  ...optionalEnv("ARIA2_MIN_SPLIT_SIZE"),
  ...optionalEnv("ARIA2_BT_MAX_PEERS")
};

const server = createServer((request, response) => {
  void handleNodeRequest(request, response);
});

server.listen(port, host, () => {
  console.log(`tgbot-files server listening on http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
  console.log(`Static directory: ${staticDir}`);
  console.log(`Cleanup interval: ${Math.round(cleanupIntervalMs / 60_000)} minutes`);
});

startScheduledCleanup();

async function handleNodeRequest(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  try {
    const request = createWebRequest(incoming);
    const response = await handleRequest(request, env);
    await writeWebResponse(outgoing, response);
  } catch (error) {
    console.error("Server request failed", error);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    outgoing.end(JSON.stringify({ ok: false, error: "InternalError", message: "Internal server error" }));
  }
}

function createWebRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const protocol = forwardedHeader(headers, "x-forwarded-proto") || "http";
  const hostHeader = forwardedHeader(headers, "x-forwarded-host") || headers.get("host") || `localhost:${port}`;
  const url = new URL(incoming.url || "/", `${protocol}://${hostHeader}`);
  const init: RequestInit & { duplex?: "half" } = {
    method: incoming.method || "GET",
    headers
  };

  if (incoming.method && !["GET", "HEAD"].includes(incoming.method.toUpperCase())) {
    init.body = incoming as unknown as BodyInit;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function writeWebResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value);
  });

  if (!response.body) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      outgoing.write(Buffer.from(value));
    }
  }
  outgoing.end();
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value || "8787");
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

function parseCleanupIntervalMs(value: string | undefined): number {
  const parsed = Number(value || "360");
  const minutes = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 360;
  return Math.max(5, minutes) * 60 * 1000;
}

function forwardedHeader(headers: Headers, name: string): string | null {
  return headers.get(name)?.split(",")[0]?.trim() || null;
}

function firstExistingPath(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function loadDotEnv(filePath: string | null): void {
  if (!filePath) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function optionalEnv<K extends keyof AppEnv>(name: K): Partial<Pick<AppEnv, K>> {
  const value = process.env[name as string];
  return value === undefined ? {} : { [name]: value } as Partial<Pick<AppEnv, K>>;
}

function startScheduledCleanup(): void {
  const run = () => {
    void runScheduledCleanup(env, Date.now(), "server").catch((error) => {
      console.error("Scheduled cleanup failed", error);
    });
  };

  setInterval(run, cleanupIntervalMs).unref();
  run();
}
