import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import { buildAdminSessionPayload } from "../services/admin-settings";
import { getPublicBaseUrl } from "../utils/common-util";
import { handleAdminApiKeys } from "./admin-api-keys";
import { handleAuthenticatedAdminRequest } from "./auth";
import { handleAdminSettings } from "./settings";

interface AdminConsoleHandlers {
  uploads: (request: Request, env: AppEnv, username: string) => Promise<Response>;
  directories: (request: Request, env: AppEnv) => Promise<Response>;
  entries: (request: Request, env: AppEnv) => Promise<Response>;
  files: (request: Request, env: AppEnv, username: string) => Promise<Response>;
  telegramChannels: (request: Request, env: AppEnv) => Promise<Response>;
}

export async function handleAdminConsole(request: Request, env: AppEnv, handlers: AdminConsoleHandlers): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminSession(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/uploads" || url.pathname.startsWith("/api/admin/uploads/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handlers.uploads(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/directories" || url.pathname.startsWith("/api/admin/directories/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handlers.directories(request, env));
  }

  if (url.pathname === "/api/admin/entries" || url.pathname.startsWith("/api/admin/entries/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handlers.entries(request, env));
  }

  if (url.pathname === "/api/admin/files" || url.pathname.startsWith("/api/admin/files/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handlers.files(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/telegram-channels" || url.pathname.startsWith("/api/admin/telegram-channels/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handlers.telegramChannels(request, env));
  }

  if (url.pathname === "/api/admin/api-keys" || url.pathname.startsWith("/api/admin/api-keys/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminApiKeys(request, env));
  }

  if (url.pathname === "/api/admin/settings") {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminSettings(request, env));
  }

  return errorResponse(new AppError(404, "NotFound", "Admin route not found"));
}

async function handleAdminSession(request: Request, env: AppEnv, username: string): Promise<Response> {
  return jsonResponse(await buildAdminSessionPayload({
    env,
    username,
    baseUrl: getPublicBaseUrl(request, env.PUBLIC_BASE_URL)
  }));
}
