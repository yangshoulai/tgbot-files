import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { createSignedToken } from "../src/crypto";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_STORAGE_CHAT_ID: "-1001234567890",
  UPLOAD_API_KEY: "upload-secret",
  LINK_SIGNING_SECRET: "link-secret",
  MAX_FILE_BYTES: "20971520"
};

function uploadRequest(options?: {
  token?: string | null;
  file?: File | string | null;
  env?: Env;
  contentTypeOverride?: string;
}): Request {
  const form = new FormData();
  const file = options?.file === undefined ? new File(["hello"], "hello.txt", { type: "text/plain" }) : options.file;

  if (file !== null) {
    form.set("file", file);
  }

  const headers = new Headers();
  if (options?.token !== null) {
    headers.set("Authorization", `Bearer ${options?.token ?? env.UPLOAD_API_KEY}`);
  }
  if (options?.contentTypeOverride) {
    headers.set("Content-Type", options.contentTypeOverride);
  }

  return new Request("https://files.example.com/api/v1/files", {
    method: "POST",
    headers,
    body: form
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined)
    }
  });
}

function createMemoryCache(): Pick<Cache, "match" | "put"> {
  const store = new Map<string, Response>();

  return {
    async match(input: RequestInfo | URL): Promise<Response | undefined> {
      const cachedResponse = store.get(cacheKeyUrl(input));
      return cachedResponse?.clone();
    },
    async put(input: RequestInfo | URL, response: Response): Promise<void> {
      store.set(cacheKeyUrl(input), response.clone());
    }
  };
}

function cacheKeyUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

describe("worker upload endpoint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects missing bearer auth", async () => {
    const response = await worker.fetch(uploadRequest({ token: null }), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects invalid bearer auth", async () => {
    const response = await worker.fetch(uploadRequest({ token: "wrong" }), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects missing file", async () => {
    const response = await worker.fetch(uploadRequest({ file: null }), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("MissingFile");
  });

  it("rejects empty file", async () => {
    const response = await worker.fetch(
      uploadRequest({ file: new File([""], "empty.txt", { type: "text/plain" }) }),
      env
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("EmptyFile");
  });

  it("rejects files over configured limit", async () => {
    const smallLimitEnv = { ...env, MAX_FILE_BYTES: "5" };
    const response = await worker.fetch(
      uploadRequest({ file: new File(["123456"], "too-large.txt", { type: "text/plain" }) }),
      smallLimitEnv
    );
    const body = await response.json() as { error: string; details: { max_file_bytes: number } };

    expect(response.status).toBe(413);
    expect(body.error).toBe("FileTooLarge");
    expect(body.details.max_file_bytes).toBe(5);
  });

  it("uploads a file to Telegram and returns a signed public URL", async () => {
    const fetchCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "tg-file-id",
            file_name: "hello.txt",
            mime_type: "text/plain",
            file_size: 5
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(uploadRequest(), env);
    const body = await response.json() as {
      ok: boolean;
      url: string;
      name: string;
      size: number;
      mime_type: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^https:\/\/files\.example\.com\/f\//);
    expect(body.name).toBe("hello.txt");
    expect(body.size).toBe(5);
    expect(body.mime_type).toBe("text/plain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCalls[0]).toBe("https://api.telegram.org/bot123456:test-token/sendDocument");
  });

  it("accepts small webp files when Telegram returns them as stickers", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          sticker: {
            file_id: "tg-sticker-file-id",
            file_unique_id: "tg-sticker-unique-id",
            file_size: 4
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      uploadRequest({ file: new File(["webp"], "tiny.webp", { type: "image/webp" }) }),
      env
    );
    const body = await response.json() as {
      ok: boolean;
      url: string;
      name: string;
      size: number;
      mime_type: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^https:\/\/files\.example\.com\/f\//);
    expect(body.name).toBe("tiny.webp");
    expect(body.size).toBe(4);
    expect(body.mime_type).toBe("image/webp");
  });

  it("surfaces Telegram upload errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, description: "chat not found", error_code: 400 }, { status: 400 }))
    );

    const response = await worker.fetch(uploadRequest(), env);
    const body = await response.json() as { error: string; message: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe("TelegramUploadFailed");
    expect(body.message).toBe("chat not found");
  });
});

describe("worker file access endpoint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("caches", { default: createMemoryCache() });
  });

  it("proxies a signed file link through Telegram getFile", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));

      if (fetchCalls.length === 1) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "tg-file-id",
            file_size: 5,
            file_path: "documents/file_1.txt"
          }
        });
      }

      return new Response("hello", {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "5",
          "Accept-Ranges": "bytes"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/hello.txt`), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain("hello.txt");
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000");
    expect(response.headers.get("X-TGBOT-Cache")).toBe("MISS");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toEqual([
      "https://api.telegram.org/bot123456:test-token/getFile?file_id=tg-file-id",
      "https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt"
    ]);
  });

  it("serves repeated signed file access from Cloudflare cache without Telegram fetch", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            file_id: "tg-file-id",
            file_size: 5,
            file_path: "documents/file_1.txt"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("hello", {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "5"
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const fileUrl = `https://files.example.com/f/${token}/hello.txt`;
    const firstResponse = await worker.fetch(new Request(fileUrl), env);
    expect(await firstResponse.text()).toBe("hello");
    expect(firstResponse.headers.get("X-TGBOT-Cache")).toBe("MISS");

    const secondResponse = await worker.fetch(new Request(fileUrl), env);
    expect(await secondResponse.text()).toBe("hello");
    expect(secondResponse.headers.get("X-TGBOT-Cache")).toBe("HIT");
    expect(secondResponse.headers.get("Cache-Control")).toBe("public, max-age=31536000");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache for range requests to avoid storing partial responses", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchCalls: Array<{ input: string; range: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        input: String(input),
        range: new Headers(init?.headers).get("Range") ?? undefined
      });

      if (fetchCalls.length === 1) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "tg-file-id",
            file_size: 5,
            file_path: "documents/file_1.txt"
          }
        });
      }

      return new Response("he", {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "2",
          "Content-Range": "bytes 0-1/5"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/hello.txt`, {
        headers: { Range: "bytes=0-1" }
      }),
      env
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("X-TGBOT-Cache")).toBe("BYPASS");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchCalls[1]).toEqual({
      input: "https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt",
      range: "bytes=0-1"
    });
  });

  it("rejects tampered file links", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    const response = await worker.fetch(new Request(`https://files.example.com/f/${tampered}/hello.txt`), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("InvalidFileToken");
  });

  it("surfaces Telegram getFile errors", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, description: "file is too big", error_code: 400 }, { status: 400 }))
    );

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/hello.txt`), env);
    const body = await response.json() as { error: string; message: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe("TelegramFileLookupFailed");
    expect(body.message).toBe("file is too big");
  });
});
