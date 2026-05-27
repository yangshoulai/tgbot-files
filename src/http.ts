export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  extraHeaders?: HeadersInit
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: withSecurityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      ...headersInitToObject(extraHeaders)
    })
  });
}

export function htmlResponse(body: string, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: withSecurityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      ...headersInitToObject(extraHeaders)
    })
  });
}

export function redirectResponse(location: string, status = 303, extraHeaders?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers: withSecurityHeaders({
      Location: location,
      ...headersInitToObject(extraHeaders)
    })
  });
}

export function errorResponse(error: AppError): Response {
  return jsonResponse(
    {
      ok: false,
      error: error.error,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    },
    error.status
  );
}

export function withSecurityHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);

  result.set("X-Content-Type-Options", "nosniff");
  result.set("Referrer-Policy", "no-referrer");
  result.set("X-Frame-Options", "DENY");
  result.set("Cross-Origin-Resource-Policy", "cross-origin");

  return result;
}

export function requireEnv(env: object, name: string): string {
  const value = (env as Record<string, string | undefined>)[name]?.trim();

  if (!value) {
    throw new AppError(500, "ServerMisconfigured", `Missing required environment variable: ${name}`);
  }

  return value;
}

export function parseMaxFileBytes(value: string | undefined): number {
  if (!value) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(500, "ServerMisconfigured", "MAX_FILE_BYTES must be a positive integer");
  }

  return parsed;
}

export function sanitizeFileName(input: string | undefined): string {
  const rawName = input && input.trim().length > 0 ? input : "file";
  const baseName = rawName.split(/[\\/]/).filter(Boolean).at(-1) || "file";
  const cleaned = baseName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const fallback = cleaned.length > 0 ? cleaned : "file";

  return fallback.slice(0, 180);
}

export function contentDispositionInline(fileName: string): string {
  return contentDisposition("inline", fileName);
}

export function contentDispositionAttachment(fileName: string): string {
  return contentDisposition("attachment", fileName);
}

function contentDisposition(disposition: "attachment" | "inline", fileName: string): string {
  const asciiFallback = fileName
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 120) || "file";
  const encoded = encodeRFC5987ValueChars(fileName);

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function headersInitToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(new Headers(headers).entries());
}
