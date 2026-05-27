const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface FileTokenPayload {
  v: 1;
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  iat: number;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export async function createSignedToken(
  payload: FileTokenPayload,
  secret: string
): Promise<string> {
  return createSignedPayload(payload, secret);
}

export async function verifySignedToken(
  token: string,
  secret: string
): Promise<FileTokenPayload> {
  return parsePayload(await verifySignedPayload(token, secret));
}

export async function createSignedPayload(payload: unknown, secret: string): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = textEncoder.encode(payloadJson);
  const signature = await hmacSha256(secret, payloadBytes);

  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`;
}

export async function verifySignedPayload(token: string, secret: string): Promise<unknown> {
  const [payloadPart, signaturePart, extraPart] = token.split(".");

  if (!payloadPart || !signaturePart || extraPart !== undefined) {
    throw new TokenError("Invalid token format");
  }

  const payloadBytes = base64UrlDecode(payloadPart);
  const payloadJson = textDecoder.decode(payloadBytes);
  const expectedSignature = base64UrlEncode(await hmacSha256(secret, payloadBytes));

  if (!constantTimeEqual(signaturePart, expectedSignature)) {
    throw new TokenError("Invalid token signature");
  }

  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    throw new TokenError("Invalid token payload JSON");
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = left.charCodeAt(index) || 0;
    const rightCode = right.charCodeAt(index) || 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  if (!secret) {
    throw new TokenError("Missing signing secret");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(data));

  return new Uint8Array(signature);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TokenError("Invalid base64url input");
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

function parsePayload(parsed: unknown): FileTokenPayload {
  if (!isRecord(parsed)) {
    throw new TokenError("Invalid token payload");
  }

  const payload = parsed as Partial<FileTokenPayload>;

  if (
    payload.v !== 1 ||
    typeof payload.file_id !== "string" ||
    payload.file_id.length === 0 ||
    typeof payload.name !== "string" ||
    payload.name.length === 0 ||
    typeof payload.mime_type !== "string" ||
    payload.mime_type.length === 0 ||
    typeof payload.size !== "number" ||
    !Number.isSafeInteger(payload.size) ||
    payload.size < 0 ||
    typeof payload.iat !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat <= 0
  ) {
    throw new TokenError("Invalid token payload fields");
  }

  return {
    v: 1,
    file_id: payload.file_id,
    name: payload.name,
    mime_type: payload.mime_type,
    size: payload.size,
    iat: payload.iat
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
