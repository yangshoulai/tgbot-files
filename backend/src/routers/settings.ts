import { requireDb } from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import { updateAdminSettingsPayload } from "../services/admin-settings";
import { readJsonObject } from "../validators/request";

export async function handleAdminSettings(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    return jsonResponse(await updateAdminSettingsPayload(db, body));
  }

  return errorResponse(new AppError(405, "MethodNotAllowed", "Unsupported settings method"));
}
