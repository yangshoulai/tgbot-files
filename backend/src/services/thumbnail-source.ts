import { createSignedPayload, TokenError, verifySignedPayload } from "../utils/crypto";
import {
  getMultipartUploadRecord,
  requireDb
} from "../database";
import {
  AppError,
  requireEnv,
  withSecurityHeaders
} from "../utils/http";
import {
  remoteFetchHeaders,
  storedRemoteRequestHeaders,
  type RemoteRequestHeaders
} from "../services/remote-source";
import {
  MAX_TELEGRAM_MULTIPART_BYTES
} from "../config/upload-limits";
import {
  isPlainRecord
} from "../validators/request";
import type { AppEnv } from "../runtime";
import { copyHeader } from "../utils/common-util";
import { thumbnailSourceKind } from "./storage-shared";
import { type ThumbnailSourceInfo } from "../serializers/multipart-upload";

interface ThumbnailSourceTokenPayload {
  purpose: "thumbnail_source";
  url: string;
  upload_id?: string;
  mime_type: string;
  kind: "image" | "video";
  size: number;
  exp: number;
}

const THUMBNAIL_SOURCE_TOKEN_TTL_SECONDS = 10 * 60;
const IMAGE_THUMBNAIL_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_THUMBNAIL_SOURCE_MAX_BYTES = MAX_TELEGRAM_MULTIPART_BYTES;
const VIDEO_THUMBNAIL_PROXY_DEFAULT_RANGE_BYTES = 2 * 1024 * 1024;

export async function createThumbnailSourceInfo(params: {
  request: Request;
  env: AppEnv;
  uploadId?: string;
  sourceUrl: URL;
  mimeType: string;
  size: number;
}): Promise<ThumbnailSourceInfo | undefined> {
  const kind = thumbnailSourceKind(params.mimeType);

  if (!kind || params.size > thumbnailSourceMaxBytes(kind)) {
    return undefined;
  }

  const expiresAtSeconds = Math.floor(Date.now() / 1000) + THUMBNAIL_SOURCE_TOKEN_TTL_SECONDS;
  const token = await createSignedPayload(
    {
      purpose: "thumbnail_source",
      url: params.sourceUrl.toString(),
      ...(params.uploadId ? { upload_id: params.uploadId } : {}),
      mime_type: params.mimeType,
      kind,
      size: params.size,
      exp: expiresAtSeconds
    } satisfies ThumbnailSourceTokenPayload,
    requireEnv(params.env, "LINK_SIGNING_SECRET")
  );
  const requestUrl = new URL(params.request.url);
  const proxyPath = requestUrl.pathname.startsWith("/api/v1/")
    ? "/api/v1/uploads/url-thumbnail-source"
    : "/api/admin/uploads/url-thumbnail-source";

  return {
    available: true,
    kind,
    url: `${proxyPath}?token=${encodeURIComponent(token)}`,
    mimeType: params.mimeType,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString()
  };
}

function thumbnailSourceMaxBytes(kind: "image" | "video"): number {
  return kind === "video" ? VIDEO_THUMBNAIL_SOURCE_MAX_BYTES : IMAGE_THUMBNAIL_SOURCE_MAX_BYTES;
}

export async function handleThumbnailSourceProxy(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    throw new AppError(400, "MissingToken", "Missing thumbnail source token");
  }

  const payload = parseThumbnailSourcePayload(
    await verifySignedPayload(token, requireEnv(env, "LINK_SIGNING_SECRET"))
  );
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (payload.exp < nowSeconds) {
    throw new AppError(401, "ExpiredToken", "Thumbnail source token has expired");
  }

  if (payload.size > thumbnailSourceMaxBytes(payload.kind)) {
    throw new AppError(413, "ThumbnailSourceTooLarge", "Thumbnail source is too large");
  }

  const sourceUrl = new URL(payload.url);
  if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
    throw new AppError(400, "InvalidThumbnailSource", "Thumbnail source URL must use HTTP or HTTPS");
  }

  const sourceHeaders = await thumbnailSourceRequestHeaders(env, payload);
  const rangeHeader = thumbnailProxyRangeHeader(request, payload);
  let response: Response;

  try {
    response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(
        sourceHeaders,
        { Accept: payload.kind === "image" ? "image/*" : "video/*" },
        rangeHeader ? { Range: rangeHeader } : {}
      )
    });
  } catch {
    throw new AppError(502, "ThumbnailSourceFetchFailed", "Failed to fetch thumbnail source");
  }

  if (!response.ok && response.status !== 206) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "ThumbnailSourceFetchFailed",
      `Thumbnail source returned ${response.status}`,
      { source_status: response.status }
    );
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", payload.mime_type || response.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Cache-Control", "private, max-age=600");
  copyHeader(response.headers, headers, "Content-Length");
  copyHeader(response.headers, headers, "Content-Range");
  copyHeader(response.headers, headers, "Accept-Ranges");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function thumbnailSourceRequestHeaders(
  env: AppEnv,
  payload: ThumbnailSourceTokenPayload
): Promise<RemoteRequestHeaders | undefined> {
  if (!payload.upload_id) {
    return undefined;
  }

  const db = requireDb(env);
  const upload = await getMultipartUploadRecord(db, payload.upload_id);
  if (!upload || upload.source_kind !== "url" || upload.source_url !== payload.url) {
    return undefined;
  }

  return storedRemoteRequestHeaders(upload.source_headers_json);
}

function thumbnailProxyRangeHeader(request: Request, payload: ThumbnailSourceTokenPayload): string | undefined {
  const requestedRange = request.headers.get("Range");

  if (requestedRange) {
    return requestedRange;
  }

  if (payload.kind === "video") {
    const end = Math.max(0, Math.min(payload.size, VIDEO_THUMBNAIL_PROXY_DEFAULT_RANGE_BYTES) - 1);
    return `bytes=0-${end}`;
  }

  return undefined;
}

function parseThumbnailSourcePayload(value: unknown): ThumbnailSourceTokenPayload {
  if (!isPlainRecord(value)) {
    throw new TokenError("Invalid thumbnail source token payload");
  }

  if (
    value.purpose !== "thumbnail_source" ||
    typeof value.url !== "string" ||
    (value.upload_id !== undefined && typeof value.upload_id !== "string") ||
    typeof value.mime_type !== "string" ||
    (value.kind !== "image" && value.kind !== "video") ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    typeof value.exp !== "number" ||
    !Number.isSafeInteger(value.exp)
  ) {
    throw new TokenError("Invalid thumbnail source token fields");
  }

  return {
    purpose: "thumbnail_source",
    url: value.url,
    ...(value.upload_id ? { upload_id: value.upload_id.slice(0, 128) } : {}),
    mime_type: value.mime_type,
    kind: value.kind,
    size: value.size,
    exp: value.exp
  };
}
