import { TokenError, verifySignedToken } from "../utils/crypto";
import {
  type FileNameConflictAction
} from "../database";
import {
  AppError,
  parseMaxFileBytes,
  requireEnv,
  sanitizeFileName
} from "../utils/http";
import { resolveStoredMimeType } from "../utils/mime";
import { fetchTelegramFile } from "../services/telegram";
import {
  normalizeRemoteRequestHeaders,
  normalizeSourceUrl,
  fileTooLargeError,
  remoteFetchHeaders,
  renameUploadFile,
  validateUploadFileSize,
  type RemoteRequestHeaders
} from "../services/remote-source";
import {
  readThumbnailInputFromFormData,
  readThumbnailInputFromRecord,
  type ThumbnailInput
} from "../services/upload-input";
import {
  readCompleteUploadInput as readCompleteUploadInputBase
} from "../services/upload-input";
import {
  normalizeDirectoryPath,
  normalizeOptionalFileName,
  normalizeRemark,
  readJsonObject
} from "../validators/request";
import type { AppEnv } from "../runtime";
import {
  extractOptionalFileToken,
  inferRemoteFileName,
  parseContentLength
} from "../utils/common-util";
import {
  ensureFileExtension,
  normalizeFileNameConflictAction,
  pickRemoteMimeHint
} from "./storage-shared";
import { getRateLimitedTelegramFileUrl } from "./telegram-channel";

export async function readUploadInput(request: Request, env: AppEnv): Promise<{
  file: File;
  remark?: string;
  directoryPath: string;
  conflictAction: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
}> {
  const contentType = request.headers.get("Content-Type") || "";
  const normalizedContentType = contentType.toLowerCase();

  if (normalizedContentType.includes("application/json")) {
    return readUrlUploadJson(request, env);
  }

  if (!normalizedContentType.includes("multipart/form-data")) {
    throw new AppError(400, "InvalidContentType", "Upload request must use multipart/form-data or application/json");
  }

  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const formData = await request.formData();
  const formFile = formData.get("file");
  const fileNameOverride = normalizeOptionalFileName(formData.get("file_name"));
  const sourceHeaders = normalizeRemoteRequestHeaders(
    formData.get("headers") ??
    formData.get("source_headers") ??
    formData.get("request_headers")
  );
  const remark = normalizeRemark(formData.get("remark"));
  const directoryPath = normalizeDirectoryPath(formData.get("directory_path") ?? formData.get("dir") ?? "/");
  const conflictAction = normalizeFileNameConflictAction(formData.get("on_conflict"));
  const thumbnail = readThumbnailInputFromFormData(formData);

  if (formFile instanceof File) {
    validateUploadFileSize(formFile, maxFileBytes);
    const file = fileNameOverride ? renameUploadFile(formFile, fileNameOverride) : formFile;

    return {
      file,
      directoryPath,
      conflictAction,
      ...(thumbnail ? { thumbnail } : {}),
      ...(remark ? { remark } : {})
    };
  }

  const sourceUrl = normalizeSourceUrl(formData.get("url"));
  if (sourceUrl) {
    const file = await downloadFileFromUrl({
      sourceUrl,
      env,
      maxFileBytes,
      ...(sourceHeaders ? { sourceHeaders } : {}),
      ...(fileNameOverride ? { fileName: fileNameOverride } : {})
    });

    return {
      file,
      directoryPath,
      conflictAction,
      ...(thumbnail ? { thumbnail } : {}),
      ...(remark ? { remark } : {})
    };
  }

  throw new AppError(400, "MissingFile", "Multipart field 'file' is required");
}

async function readUrlUploadJson(request: Request, env: AppEnv): Promise<{
  file: File;
  remark?: string;
  directoryPath: string;
  conflictAction: FileNameConflictAction;
  thumbnail?: ThumbnailInput;
}> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const body = await readJsonObject(request);
  const sourceUrl = normalizeSourceUrl(body.url);
  const sourceHeaders = normalizeRemoteRequestHeaders(body.headers ?? body.source_headers ?? body.request_headers);
  const fileNameOverride = normalizeOptionalFileName(body.file_name);
  const conflictAction = normalizeFileNameConflictAction(body.on_conflict);
  const thumbnail = readThumbnailInputFromRecord(body);

  if (!sourceUrl) {
    throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? body.dir ?? "/");
  const file = await downloadFileFromUrl({
    sourceUrl,
    env,
    maxFileBytes,
    ...(sourceHeaders ? { sourceHeaders } : {}),
    ...(fileNameOverride ? { fileName: fileNameOverride } : {})
  });
  const remark = normalizeRemark(body.remark);

  return {
    file,
    directoryPath,
    conflictAction,
    ...(thumbnail ? { thumbnail } : {}),
    ...(remark ? { remark } : {})
  };
}

