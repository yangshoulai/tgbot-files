import { constantTimeEqual, createSignedPayload, TokenError, verifySignedPayload } from "./crypto";
import { AppError, requireEnv } from "./http";

const sessionCookieName = "tgbot_admin";
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

interface AdminSessionPayload {
  v: 1;
  username: string;
  iat: number;
  exp: number;
}

export async function createAdminSessionCookie(params: {
  env: AdminEnv;
  requestUrl: string;
  username: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createSignedPayload(
    {
      v: 1,
      username: params.username,
      iat: now,
      exp: now + sessionMaxAgeSeconds
    } satisfies AdminSessionPayload,
    getAdminSessionSecret(params.env)
  );
  const secure = new URL(params.requestUrl).protocol === "https:" ? "; Secure" : "";

  return `${sessionCookieName}=${token}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`;
}

export function createExpiredAdminSessionCookie(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";

  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}

export async function requireAdminSession(request: Request, env: AdminEnv): Promise<string> {
  const username = await getAdminSession(request, env);

  if (!username) {
    throw new AppError(401, "Unauthorized", "Missing or invalid admin session");
  }

  return username;
}

export async function getAdminSession(request: Request, env: AdminEnv): Promise<string | null> {
  const token = readCookie(request.headers.get("Cookie"), sessionCookieName);

  if (!token) {
    return null;
  }

  try {
    const payload = await verifySignedPayload(token, getAdminSessionSecret(env));

    if (!isAdminSessionPayload(payload)) {
      return null;
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    const configuredUsername = requireEnv(env, "ADMIN_USERNAME");
    if (!constantTimeEqual(payload.username, configuredUsername)) {
      return null;
    }

    return payload.username;
  } catch (error) {
    if (error instanceof TokenError) {
      return null;
    }

    throw error;
  }
}

export function validateAdminCredentials(params: {
  env: AdminEnv;
  username: string;
  password: string;
}): boolean {
  const expectedUsername = requireEnv(params.env, "ADMIN_USERNAME");
  const expectedPassword = requireEnv(params.env, "ADMIN_PASSWORD");

  return (
    constantTimeEqual(params.username, expectedUsername) &&
    constantTimeEqual(params.password, expectedPassword)
  );
}

function getAdminSessionSecret(env: AdminEnv): string {
  return env.ADMIN_SESSION_SECRET?.trim() || requireEnv(env, "LINK_SIGNING_SECRET");
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    if (rawKey === name) {
      return rawValueParts.join("=") || null;
    }
  }

  return null;
}

function isAdminSessionPayload(value: unknown): value is AdminSessionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const payload = value as Partial<AdminSessionPayload>;
  return (
    payload.v === 1 &&
    typeof payload.username === "string" &&
    payload.username.length > 0 &&
    typeof payload.iat === "number" &&
    Number.isSafeInteger(payload.iat) &&
    payload.iat > 0 &&
    typeof payload.exp === "number" &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp > payload.iat
  );
}

interface AdminEnv {
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  LINK_SIGNING_SECRET: string;
}
