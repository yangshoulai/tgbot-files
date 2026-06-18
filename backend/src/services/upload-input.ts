import type { FileNameConflictAction } from "../database";
import { AppError } from "../utils/http";
import {
  normalizeRemoteRequestHeaders,
  normalizeSourceUrl,
  type RemoteRequestHeaders
} from "./remote-source";
import { isPlainRecord, readJsonObject } from "../validators/request";

export interface ThumbnailInput {
  file?: File;
  sourceUrl?: URL;
  sourceHeaders?: RemoteRequestHeaders;
  width?: number;
  height?: number;
}

export async function readCompleteUploadInput(
  request: Request,
  searchParams: URLSearchParams,
  normalizeConflictAction: (value: unknown) => FileNameConflictAction
): Promise<{ thumbnail?: ThumbnailInput; conflictAction: FileNameConflictAction }> {
  const queryConflictAction = searchParams.get("on_conflict");
  const contentType = request.headers.get("Content-Type") || "";
  const normalizedContentType = contentType.toLowerCase();

  if (!contentType) {
    return { conflictAction: normalizeConflictAction(queryConflictAction) };
  }

  if (normalizedContentType.includes("application/json")) {
    const body = await request.json() as unknown;
    const bodyConflictAction = isPlainRecord(body) ? body.on_conflict : undefined;
    const thumbnail = isPlainRecord(body) ? readThumbnailInputFromRecord(body) : undefined;
    return {
      conflictAction: normalizeConflictAction(bodyConflictAction ?? queryConflictAction),
      ...(thumbnail ? { thumbnail } : {})
    };
  }

  if (!normalizedContentType.includes("multipart/form-data")) {
    return { conflictAction: normalizeConflictAction(queryConflictAction) };
  }

  const formData = await request.formData();
  const conflictAction = normalizeConflictAction(formData.get("on_conflict") ?? queryConflictAction);
  const thumbnail = readThumbnailInputFromFormData(formData);

  return {
    conflictAction,
    ...(thumbnail ? { thumbnail } : {})
  };
}

export async function readThumbnailRequestInput(request: Request): Promise<ThumbnailInput | undefined> {
  const contentType = request.headers.get("Content-Type") || "";
  const normalizedContentType = contentType.toLowerCase();

  if (normalizedContentType.includes("application/json")) {
    return readThumbnailInputFromRecord(await readJsonObject(request));
  }

  if (!normalizedContentType.includes("multipart/form-data")) {
    throw new AppError(400, "InvalidContentType", "Thumbnail update must use multipart/form-data or application/json");
  }

  return readThumbnailInputFromFormData(await request.formData());
}

export function readThumbnailInputFromFormData(formData: FormData): ThumbnailInput | undefined {
  const thumbnail = formData.get("thumbnail");
  const dimensions = optionalThumbnailDimensions(formData);

  if (thumbnail instanceof File) {
    return {
      file: thumbnail,
      ...dimensions
    };
  }

  const sourceUrl = normalizeSourceUrl(formData.get("thumbnail_url") ?? formData.get("thumbnail_source_url"));
  if (!sourceUrl) {
    return undefined;
  }

  const sourceHeaders = normalizeRemoteRequestHeaders(
    formData.get("thumbnail_headers") ??
    formData.get("thumbnail_source_headers") ??
    formData.get("thumbnail_request_headers")
  );

  return {
    sourceUrl,
    ...(sourceHeaders ? { sourceHeaders } : {}),
    ...dimensions
  };
}

export function readThumbnailInputFromRecord(body: Record<string, unknown>): ThumbnailInput | undefined {
  const nested = isPlainRecord(body.thumbnail) ? body.thumbnail : undefined;
  const sourceUrl = normalizeSourceUrl(
    nested?.url ??
    nested?.thumbnail_url ??
    body.thumbnail_url ??
    body.thumbnail_source_url
  );

  if (!sourceUrl) {
    return undefined;
  }

  const sourceHeaders = normalizeRemoteRequestHeaders(
    nested?.headers ??
    nested?.thumbnail_headers ??
    body.thumbnail_headers ??
    body.thumbnail_source_headers ??
    body.thumbnail_request_headers
  );
  const width = optionalBoundedIntegerValue(nested?.width ?? body.thumbnail_width, 1, 8192);
  const height = optionalBoundedIntegerValue(nested?.height ?? body.thumbnail_height, 1, 8192);

  return {
    sourceUrl,
    ...(sourceHeaders ? { sourceHeaders } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
}

function optionalThumbnailDimensions(formData: FormData): Pick<ThumbnailInput, "width" | "height"> {
  const width = optionalBoundedInteger(formData.get("thumbnail_width"), 1, 8192);
  const height = optionalBoundedInteger(formData.get("thumbnail_height"), 1, 8192);

  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
}

function optionalBoundedInteger(value: FormDataEntryValue | null, min: number, max: number): number | undefined {
  return optionalBoundedIntegerValue(value, min, max);
}

function optionalBoundedIntegerValue(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return undefined;
  }

  return parsed;
}