export async function readCompleteUploadInput(
  request: Request,
  searchParams: URLSearchParams
): Promise<{ thumbnail?: ThumbnailInput; conflictAction: FileNameConflictAction }> {
  return readCompleteUploadInputBase(request, searchParams, normalizeFileNameConflictAction);
}

async function downloadFileFromUrl(params: {
  sourceUrl: URL;
  env: AppEnv;
  maxFileBytes: number;
  fileName?: string;
  sourceHeaders?: RemoteRequestHeaders;
}): Promise<File> {
  const signedFile = await downloadSignedFileUrl(params);
  if (signedFile) {
    return params.fileName ? renameUploadFile(signedFile, params.fileName) : signedFile;
  }
  let response: Response;

  try {
    response = await fetch(params.sourceUrl.toString(), {
      redirect: "follow",
      headers: remoteFetchHeaders(params.sourceHeaders, { Accept: "*/*" })
    });
  } catch {
    throw new AppError(502, "UrlFetchFailed", "Failed to fetch source URL");
  }

  if (!response.ok) {
    throw new AppError(
      response.status >= 500 ? 502 : 400,
      "UrlFetchFailed",
      `Source URL returned ${response.status}`,
      { source_status: response.status }
    );
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  if (contentLength !== undefined && contentLength > params.maxFileBytes) {
    throw fileTooLargeError(params.maxFileBytes, contentLength);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new AppError(502, "UrlFetchFailed", "Failed to read source URL response");
  }

  const initialFileName = inferRemoteFileName(params.sourceUrl, response.headers);
  const remoteMimeHint = pickRemoteMimeHint(response.headers.get("Content-Type"), initialFileName);
  const detectedMimeType = resolveStoredMimeType({
    bytes,
    fileType: remoteMimeHint
  });
  const fileName = params.fileName ?? ensureFileExtension(sanitizeFileName(initialFileName), detectedMimeType);
  const file = new File([bytes], fileName, { type: detectedMimeType });

  validateUploadFileSize(file, params.maxFileBytes);

  return file;
}

async function downloadSignedFileUrl(params: {
  sourceUrl: URL;
  env: AppEnv;
  maxFileBytes: number;
}): Promise<File | undefined> {
  const token = extractOptionalFileToken(params.sourceUrl.pathname);

  if (!token) {
    return undefined;
  }

  let payload: Awaited<ReturnType<typeof verifySignedToken>>;
  try {
    payload = await verifySignedToken(token, requireEnv(params.env, "LINK_SIGNING_SECRET"));
  } catch (error) {
    if (error instanceof TokenError) {
      return undefined;
    }

    throw error;
  }

  if (payload.size > params.maxFileBytes) {
    throw fileTooLargeError(params.maxFileBytes, payload.size);
  }

  if (payload.v !== 1) {
    return undefined;
  }

  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const telegramFileUrl = await getRateLimitedTelegramFileUrl({
    env: params.env,
    botToken,
    fileId: payload.file_id
  });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: null
  });

  let bytes: ArrayBuffer;
  try {
    bytes = await telegramResponse.arrayBuffer();
  } catch {
    throw new AppError(502, "TelegramFileDownloadFailed", "Failed to read Telegram file response");
  }

  const fileName = sanitizeFileName(payload.name);
  const detectedMimeType = resolveStoredMimeType({
    bytes,
    fileType: payload.mime_type || pickRemoteMimeHint(telegramResponse.headers.get("Content-Type"), fileName)
  });
  const file = new File([bytes], ensureFileExtension(fileName, detectedMimeType), { type: detectedMimeType });

  validateUploadFileSize(file, params.maxFileBytes);

  return file;
}
