import {
  createAdminSessionCookie,
  createExpiredAdminSessionCookie,
  requireAdminSession,
  requireAdminSessionInfo,
  validateAdminCredentials
} from "../services/admin-auth";
import { AppError, jsonResponse, redirectResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import { isPlainRecord } from "../validators/request";

export async function handleAdminLogin(request: Request, env: AppEnv): Promise<Response> {
  const credentials = await readLoginCredentials(request);
  const isFormRequest = isFormContentType(request.headers.get("Content-Type"));

  if (!validateAdminCredentials({ env, ...credentials })) {
    if (isFormRequest) {
      return redirectResponse("/login?error=1", 303);
    }

    throw new AppError(401, "Unauthorized", "Invalid admin username or password");
  }

  const cookie = await createAdminSessionCookie({
    env,
    requestUrl: request.url,
    username: credentials.username,
    persistent: credentials.rememberMe
  });

  if (isFormRequest) {
    return redirectResponse("/admin", 303, { "Set-Cookie": cookie });
  }

  return jsonResponse({ ok: true }, 200, { "Set-Cookie": cookie });
}

export async function handleAdminLogout(request: Request, env: AppEnv): Promise<Response> {
  await requireAdminSession(request, env);

  return jsonResponse(
    { ok: true },
    200,
    { "Set-Cookie": createExpiredAdminSessionCookie(request.url) }
  );
}

export async function handleAuthenticatedAdminRequest(
  request: Request,
  env: AppEnv,
  handler: (username: string) => Promise<Response>
): Promise<Response> {
  const session = await requireAdminSessionInfo(request, env);
  const response = await handler(session.username);

  if (!response.ok) {
    return response;
  }

  // 管理端接口成功后刷新会话 Cookie，保持用户持续操作时不过期。
  const cookie = await createAdminSessionCookie({
    env,
    requestUrl: request.url,
    username: session.username,
    persistent: session.persistent
  });
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", cookie);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readLoginCredentials(request: Request): Promise<{ username: string; password: string; rememberMe: boolean }> {
  const contentType = request.headers.get("Content-Type");

  if (contentType?.toLowerCase().includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (!isPlainRecord(body)) {
      throw new AppError(400, "InvalidJson", "Login request body must be a JSON object");
    }

    return {
      username: typeof body.username === "string" ? body.username : "",
      password: typeof body.password === "string" ? body.password : "",
      rememberMe: body.remember_me !== false && body.rememberMe !== false
    };
  }

  if (isFormContentType(contentType)) {
    const formData = await request.formData();
    const username = formData.get("username");
    const password = formData.get("password");
    const rememberMe = formData.get("remember_me");

    return {
      username: typeof username === "string" ? username : "",
      password: typeof password === "string" ? password : "",
      rememberMe: rememberMe !== "0" && rememberMe !== "false"
    };
  }

  throw new AppError(400, "InvalidContentType", "Login request must use JSON or form data");
}

function isFormContentType(contentType: string | null): boolean {
  const normalized = (contentType || "").toLowerCase();

  return normalized.includes("application/x-www-form-urlencoded") || normalized.includes("multipart/form-data");
}
