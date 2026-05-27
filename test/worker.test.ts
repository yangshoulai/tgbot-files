import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { createSignedToken } from "../src/crypto";
import type { FileRecord } from "../src/database";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_STORAGE_CHAT_ID: "-1001234567890",
  UPLOAD_API_KEY: "upload-secret",
  LINK_SIGNING_SECRET: "link-secret",
  MAX_FILE_BYTES: "20971520"
};

class FakeD1 {
  readonly files: FileRecord[] = [];

  prepare(sql: string): D1PreparedStatement {
    return new FakeD1Statement(this, sql) as unknown as D1PreparedStatement;
  }
}

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    this.bindings = values;
    return this;
  }

  async run(): Promise<D1Result> {
    const normalizedSql = this.sql.trim().toUpperCase();

    if (normalizedSql.startsWith("INSERT INTO FILES")) {
      const [
        id,
        fileName,
        mimeType,
        size,
        md5,
        telegramFileId,
        telegramFileUniqueId,
        filePath,
        uploadedBy,
        createdAt
      ] = this.bindings;

      this.db.files.push({
        id: String(id),
        file_name: String(fileName),
        mime_type: String(mimeType),
        size: Number(size),
        md5: String(md5),
        telegram_file_id: String(telegramFileId),
        telegram_file_unique_id: telegramFileUniqueId === null ? null : String(telegramFileUniqueId),
        file_path: String(filePath),
        uploaded_by: uploadedBy === null ? null : String(uploadedBy),
        created_at: String(createdAt),
        deleted_at: null
      });
    }

    if (normalizedSql.startsWith("UPDATE FILES SET DELETED_AT")) {
      const [deletedAt, id] = this.bindings;
      const file = this.db.files.find((item) => item.id === id);
      if (file) {
        file.deleted_at = String(deletedAt);
      }
    }

    return { success: true, meta: fakeD1Meta(), results: [] };
  }

  async first<T = unknown>(): Promise<T | null> {
    const normalizedSql = this.sql.trim().toUpperCase();

    if (normalizedSql.startsWith("SELECT COUNT(*)")) {
      return { total: this.visibleFiles().length } as T;
    }

    if (normalizedSql.startsWith("SELECT ID FROM FILES")) {
      const id = this.bindings[0];
      const file = this.db.files.find((item) => item.id === id && item.deleted_at === null);
      return (file ? { id: file.id } : null) as T | null;
    }

    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      success: true,
      meta: fakeD1Meta(),
      results: this.visibleFiles() as T[]
    };
  }

  private visibleFiles(): FileRecord[] {
    const pattern = typeof this.bindings[0] === "string" && this.bindings[0].startsWith("%")
      ? this.bindings[0].slice(1, -1).toLowerCase()
      : "";

    return this.db.files.filter((file) => {
      if (file.deleted_at !== null) {
        return false;
      }

      if (!pattern) {
        return true;
      }

      return [file.file_name, file.mime_type, file.md5, file.telegram_file_id]
        .some((value) => value.toLowerCase().includes(pattern));
    });
  }
}

function fakeD1Meta(): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0
  };
}

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
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toEqual([
      "https://api.telegram.org/bot123456:test-token/getFile?file_id=tg-file-id",
      "https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt"
    ]);
  });

  it("proxies repeated signed file access through Telegram each time", async () => {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/getFile?")) {
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
          "Content-Length": "5"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fileUrl = `https://files.example.com/f/${token}/hello.txt`;
    const firstResponse = await worker.fetch(new Request(fileUrl), env);
    expect(await firstResponse.text()).toBe("hello");

    const secondResponse = await worker.fetch(new Request(fileUrl), env);
    expect(await secondResponse.text()).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("forwards range requests to Telegram file download", async () => {
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
    expect(fetchCalls[1]).toEqual({
      input: "https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt",
      range: "bytes=0-1"
    });
  });

  it("can force attachment disposition with download query parameter", async () => {
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
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/getFile?")) {
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
            "Content-Length": "5"
          }
        });
      })
    );

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/hello.txt?download=1`), env);

    expect(response.headers.get("Content-Disposition")).toContain("attachment");
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

describe("admin file manager", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets an admin session cookie after form login", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const form = new URLSearchParams({ username: "admin", password: "secret" });

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form
      }),
      adminEnv
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin");
    expect(response.headers.get("Set-Cookie")).toContain("tgbot_admin=");
  });

  it("uploads from admin UI and writes D1 metadata with a path-only file URL", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-file-id",
              file_unique_id: "tg-unique-id",
              file_name: "hello.txt",
              mime_type: "text/plain",
              file_size: 5
            }
          }
        })
      )
    );
    const cookie = await loginAndGetCookie(adminEnv);
    const upload = uploadRequest({
      token: null,
      env: adminEnv
    });
    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: { Cookie: cookie },
        body: await upload.formData()
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: { md5: string; file_path: string; url: string; download_url: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file.md5).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(body.file.file_path).toMatch(/^\/f\//);
    expect(body.file.url).toBe(`https://cdn.example.com${body.file.file_path}`);
    expect(body.file.download_url).toBe(`${body.file.url}?download=1`);
    expect(db.files).toHaveLength(1);
    expect(db.files[0]?.file_path).toBe(body.file.file_path);
  });

  it("lists and soft-deletes D1 file records", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push({
      id: "file-1",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      size: 12,
      md5: "abc123",
      telegram_file_id: "tg-file-id",
      telegram_file_unique_id: "tg-unique-id",
      file_path: "/f/token/report.pdf",
      uploaded_by: "admin",
      created_at: "2026-05-27T00:00:00.000Z",
      deleted_at: null
    });
    const cookie = await loginAndGetCookie(adminEnv);

    const listResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?q=report", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const listBody = await listResponse.json() as {
      files: Array<{ url: string }>;
      pagination: { total: number };
    };
    expect(listBody.pagination.total).toBe(1);
    expect(listBody.files[0]?.url).toBe("https://cdn.example.com/f/token/report.pdf");

    const deleteResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files/file-1", {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const deleteBody = await deleteResponse.json() as { ok: boolean };
    expect(deleteBody.ok).toBe(true);
    expect(db.files[0]?.deleted_at).not.toBeNull();

    const afterDeleteResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const afterDeleteBody = await afterDeleteResponse.json() as { pagination: { total: number } };
    expect(afterDeleteBody.pagination.total).toBe(0);
  });
});

async function loginAndGetCookie(envWithAdmin: Env): Promise<string> {
  const response = await worker.fetch(
    new Request("https://files.example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "secret" })
    }),
    envWithAdmin
  );
  const cookie = response.headers.get("Set-Cookie");

  if (!cookie) {
    throw new Error("Expected admin login cookie");
  }

  return cookie;
}
