import type { TelegramRateLimiterClient } from "../runtime";

const SEND_DOCUMENT_INTERVAL_MS = 1_000;
const GET_FILE_INTERVAL_MS = 100;
const SEND_DOCUMENT_LOCK_LEASE_MS = 2 * 60 * 1000;

type RateLimitScope = "sendDocument" | "getFile";

interface RateLimitRequestBody {
  scope?: unknown;
  channel_id?: unknown;
  channel_ids?: unknown;
  preferred_channel_id?: unknown;
  retry_after_ms?: unknown;
  token?: unknown;
}

export function createLocalTelegramRateLimiter(): TelegramRateLimiterClient {
  return new LocalTelegramRateLimiter();
}

class LocalTelegramRateLimiter {
  private readonly nextAvailable = new Map<string, number>();
  private readonly locks = new Map<string, { token: string; until: number }>();
  private queue: Promise<void> = Promise.resolve();

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ ok: false, error: "NotFound" }, 404);
    }

    const body = await request.json().catch(() => ({})) as RateLimitRequestBody;
    const scope = body.scope === "sendDocument" || body.scope === "getFile" ? body.scope : null;
    if (!scope) {
      return json({ ok: false, error: "InvalidScope" }, 400);
    }

    if (url.pathname === "/release") {
      const token = typeof body.token === "string" ? body.token : "";
      const channelId = normalizeChannelId(body.channel_id);
      await this.enqueue(async () => {
        const key = storageKey(scope, channelId);
        const lock = this.locks.get(key);
        if (scope === "sendDocument" && lock?.token === token) {
          this.locks.delete(key);
        }
      });
      return json({ ok: true });
    }

    if (url.pathname === "/penalize") {
      const channelId = normalizeChannelId(body.channel_id);
      const retryAfterMs = normalizeRetryAfterMs(body.retry_after_ms);
      await this.enqueue(async () => {
        const key = storageKey(scope, channelId);
        this.nextAvailable.set(key, Math.max(this.nextAvailable.get(key) ?? 0, Date.now() + retryAfterMs));
      });
      return json({ ok: true });
    }

    if (url.pathname !== "/acquire") {
      return json({ ok: false, error: "NotFound" }, 404);
    }

    const channelIds = normalizeChannelIds(body.channel_ids, body.channel_id);
    const preferredChannelId = typeof body.preferred_channel_id === "string" && body.preferred_channel_id.trim()
      ? body.preferred_channel_id.trim()
      : undefined;
    const result = await this.acquire(scope, channelIds, preferredChannelId);
    return json({
      ok: true,
      wait_ms: result.waitMs,
      channel_id: result.channelId,
      ...(result.token ? { token: result.token } : {})
    });
  }

  private async acquire(
    scope: RateLimitScope,
    channelIds: string[],
    preferredChannelId: string | undefined
  ): Promise<{ channelId: string; waitMs: number; token?: string }> {
    let totalWaitMs = 0;

    while (true) {
      const result = await this.enqueue(async () => this.tryAcquire(scope, channelIds, preferredChannelId));
      if (result.channelId) {
        return {
          channelId: result.channelId,
          waitMs: totalWaitMs,
          ...(result.token ? { token: result.token } : {})
        };
      }

      totalWaitMs += result.waitMs;
      await delay(result.waitMs);
    }
  }

  private tryAcquire(
    scope: RateLimitScope,
    channelIds: string[],
    preferredChannelId: string | undefined
  ): { channelId?: string; waitMs: number; token?: string } {
    const now = Date.now();
    const candidates = channelIds.map((channelId, index) => ({
      channelId,
      index,
      readyAt: this.readyAt(scope, channelId, now)
    }));

    candidates.sort((left, right) => {
      const readyDiff = left.readyAt - right.readyAt;
      if (readyDiff !== 0) return readyDiff;
      if (preferredChannelId) {
        if (left.channelId === preferredChannelId) return -1;
        if (right.channelId === preferredChannelId) return 1;
      }
      return left.index - right.index;
    });

    const selected = candidates[0];
    if (!selected) {
      return { waitMs: intervalForScope(scope) };
    }

    if (selected.readyAt > now) {
      return { waitMs: Math.max(25, Math.min(1_000, selected.readyAt - now)) };
    }

    const key = storageKey(scope, selected.channelId);
    this.nextAvailable.set(key, now + intervalForScope(scope));

    if (scope !== "sendDocument") {
      return { channelId: selected.channelId, waitMs: 0 };
    }

    const token = crypto.randomUUID();
    this.locks.set(key, { token, until: now + SEND_DOCUMENT_LOCK_LEASE_MS });
    return { channelId: selected.channelId, waitMs: 0, token };
  }

  private readyAt(scope: RateLimitScope, channelId: string, now: number): number {
    const key = storageKey(scope, channelId);
    const nextAvailableAt = this.nextAvailable.get(key) ?? 0;
    const lock = this.locks.get(key);

    if (lock && lock.until <= now) {
      this.locks.delete(key);
      return nextAvailableAt;
    }

    return Math.max(nextAvailableAt, lock?.until ?? 0);
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeChannelIds(value: unknown, fallback: unknown): string[] {
  if (Array.isArray(value)) {
    const channels = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (channels.length > 0) {
      return channels;
    }
  }

  return [normalizeChannelId(fallback)];
}

function normalizeChannelId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function normalizeRetryAfterMs(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : intervalForScope("sendDocument");
}

function intervalForScope(scope: RateLimitScope): number {
  return scope === "sendDocument" ? SEND_DOCUMENT_INTERVAL_MS : GET_FILE_INTERVAL_MS;
}

function storageKey(scope: RateLimitScope, channelId: string): string {
  return `${scope}:${channelId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
