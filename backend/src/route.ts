import { TokenError } from "./utils/crypto";
import { AppError, errorResponse, withSecurityHeaders } from "./utils/http";
import type { AppEnv } from "./runtime";
import { handleAdminLogin, handleAdminLogout } from "./routers/auth";
import { handleAdminConsole } from "./routers/console";
import { handleAdminDirectories } from "./routers/directories";
import { handleAdminEntries } from "./routers/entries";
import { handleAdminFiles, handleApiFiles, requireFileMoveNamesAvailable } from "./routers/files-router";
import {
  runScheduledCleanup
} from "./routers/storage-router";
import { handleFileAccess, handleHlsAccess } from "./routers/public-access-router";
import { handleAdminTelegramChannels } from "./routers/telegram-channels";
import { handleAdminMultipartUploads, handleApiMultipartUploads } from "./routers/uploads-router";
import { isReadRequest } from "./utils/common-util";

const HLS_PUBLIC_ROUTE_PREFIX = "/api/hls";

export { runScheduledCleanup };

export async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error);
    }

    if (error instanceof TokenError) {
      return errorResponse(new AppError(401, "InvalidFileToken", "Invalid or tampered file token"));
    }

    console.error("Unexpected server error", error);
    return errorResponse(new AppError(500, "InternalError", "Internal server error"));
  }
}

async function routeRequest(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withSecurityHeaders() });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    return handleAdminLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    return handleAdminLogout(request, env);
  }

  if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
    return handleAdminConsole(request, env, {
      uploads: handleAdminMultipartUploads,
      directories: handleAdminDirectories,
      entries: (currentRequest, currentEnv) => handleAdminEntries(currentRequest, currentEnv, {
        requireFileMoveNamesAvailable
      }),
      files: handleAdminFiles,
      telegramChannels: handleAdminTelegramChannels
    });
  }

  if (url.pathname === "/api/v1/files" || url.pathname.startsWith("/api/v1/files/")) {
    return handleApiFiles(request, env);
  }

  if (url.pathname === "/api/v1/uploads" || url.pathname.startsWith("/api/v1/uploads/")) {
    return handleApiMultipartUploads(request, env);
  }

  if (isReadRequest(request) && url.pathname.startsWith("/f/")) {
    return handleFileAccess(request, env);
  }

  if (isReadRequest(request) && (url.pathname.startsWith("/hls/") || url.pathname.startsWith(`${HLS_PUBLIC_ROUTE_PREFIX}/`))) {
    return handleHlsAccess(request, env);
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return errorResponse(new AppError(404, "NotFound", "Route not found"));
  }

  if (url.pathname === "/f" || url.pathname === "/hls" || url.pathname.startsWith("/f/") || url.pathname.startsWith("/hls/")) {
    return errorResponse(new AppError(404, "NotFound", "Route not found"));
  }

  if (isReadRequest(request) && env.STATIC_ASSETS) {
    return env.STATIC_ASSETS.fetch(request);
  }

  return errorResponse(new AppError(404, "NotFound", "Route not found"));
}
