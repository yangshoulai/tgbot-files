import {
  getApiKeyRecord,
  insertApiKeyRecord,
  listApiKeyRecords,
  softDeleteApiKeyRecord,
  updateApiKeyRecord
} from "../database";
import { AppError, errorResponse, jsonResponse } from "../utils/http";
import type { AppEnv } from "../runtime";
import { requireDb } from "../database";
import { serializeApiKeyRecord } from "../serializers/api-key";
import { normalizeApiKeyStatus, normalizeName, readJsonObject } from "../validators/request";

export async function handleAdminApiKeys(request: Request, env: AppEnv): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/api-keys") {
    const records = await listApiKeyRecords(db);

    return jsonResponse({
      ok: true,
      api_keys: records.map((record) => serializeApiKeyRecord(record, false))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/api-keys") {
    const body = await readJsonObject(request);
    const name = normalizeName(body.name, "API key name");
    const createdAt = new Date().toISOString();
    const record = await insertApiKeyRecord(db, {
      id: crypto.randomUUID(),
      name,
      key: generateApiKey(),
      createdAt
    });

    return jsonResponse({ ok: true, api_key: serializeApiKeyRecord(record, true) }, 201);
  }

  const match = /^\/api\/admin\/api-keys\/([^/]+)$/.exec(url.pathname);
  const id = match?.[1] ? decodeURIComponent(match[1]) : "";

  if (!id) {
    return errorResponse(new AppError(404, "NotFound", "Admin API key route not found"));
  }

  if (request.method === "GET") {
    const record = await getApiKeyRecord(db, id);

    if (!record) {
      throw new AppError(404, "NotFound", "API key not found");
    }

    return jsonResponse({ ok: true, api_key: serializeApiKeyRecord(record, true) });
  }

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const name = body.name === undefined ? undefined : normalizeName(body.name, "API key name");
    const status = body.status === undefined ? undefined : normalizeApiKeyStatus(body.status);
    const record = await updateApiKeyRecord({
      db,
      id,
      updatedAt: new Date().toISOString(),
      ...(name ? { name } : {}),
      ...(status ? { status } : {})
    });

    if (!record) {
      throw new AppError(404, "NotFound", "API key not found");
    }

    return jsonResponse({ ok: true, api_key: serializeApiKeyRecord(record, false) });
  }

  if (request.method === "DELETE") {
    const deleted = await softDeleteApiKeyRecord(db, id, new Date().toISOString());

    if (!deleted) {
      throw new AppError(404, "NotFound", "API key not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(405, "MethodNotAllowed", "Unsupported API key method"));
}

function generateApiKey(): string {
  const left = crypto.randomUUID().replace(/-/g, "");
  const right = crypto.randomUUID().replace(/-/g, "");

  return `tgf_${left}${right.slice(0, 16)}`;
}
