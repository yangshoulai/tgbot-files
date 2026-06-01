import {
  createAdminSessionCookie,
  createExpiredAdminSessionCookie,
  requireAdminSession,
  requireAdminSessionInfo,
  validateAdminCredentials
} from "./admin-auth";
import { createSignedToken, TokenError, verifySignedToken } from "./crypto";
import {
  completeMultipartUploadRecord,
  getDirectoryRecord,
  getDirectoryRecordByPath,
  getDirectoryUsageStats,
  findActiveApiKeyRecord,
  getApiKeyRecord,
  getFileChunkRecord,
  getFileRecord,
  getGlobalFileUsageStats,
  getMultipartUploadRecord,
  insertDirectoryRecord,
  insertApiKeyRecord,
  insertFileRecord,
  insertMultipartUploadRecord,
  listAllDirectoryRecords,
  listDirectoryChildren,
  listFileChunkRecords,
  listApiKeyRecords,
  listFileRecords,
  moveFileRecords,
  moveDirectoryTree,
  renameDirectoryTree,
  requireDb,
  softDeleteApiKeyRecord,
  softDeleteDirectoryTree,
  softDeleteFileRecord,
  touchApiKeyRecord,
  updateApiKeyRecord,
  updateFileRecordMetadata,
  upsertFileChunkRecord,
  type ApiKeyRecord,
  type ApiKeyStatus,
  type DirectoryRecord,
  type FileChunkRecord,
  type FileRecord,
  type FileTypeFilter,
  type MultipartUploadRecord
} from "./database";
import {
  AppError,
  contentDispositionAttachment,
  contentDispositionInline,
  errorResponse,
  jsonResponse,
  normalizeBaseUrl,
  parseMaxFileBytes,
  redirectResponse,
  requireEnv,
  sanitizeFileName,
  withSecurityHeaders
} from "./http";
import { md5Hex } from "./md5";
import { extensionForMimeType, mimeTypeForFileName, resolveStoredMimeType } from "./mime";
import { fetchTelegramFile, getTelegramFileUrl, uploadDocumentToTelegram } from "./telegram";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_STORAGE_CHAT_ID: string;
  LINK_SIGNING_SECRET: string;
  FILES_DB?: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  MAX_FILE_BYTES?: string;
}

interface UploadResult {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  md5: string;
  filePath: string;
  publicUrl: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  remark?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath: string;
  storageBackend: "telegram_single" | "telegram_multipart";
  chunkSize?: number | null;
  chunkCount?: number | null;
}

interface MultipartInitResult {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  directoryPath: string;
}

interface ParsedByteRange {
  start: number;
  end: number;
  partial: boolean;
}

const TELEGRAM_CHUNK_SIZE_BYTES = 18 * 1024 * 1024;
const DIRECT_MULTIPART_ACCESS_MAX_CHUNKS = 24;
const DIRECT_MULTIPART_ACCESS_MAX_BYTES = TELEGRAM_CHUNK_SIZE_BYTES * DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
const MAX_TELEGRAM_MULTIPART_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TELEGRAM_MULTIPART_CHUNKS = Math.ceil(MAX_TELEGRAM_MULTIPART_BYTES / TELEGRAM_CHUNK_SIZE_BYTES);

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      if (error instanceof AppError) {
        return errorResponse(error);
      }

      if (error instanceof TokenError) {
        return errorResponse(new AppError(401, "InvalidFileToken", "Invalid or tampered file token"));
      }

      console.error("Unexpected worker error", error);
      return errorResponse(new AppError(500, "InternalError", "Internal server error"));
    }
  }
};

export default worker;

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withSecurityHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/") {
    return jsonResponse({
      ok: true,
      service: "tgbot-files",
      endpoints: {
        upload: "POST /api/v1/files",
        file: "GET /f/:token/:filename?",
        admin: "GET /admin"
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    return handleAdminLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    return handleAdminLogout(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminSession(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/uploads" || url.pathname.startsWith("/api/admin/uploads/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminMultipartUploads(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/directories" || url.pathname.startsWith("/api/admin/directories/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminDirectories(request, env));
  }

  if (url.pathname === "/api/admin/entries" || url.pathname.startsWith("/api/admin/entries/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminEntries(request, env));
  }

  if (url.pathname === "/api/admin/files" || url.pathname.startsWith("/api/admin/files/")) {
    return handleAuthenticatedAdminRequest(request, env, (username) =>
      handleAdminFiles(request, env, username)
    );
  }

  if (url.pathname === "/api/admin/api-keys" || url.pathname.startsWith("/api/admin/api-keys/")) {
    return handleAuthenticatedAdminRequest(request, env, () => handleAdminApiKeys(request, env));
  }

  if (request.method === "POST" && url.pathname === "/api/v1/files") {
    return handleUpload(request, env);
  }

  if (request.method === "GET" && url.pathname.startsWith("/f/")) {
    return handleFileAccess(request, env);
  }

  return errorResponse(new AppError(404, "NotFound", "Route not found"));
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  await requireUploadApiKey(request, db);

  const { file, directoryPath } = await readUploadInput(request, env);
  const directory = await ensureWritableDirectory(db, directoryPath);
  const result = await uploadAndRecordFile({
    request,
    env,
    file,
    db,
    directoryPath,
    directoryId: directory?.id ?? null
  });

  return jsonResponse({
    ok: true,
    url: result.publicUrl,
    name: result.name,
    size: result.size,
    mime_type: result.mimeType
  });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
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

async function handleAdminLogout(request: Request, env: Env): Promise<Response> {
  await requireAdminSession(request, env);

  return jsonResponse(
    { ok: true },
    200,
    { "Set-Cookie": createExpiredAdminSessionCookie(request.url) }
  );
}

async function handleAuthenticatedAdminRequest(
  request: Request,
  env: Env,
  handler: (username: string) => Promise<Response>
): Promise<Response> {
  const session = await requireAdminSessionInfo(request, env);
  const response = await handler(session.username);

  if (!response.ok) {
    return response;
  }

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

async function handleAdminSession(request: Request, env: Env, username: string): Promise<Response> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const baseUrl = getPublicBaseUrl(request, env);

  return jsonResponse({
    ok: true,
    username,
    max_file_bytes: maxFileBytes,
    multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
    base_url: baseUrl,
    config: {
      files_db: Boolean(env.FILES_DB),
      telegram_bot_token: hasEnvValue(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: hasEnvValue(env.TELEGRAM_STORAGE_CHAT_ID),
      link_signing_secret: hasEnvValue(env.LINK_SIGNING_SECRET),
      admin_username: hasEnvValue(env.ADMIN_USERNAME),
      admin_password: hasEnvValue(env.ADMIN_PASSWORD),
      admin_session_secret: hasEnvValue(env.ADMIN_SESSION_SECRET)
    },
    config_values: {
      files_db: env.FILES_DB ? "已绑定" : "未绑定",
      telegram_bot_token: maskSecret(env.TELEGRAM_BOT_TOKEN),
      telegram_storage_chat_id: env.TELEGRAM_STORAGE_CHAT_ID?.trim() || "未配置",
      link_signing_secret: maskSecret(env.LINK_SIGNING_SECRET),
      admin_username: env.ADMIN_USERNAME?.trim() || "未配置",
      admin_password: maskSecret(env.ADMIN_PASSWORD),
      admin_session_secret: env.ADMIN_SESSION_SECRET?.trim()
        ? maskSecret(env.ADMIN_SESSION_SECRET)
        : "未单独配置，使用签名密钥",
      public_base_url: baseUrl,
      max_file_bytes: String(maxFileBytes),
      max_multipart_file_bytes: String(MAX_TELEGRAM_MULTIPART_BYTES),
      direct_access_max_bytes: String(DIRECT_MULTIPART_ACCESS_MAX_BYTES)
    }
  });
}

async function handleAdminFiles(request: Request, env: Env, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/files") {
    const page = parsePositiveInteger(url.searchParams.get("page"), 1, 1, 100000);
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 24, 1, 100);
    const type = normalizeFileTypeFilter(url.searchParams.get("type"));
    const createdFrom = normalizeDateTimeParam(url.searchParams.get("created_from"), "created_from");
    const createdTo = normalizeDateTimeParam(url.searchParams.get("created_to"), "created_to");
    const directoryPath = normalizeDirectoryPath(url.searchParams.get("dir") || "/");
    const currentDirectory = await requireReadableDirectory(db, directoryPath);
    const normalizedQuery = url.searchParams.get("q") || "";
    const result = await listFileRecords({
      db,
      query: normalizedQuery,
      directoryPath,
      ...(type ? { type } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
      page,
      limit
    });
    const [directories, globalStats] = await Promise.all([
      listDirectoryChildren(db, directoryPath),
      getGlobalFileUsageStats(db)
    ]);
    const directoryStats = await getDirectoryUsageStats(db, directories);
    const baseUrl = getPublicBaseUrl(request, env);
    const files = result.files.map((file) => serializeFileRecord(file, baseUrl));

    return jsonResponse({
      ok: true,
      current_directory: serializeCurrentDirectory(currentDirectory, directoryPath),
      directories: directories.map((directory) => serializeDirectoryRecord(directory, directoryStats.get(directory.path))),
      search_scope: "current",
      files,
      pagination: {
        page,
        limit,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / limit))
      },
      global_stats: globalStats,
      max_file_bytes: parseMaxFileBytes(env.MAX_FILE_BYTES),
      multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
      max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
      direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
      direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/files") {
    const { file: formFile, remark, directoryPath } = await readUploadInput(request, env);
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await uploadAndRecordFile({
      request,
      env,
      file: formFile,
      db,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  if (request.method === "PATCH" && url.pathname === "/api/admin/files/move") {
    const body = await readJsonObject(request);
    const fileIds = normalizeFileIdList(body.file_ids);
    const directoryPath = await resolveMoveTargetDirectory(db, body);
    const moved = await moveFileRecords({
      db,
      ids: fileIds,
      directoryPath
    });

    return jsonResponse({ ok: true, moved, directory_path: directoryPath });
  }

  const updateMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PATCH" && updateMatch?.[1]) {
    const id = decodeURIComponent(updateMatch[1]);
    const existing = await getFileRecord(db, id);

    if (!existing) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    const body = await readJsonObject(request);
    const hasFileName = Object.prototype.hasOwnProperty.call(body, "file_name");
    const hasRemark = Object.prototype.hasOwnProperty.call(body, "remark");

    if (!hasFileName && !hasRemark) {
      throw new AppError(400, "InvalidBody", "file_name or remark is required");
    }

    const nextFileName = hasFileName ? normalizeFileNameUpdate(body.file_name) : existing.file_name;
    const nextRemark = hasRemark ? normalizeRemarkUpdate(body.remark) : existing.remark;
    const nextFilePath = nextFileName === existing.file_name
      ? existing.file_path
      : await createFilePathForRecord(existing, nextFileName, env);
    const updated = await updateFileRecordMetadata({
      db,
      id,
      fileName: nextFileName,
      remark: nextRemark,
      filePath: nextFilePath
    });

    if (!updated) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({
      ok: true,
      file: serializeFileRecord(updated, getPublicBaseUrl(request, env))
    });
  }

  const deleteMatch = /^\/api\/admin\/files\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deleteMatch?.[1]) {
    const deleted = await softDeleteFileRecord(db, decodeURIComponent(deleteMatch[1]), new Date().toISOString());

    if (!deleted) {
      throw new AppError(404, "NotFound", "File record not found");
    }

    return jsonResponse({ ok: true });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin file route not found"));
}

async function handleAdminDirectories(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/admin/directories") {
    const flat = url.searchParams.get("flat") === "1" || url.searchParams.get("flat") === "true";
    const parentPath = normalizeDirectoryPath(url.searchParams.get("parent_path") || "/");
    if (!flat) {
      await requireReadableDirectory(db, parentPath);
    }
    const directories = flat
      ? await listAllDirectoryRecords(db)
      : await listDirectoryChildren(db, parentPath);

    return jsonResponse({
      ok: true,
      directories: directories.map((directory) => serializeDirectoryRecord(directory))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/directories") {
    const body = await readJsonObject(request);
    const parentPath = normalizeDirectoryPath(body.parent_path ?? "/");
    const name = normalizeDirectoryName(body.name);
    const record = await insertDirectoryRecord({
      db,
      parentPath,
      name,
      createdAt: new Date().toISOString()
    });

    return jsonResponse({ ok: true, directory: serializeDirectoryRecord(record) }, 201);
  }

  const match = /^\/api\/admin\/directories\/([^/]+)$/.exec(url.pathname);
  const moveMatch = /^\/api\/admin\/directories\/([^/]+)\/move$/.exec(url.pathname);
  if (request.method === "PATCH" && moveMatch?.[1]) {
    const body = await readJsonObject(request);
    const parentPath = normalizeDirectoryPath(body.parent_path ?? "/");
    const result = await moveDirectoryTree({
      db,
      id: decodeURIComponent(moveMatch[1]),
      parentPath
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      directory: serializeDirectoryRecord(result.directory),
      moved_directories: result.movedDirectories,
      moved_files: result.movedFiles
    });
  }

  if (request.method === "PATCH" && match?.[1]) {
    const body = await readJsonObject(request);
    const name = normalizeDirectoryName(body.name);
    const result = await renameDirectoryTree({
      db,
      id: decodeURIComponent(match[1]),
      name
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      directory: serializeDirectoryRecord(result.directory),
      renamed_directories: result.renamedDirectories,
      updated_files: result.updatedFiles
    });
  }

  if (request.method === "DELETE" && match?.[1]) {
    const result = await softDeleteDirectoryTree({
      db,
      id: decodeURIComponent(match[1]),
      deletedAt: new Date().toISOString()
    });

    if (!result) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }

    return jsonResponse({
      ok: true,
      deleted_directories: result.deletedDirectories,
      deleted_files: result.deletedFiles,
      directory: serializeDirectoryRecord(result.directory)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin directory route not found"));
}

async function handleAdminEntries(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "PATCH" && url.pathname === "/api/admin/entries/move") {
    const body = await readJsonObject(request);
    const fileIds = normalizeOptionalIdList(body.file_ids, "file_ids");
    const directoryIds = normalizeOptionalIdList(body.directory_ids, "directory_ids");
    requireEntrySelection(fileIds, directoryIds);

    const directoriesToMove = await requireDirectoryRecords(db, directoryIds);
    await requireFileRecords(db, fileIds);
    validateEntryMoveParent(directoriesToMove, moveTargetParentPath(body));
    const directoryPath = await resolveMoveTargetDirectory(db, body);
    await validateEntryMoveTarget(db, directoriesToMove, directoryPath);

    let movedDirectories = 0;
    let movedFiles = 0;

    for (const directory of directoriesToMove) {
      const result = await moveDirectoryTree({
        db,
        id: directory.id,
        parentPath: directoryPath
      });

      if (!result) {
        throw new AppError(404, "DirectoryNotFound", "Directory not found");
      }

      movedDirectories += result.movedDirectories;
      movedFiles += result.movedFiles;
    }

    movedFiles += await moveFileRecords({
      db,
      ids: fileIds,
      directoryPath
    });

    return jsonResponse({
      ok: true,
      moved: movedDirectories + movedFiles,
      moved_directories: movedDirectories,
      moved_files: movedFiles,
      directory_path: directoryPath
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/entries/delete") {
    const body = await readJsonObject(request);
    const fileIds = normalizeOptionalIdList(body.file_ids, "file_ids");
    const directoryIds = normalizeOptionalIdList(body.directory_ids, "directory_ids");
    requireEntrySelection(fileIds, directoryIds);
    await requireFileRecords(db, fileIds);
    await requireDirectoryRecords(db, directoryIds);

    const deletedAt = new Date().toISOString();
    let deletedDirectories = 0;
    let deletedFiles = 0;

    for (const fileId of fileIds) {
      const deleted = await softDeleteFileRecord(db, fileId, deletedAt);
      if (!deleted) {
        throw new AppError(404, "NotFound", "File record not found");
      }
      deletedFiles += 1;
    }

    for (const directoryId of directoryIds) {
      const result = await softDeleteDirectoryTree({
        db,
        id: directoryId,
        deletedAt
      });

      if (!result) {
        throw new AppError(404, "DirectoryNotFound", "Directory not found");
      }

      deletedDirectories += result.deletedDirectories;
      deletedFiles += result.deletedFiles;
    }

    return jsonResponse({
      ok: true,
      deleted_directories: deletedDirectories,
      deleted_files: deletedFiles
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin entry route not found"));
}

async function handleAdminMultipartUploads(request: Request, env: Env, username: string): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/init") {
    const body = await readJsonObject(request);
    const fileName = sanitizeFileName(stringField(body.file_name, "file_name"));
    const mimeType = normalizeMimeTypeField(body.mime_type);
    const size = positiveIntegerField(body.size, "size");
    const remark = normalizeRemark(body.remark);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);
    const result = await createMultipartUpload({
      db,
      sourceKind: "local",
      fileName,
      mimeType,
      size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      upload: serializeMultipartInit(result)
    }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/uploads/url/init") {
    const body = await readJsonObject(request);
    const sourceUrl = normalizeSourceUrl(body.url);
    const remark = normalizeRemark(body.remark);
    const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
    const directory = await ensureWritableDirectory(db, directoryPath);

    if (!sourceUrl) {
      throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
    }

    const probe = await probeRemoteSourceForMultipart(sourceUrl, parseMaxFileBytes(env.MAX_FILE_BYTES));

    if (probe.mode === "single") {
      return jsonResponse({
        ok: true,
        mode: "single",
        max_file_bytes: parseMaxFileBytes(env.MAX_FILE_BYTES),
        max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
        multipart_chunk_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
        direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
        direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES,
        directory_path: directoryPath
      });
    }

    const result = await createMultipartUpload({
      db,
      sourceKind: "url",
      sourceUrl: sourceUrl.toString(),
      fileName: probe.fileName,
      mimeType: probe.mimeType,
      size: probe.size,
      uploadedBy: username,
      directoryPath,
      directoryId: directory?.id ?? null,
      ...(remark ? { remark } : {})
    });

    return jsonResponse({
      ok: true,
      mode: "multipart",
      upload: serializeMultipartInit(result)
    }, 201);
  }

  const chunkMatch = /^\/api\/admin\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch?.[1] && chunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(chunkMatch[1]), "local");
    const chunkIndex = normalizeChunkIndex(chunkMatch[2], upload);
    const formData = await request.formData();
    const chunk = formData.get("chunk");

    if (!(chunk instanceof File)) {
      throw new AppError(400, "MissingChunk", "Multipart field 'chunk' is required");
    }

    const expectedSize = expectedChunkSize(upload, chunkIndex);
    validateChunkFile(chunk, expectedSize);
    const record = await uploadChunkToTelegram({
      env,
      upload,
      chunk,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const urlChunkMatch = /^\/api\/admin\/uploads\/([^/]+)\/url-chunks\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && urlChunkMatch?.[1] && urlChunkMatch?.[2]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(urlChunkMatch[1]), "url");
    const chunkIndex = normalizeChunkIndex(urlChunkMatch[2], upload);
    const chunk = await downloadRemoteChunk(upload, chunkIndex);
    const record = await uploadChunkToTelegram({
      env,
      upload,
      chunk,
      chunkIndex
    });

    await upsertFileChunkRecord(db, record);
    return jsonResponse({
      ok: true,
      chunk: serializeChunk(record),
      uploaded_chunks: (await listFileChunkRecords(db, upload.id)).length
    });
  }

  const completeMatch = /^\/api\/admin\/uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && completeMatch?.[1]) {
    const upload = await requireMultipartUpload(db, decodeURIComponent(completeMatch[1]));
    const result = await completeMultipartUpload({
      request,
      env,
      db,
      upload
    });

    return jsonResponse({
      ok: true,
      file: serializeUploadedFileResult(result, username)
    });
  }

  return errorResponse(new AppError(404, "NotFound", "Admin multipart upload route not found"));
}

async function handleAdminApiKeys(request: Request, env: Env): Promise<Response> {
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

async function readUploadInput(request: Request, env: Env): Promise<{ file: File; remark?: string; directoryPath: string }> {
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
  const remark = normalizeRemark(formData.get("remark"));
  const directoryPath = normalizeDirectoryPath(formData.get("directory_path") ?? formData.get("dir") ?? "/");

  if (formFile instanceof File) {
    validateUploadFileSize(formFile, maxFileBytes);

    return {
      file: formFile,
      directoryPath,
      ...(remark ? { remark } : {})
    };
  }

  const sourceUrl = normalizeSourceUrl(formData.get("url"));
  if (sourceUrl) {
    const file = await downloadFileFromUrl({
      sourceUrl,
      env,
      maxFileBytes
    });

    return {
      file,
      directoryPath,
      ...(remark ? { remark } : {})
    };
  }

  throw new AppError(400, "MissingFile", "Multipart field 'file' is required");
}

async function readUrlUploadJson(request: Request, env: Env): Promise<{ file: File; remark?: string; directoryPath: string }> {
  const maxFileBytes = parseMaxFileBytes(env.MAX_FILE_BYTES);
  const body = await readJsonObject(request);
  const sourceUrl = normalizeSourceUrl(body.url);

  if (!sourceUrl) {
    throw new AppError(400, "MissingUrl", "JSON field 'url' is required");
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? body.dir ?? "/");
  const file = await downloadFileFromUrl({
    sourceUrl,
    env,
    maxFileBytes
  });
  const remark = normalizeRemark(body.remark);

  return {
    file,
    directoryPath,
    ...(remark ? { remark } : {})
  };
}

function validateUploadFileSize(file: File, maxFileBytes: number): void {
  if (file.size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (file.size > maxFileBytes) {
    throw fileTooLargeError(maxFileBytes, file.size);
  }
}

function fileTooLargeError(
  maxFileBytes: number,
  actualFileBytes: number,
  extraDetails: Record<string, unknown> = {}
): AppError {
  const maxFileSize = formatHumanFileSize(maxFileBytes);
  const actualFileSize = formatHumanFileSize(actualFileBytes);

  return new AppError(413, "FileTooLarge", `文件大小不能超过 ${maxFileSize}（当前 ${actualFileSize}）`, {
    max_file_bytes: maxFileBytes,
    actual_file_bytes: actualFileBytes,
    max_file_size: maxFileSize,
    actual_file_size: actualFileSize,
    ...extraDetails
  });
}

function formatHumanFileSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0B";
  }

  const units = [
    { label: "T", bytes: 1024 ** 4 },
    { label: "G", bytes: 1024 ** 3 },
    { label: "MB", bytes: 1024 ** 2 },
    { label: "KB", bytes: 1024 },
    { label: "B", bytes: 1 }
  ];
  let remaining = Math.floor(value);
  const parts: string[] = [];

  for (const unit of units) {
    const count = Math.floor(remaining / unit.bytes);
    if (count <= 0) {
      continue;
    }

    parts.push(`${count}${unit.label}`);
    remaining -= count * unit.bytes;
  }

  return parts.join("") || "0B";
}

function normalizeSourceUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 4096) {
    throw new AppError(400, "InvalidUrl", "URL is too long");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new AppError(400, "InvalidUrl", "URL must be absolute");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "InvalidUrl", "URL protocol must be http or https");
  }

  return url;
}

async function downloadFileFromUrl(params: {
  sourceUrl: URL;
  env: Env;
  maxFileBytes: number;
}): Promise<File> {
  const signedFile = await downloadSignedFileUrl(params);
  if (signedFile) {
    return signedFile;
  }

  let response: Response;

  try {
    response = await fetch(params.sourceUrl.toString(), {
      redirect: "follow",
      headers: {
        Accept: "*/*"
      }
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
  const fileName = ensureFileExtension(sanitizeFileName(initialFileName), detectedMimeType);
  const file = new File([bytes], fileName, { type: detectedMimeType });

  validateUploadFileSize(file, params.maxFileBytes);

  return file;
}

async function downloadSignedFileUrl(params: {
  sourceUrl: URL;
  env: Env;
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
  const telegramFileUrl = await getTelegramFileUrl({ botToken, fileId: payload.file_id });
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

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function pickRemoteMimeHint(contentType: string | null, fileName: string): string | undefined {
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  const nameMimeType = mimeTypeForFileName(fileName);

  if (normalizedContentType && normalizedContentType !== "application/octet-stream") {
    return normalizedContentType;
  }

  return nameMimeType ?? normalizedContentType;
}

function inferRemoteFileName(sourceUrl: URL, headers: Headers): string {
  const contentDispositionName = parseContentDispositionFileName(headers.get("Content-Disposition"));
  if (contentDispositionName) {
    return contentDispositionName;
  }

  const rawSegment = sourceUrl.pathname.split("/").filter(Boolean).at(-1);
  if (!rawSegment) {
    return "download";
  }

  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return rawSegment;
  }
}

function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const encodedMatch = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value);
  const encodedValue = encodedMatch?.[1]?.trim();
  if (encodedValue) {
    const decoded = decodeContentDispositionFileName(encodedValue);
    if (decoded) {
      return decoded;
    }
  }

  const plainMatch = /(?:^|;)\s*filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  const plainValue = plainMatch?.[2] ?? plainMatch?.[1];
  const normalized = plainValue?.trim().replace(/^"|"$/g, "");

  return normalized || undefined;
}

function decodeContentDispositionFileName(value: string): string | undefined {
  const normalized = value.replace(/^"|"$/g, "");
  const encodedPart = normalized.includes("''") ? normalized.split("''").slice(1).join("''") : normalized;

  try {
    return decodeURIComponent(encodedPart);
  } catch {
    return encodedPart || undefined;
  }
}

function ensureFileExtension(fileName: string, mimeType: string): string {
  if (/\.[a-z0-9]{1,12}$/i.test(fileName)) {
    return fileName;
  }

  const extension = extensionForMimeType(mimeType);

  return extension ? `${fileName}.${extension}` : fileName;
}

async function createMultipartUpload(params: {
  db: D1Database;
  sourceKind: "local" | "url";
  sourceUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath: string;
}): Promise<MultipartInitResult> {
  validateMultipartFileSize(params.size);
  const chunkCount = Math.ceil(params.size / TELEGRAM_CHUNK_SIZE_BYTES);
  const createdAt = new Date().toISOString();
  const record = await insertMultipartUploadRecord(params.db, {
    id: crypto.randomUUID(),
    sourceKind: params.sourceKind,
    ...(params.sourceUrl ? { sourceUrl: params.sourceUrl } : {}),
    fileName: params.fileName,
    mimeType: params.mimeType,
    size: params.size,
    chunkSize: TELEGRAM_CHUNK_SIZE_BYTES,
    chunkCount,
    uploadedBy: params.uploadedBy,
    directoryId: params.directoryId ?? null,
    directoryPath: params.directoryPath,
    ...(params.remark ? { remark: params.remark } : {}),
    createdAt
  });

  return {
    id: record.id,
    fileName: record.file_name,
    mimeType: record.mime_type,
    size: record.size,
    chunkSize: record.chunk_size,
    chunkCount: record.chunk_count,
    directoryPath: record.directory_path ?? "/"
  };
}

function validateMultipartFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new AppError(400, "EmptyFile", "File must not be empty");
  }

  if (size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size, {
      chunk_size_bytes: TELEGRAM_CHUNK_SIZE_BYTES,
      chunk_size: formatHumanFileSize(TELEGRAM_CHUNK_SIZE_BYTES),
      max_chunks: MAX_TELEGRAM_MULTIPART_CHUNKS
    });
  }
}

async function probeRemoteSourceForMultipart(
  sourceUrl: URL,
  singleMaxFileBytes: number
): Promise<
  | { mode: "single" }
  | { mode: "multipart"; fileName: string; mimeType: string; size: number }
> {
  const head = await fetchRemoteHead(sourceUrl);
  let size = parseContentLength(head?.headers.get("Content-Length") ?? null);
  const initialFileName = inferRemoteFileName(sourceUrl, head?.headers ?? new Headers());
  const remoteMimeHint = pickRemoteMimeHint(head?.headers.get("Content-Type") ?? null, initialFileName);

  if (size !== undefined && size <= singleMaxFileBytes) {
    return { mode: "single" };
  }

  if (size !== undefined && size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size);
  }

  const rangeProbe = await fetchRemoteRange(sourceUrl, 0, 0);
  if (rangeProbe.status !== 206) {
    throw new AppError(400, "RangeNotSupported", "Source URL must support Range requests for large URL uploads");
  }

  const contentRange = parseContentRange(rangeProbe.headers.get("Content-Range"));
  size = contentRange?.size ?? size;

  if (size === undefined) {
    throw new AppError(400, "UnknownFileSize", "Source URL must expose Content-Length or Content-Range");
  }

  if (size <= singleMaxFileBytes) {
    return { mode: "single" };
  }

  if (size > MAX_TELEGRAM_MULTIPART_BYTES) {
    throw fileTooLargeError(MAX_TELEGRAM_MULTIPART_BYTES, size);
  }

  const detectedMimeType = resolveStoredMimeType({
    bytes: new ArrayBuffer(0),
    fileType: remoteMimeHint
  });
  const fileName = ensureFileExtension(sanitizeFileName(initialFileName), detectedMimeType);

  return {
    mode: "multipart",
    fileName,
    mimeType: detectedMimeType,
    size
  };
}

async function fetchRemoteHead(sourceUrl: URL): Promise<Response | undefined> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      method: "HEAD",
      redirect: "follow",
      headers: { Accept: "*/*" }
    });

    return response.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

async function fetchRemoteRange(sourceUrl: URL, start: number, end: number): Promise<Response> {
  try {
    const response = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: {
        Accept: "*/*",
        Range: `bytes=${start}-${end}`
      }
    });

    if (!response.ok && response.status !== 206) {
      throw new AppError(
        response.status >= 500 ? 502 : 400,
        "UrlFetchFailed",
        `Source URL returned ${response.status}`,
        { source_status: response.status }
      );
    }

    return response;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(502, "UrlFetchFailed", "Failed to fetch source URL");
  }
}

async function requireMultipartUpload(
  db: D1Database,
  id: string,
  sourceKind?: "local" | "url"
): Promise<MultipartUploadRecord> {
  const upload = await getMultipartUploadRecord(db, id);

  if (!upload) {
    throw new AppError(404, "UploadNotFound", "Multipart upload session not found");
  }

  if (sourceKind && upload.source_kind !== sourceKind) {
    throw new AppError(400, "InvalidUploadSource", `Upload session expects ${upload.source_kind} chunks`);
  }

  return upload;
}

function normalizeChunkIndex(value: string, upload: MultipartUploadRecord): number {
  const index = Number(value);

  if (!Number.isSafeInteger(index) || index < 0 || index >= upload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }

  return index;
}

function expectedChunkSize(upload: MultipartUploadRecord, chunkIndex: number): number {
  if (chunkIndex === upload.chunk_count - 1) {
    return upload.size - upload.chunk_size * chunkIndex;
  }

  return upload.chunk_size;
}

function validateChunkFile(chunk: Blob, expectedSize: number): void {
  if (chunk.size !== expectedSize) {
    throw new AppError(400, "InvalidChunkSize", `分片大小必须为 ${formatHumanFileSize(expectedSize)}（当前 ${formatHumanFileSize(chunk.size)}）`, {
      expected_chunk_bytes: expectedSize,
      actual_chunk_bytes: chunk.size,
      expected_chunk_size: formatHumanFileSize(expectedSize),
      actual_chunk_size: formatHumanFileSize(chunk.size)
    });
  }
}

async function downloadRemoteChunk(upload: MultipartUploadRecord, chunkIndex: number): Promise<Blob> {
  if (!upload.source_url) {
    throw new AppError(400, "InvalidUploadSource", "URL upload session is missing source URL");
  }

  const sourceUrl = new URL(upload.source_url);
  const start = chunkIndex * upload.chunk_size;
  const end = start + expectedChunkSize(upload, chunkIndex) - 1;
  const response = await fetchRemoteRange(sourceUrl, start, end);

  if (response.status !== 206) {
    throw new AppError(400, "RangeNotSupported", "Source URL must return 206 for chunk Range requests");
  }

  let chunk: Blob;
  try {
    chunk = await response.blob();
  } catch {
    throw new AppError(502, "UrlFetchFailed", "Failed to read source URL response");
  }

  validateChunkFile(chunk, expectedChunkSize(upload, chunkIndex));
  return chunk;
}

async function uploadChunkToTelegram(params: {
  env: Env;
  upload: MultipartUploadRecord;
  chunk: Blob;
  chunkIndex: number;
}) {
  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv(params.env, "TELEGRAM_STORAGE_CHAT_ID");
  const fileName = chunkFileName(params.upload, params.chunkIndex);
  const telegramDocument = await uploadDocumentToTelegram({
    botToken,
    chatId,
    file: params.chunk,
    fileName
  });

  return {
    fileId: params.upload.id,
    chunkIndex: params.chunkIndex,
    size: telegramDocument.file_size ?? params.chunk.size,
    md5: chunkDigest(params.upload, params.chunkIndex, telegramDocument.file_unique_id),
    telegramFileId: telegramDocument.file_id,
    ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
    createdAt: new Date().toISOString()
  };
}

function chunkFileName(upload: MultipartUploadRecord, chunkIndex: number): string {
  const padded = String(chunkIndex + 1).padStart(String(upload.chunk_count).length, "0");
  return `${upload.file_name}.part-${padded}-of-${upload.chunk_count}`;
}

function chunkDigest(upload: MultipartUploadRecord, chunkIndex: number, telegramFileUniqueId: string | undefined): string {
  return telegramFileUniqueId
    ? `tg:${telegramFileUniqueId}`
    : `chunk:${chunkIndex}:${expectedChunkSize(upload, chunkIndex)}`;
}

async function completeMultipartUpload(params: {
  request: Request;
  env: Env;
  db: D1Database;
  upload: MultipartUploadRecord;
}): Promise<UploadResult> {
  const chunks = await listFileChunkRecords(params.db, params.upload.id);
  validateCompleteChunks(params.upload, chunks);

  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const createdAt = new Date().toISOString();
  const token = await createSignedToken(
    {
      v: 2,
      file_record_id: params.upload.id,
      name: params.upload.file_name,
      mime_type: params.upload.mime_type,
      size: params.upload.size,
      chunk_size: params.upload.chunk_size,
      chunk_count: params.upload.chunk_count,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );
  const baseUrl = getPublicBaseUrl(params.request, params.env);
  const publicName = encodeURIComponent(params.upload.file_name);
  const filePath = `/f/${token}/${publicName}`;
  const publicUrl = `${baseUrl}${filePath}`;
  const md5 = multipartDigest(chunks);

  await insertFileRecord(params.db, {
    id: params.upload.id,
    fileName: params.upload.file_name,
    mimeType: params.upload.mime_type,
    size: params.upload.size,
    md5,
    telegramFileId: `multipart:${params.upload.id}`,
    filePath,
    createdAt,
    storageBackend: "telegram_multipart",
    chunkSize: params.upload.chunk_size,
    chunkCount: params.upload.chunk_count,
    directoryId: params.upload.directory_id ?? null,
    directoryPath: params.upload.directory_path ?? "/",
    ...(params.upload.remark ? { remark: params.upload.remark } : {}),
    ...(params.upload.uploaded_by ? { uploadedBy: params.upload.uploaded_by } : {})
  });
  await completeMultipartUploadRecord(params.db, params.upload.id, createdAt);

  return {
    id: params.upload.id,
    name: params.upload.file_name,
    size: params.upload.size,
    mimeType: params.upload.mime_type,
    md5,
    filePath,
    publicUrl,
    telegramFileId: `multipart:${params.upload.id}`,
    ...(params.upload.remark ? { remark: params.upload.remark } : {}),
    createdAt,
    directoryId: params.upload.directory_id ?? null,
    directoryPath: params.upload.directory_path ?? "/",
    storageBackend: "telegram_multipart",
    chunkSize: params.upload.chunk_size,
    chunkCount: params.upload.chunk_count
  };
}

function validateCompleteChunks(upload: MultipartUploadRecord, chunks: FileChunkRecord[]): void {
  if (chunks.length !== upload.chunk_count) {
    throw new AppError(409, "UploadIncomplete", "Not all chunks have been uploaded", {
      expected_chunks: upload.chunk_count,
      actual_chunks: chunks.length
    });
  }

  for (let index = 0; index < upload.chunk_count; index += 1) {
    const chunk = chunks[index];
    const expectedSize = expectedChunkSize(upload, index);
    if (!chunk || chunk.chunk_index !== index || chunk.size !== expectedSize) {
      throw new AppError(409, "UploadIncomplete", "Uploaded chunks are incomplete or inconsistent", {
        chunk_index: index,
        expected_chunk_bytes: expectedSize,
        actual_chunk_bytes: chunk?.size
      });
    }
  }
}

function multipartDigest(chunks: FileChunkRecord[]): string {
  return `multipart:${chunks.map((chunk) => chunk.md5).join(":")}`;
}

async function uploadAndRecordFile(params: {
  request: Request;
  env: Env;
  file: File;
  db?: D1Database;
  uploadedBy?: string;
  remark?: string;
  directoryId?: string | null;
  directoryPath?: string;
}): Promise<UploadResult> {
  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv(params.env, "TELEGRAM_STORAGE_CHAT_ID");
  const signingSecret = requireEnv(params.env, "LINK_SIGNING_SECRET");
  const fileName = sanitizeFileName(params.file.name);
  const fileBytes = await params.file.arrayBuffer();
  const md5 = md5Hex(fileBytes);
  const uploadMimeType = resolveStoredMimeType({
    bytes: fileBytes,
    fileType: params.file.type
  });
  const uploadFile = uploadMimeType === params.file.type
    ? params.file
    : new File([fileBytes], fileName, { type: uploadMimeType });

  const telegramDocument = await uploadDocumentToTelegram({
    botToken,
    chatId,
    file: uploadFile,
    fileName
  });
  const storedName = telegramDocument.file_name ? sanitizeFileName(telegramDocument.file_name) : fileName;
  const mimeType = resolveStoredMimeType({
    bytes: fileBytes,
    fileType: params.file.type,
    telegramMimeType: telegramDocument.mime_type
  });
  const fileSize = telegramDocument.file_size ?? params.file.size;
  const createdAt = new Date().toISOString();
  const token = await createSignedToken(
    {
      v: 1,
      file_id: telegramDocument.file_id,
      name: storedName,
      mime_type: mimeType,
      size: fileSize,
      iat: Math.floor(Date.now() / 1000)
    },
    signingSecret
  );

  const id = crypto.randomUUID();
  const baseUrl = getPublicBaseUrl(params.request, params.env);
  const publicName = encodeURIComponent(storedName);
  const filePath = `/f/${token}/${publicName}`;
  const publicUrl = `${baseUrl}${filePath}`;

  if (params.db) {
    await insertFileRecord(params.db, {
      id,
      fileName: storedName,
      mimeType,
      size: fileSize,
      md5,
      telegramFileId: telegramDocument.file_id,
      filePath,
      createdAt,
      directoryId: params.directoryId ?? null,
      directoryPath: params.directoryPath ?? "/",
      ...(params.remark ? { remark: params.remark } : {}),
      ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
      ...(params.uploadedBy ? { uploadedBy: params.uploadedBy } : {})
    });
  }

  return {
    id,
    name: storedName,
    size: fileSize,
    mimeType,
    md5,
    filePath,
    publicUrl,
    telegramFileId: telegramDocument.file_id,
    ...(telegramDocument.file_unique_id ? { telegramFileUniqueId: telegramDocument.file_unique_id } : {}),
    ...(params.remark ? { remark: params.remark } : {}),
    createdAt,
    directoryId: params.directoryId ?? null,
    directoryPath: params.directoryPath ?? "/",
    storageBackend: "telegram_single",
    chunkSize: null,
    chunkCount: null
  };
}

async function createFilePathForRecord(record: FileRecord, fileName: string, env: Env): Promise<string> {
  const signingSecret = requireEnv(env, "LINK_SIGNING_SECRET");
  const iat = Math.floor(Date.now() / 1000);
  const isMultipart = record.storage_backend === "telegram_multipart";
  const token = isMultipart
    ? await createSignedToken(
        {
          v: 2,
          file_record_id: record.id,
          name: fileName,
          mime_type: record.mime_type,
          size: record.size,
          chunk_size: requirePositiveRecordInteger(record.chunk_size, "chunk_size"),
          chunk_count: requirePositiveRecordInteger(record.chunk_count, "chunk_count"),
          iat
        },
        signingSecret
      )
    : await createSignedToken(
        {
          v: 1,
          file_id: record.telegram_file_id,
          name: fileName,
          mime_type: record.mime_type,
          size: record.size,
          iat
        },
        signingSecret
      );

  return `/f/${token}/${encodeURIComponent(fileName)}`;
}

function requirePositiveRecordInteger(value: number | null | undefined, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new AppError(500, "InvalidFileRecord", `File record is missing ${fieldName}`);
  }

  return value as number;
}

async function handleFileAccess(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const chunkAccess = extractMultipartChunkAccess(url.pathname);
  const token = chunkAccess?.token ?? extractFileToken(url.pathname);
  const payload = await verifySignedToken(token, requireEnv(env, "LINK_SIGNING_SECRET"));
  const rangeHeader = request.headers.get("Range");
  const forceDownload = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

  if (chunkAccess) {
    return handleMultipartChunkAccess({
      env,
      payload,
      chunkIndex: chunkAccess.chunkIndex
    });
  }

  if (payload.v === 2) {
    return handleMultipartFileAccess({
      env,
      payload,
      rangeHeader,
      forceDownload
    });
  }

  const botToken = requireEnv(env, "TELEGRAM_BOT_TOKEN");
  const telegramFileUrl = await getTelegramFileUrl({ botToken, fileId: payload.file_id });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader
  });
  const headers = withSecurityHeaders();

  headers.set("Content-Type", payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set(
    "Content-Disposition",
    forceDownload ? contentDispositionAttachment(payload.name) : contentDispositionInline(payload.name)
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  copyHeader(telegramResponse.headers, headers, "Content-Length");
  copyHeader(telegramResponse.headers, headers, "Content-Range");
  copyHeader(telegramResponse.headers, headers, "Accept-Ranges");

  return new Response(telegramResponse.body, {
    status: telegramResponse.status,
    statusText: telegramResponse.statusText,
    headers
  });
}

async function handleMultipartChunkAccess(params: {
  env: Env;
  payload: Awaited<ReturnType<typeof verifySignedToken>>;
  chunkIndex: number;
}): Promise<Response> {
  if (params.payload.v !== 2) {
    throw new AppError(400, "NotMultipartFile", "Chunk download is only available for multipart files");
  }

  validatePayloadChunkIndex(params.payload, params.chunkIndex);

  const db = requireDb(params.env);
  const chunk = await getFileChunkRecord(db, params.payload.file_record_id, params.chunkIndex);
  const expectedSize = expectedPayloadChunkSize(params.payload, params.chunkIndex);

  if (!chunk || chunk.size !== expectedSize) {
    throw new AppError(404, "FileChunkNotFound", "Multipart file chunk was not found");
  }

  const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");
  const telegramFileUrl = await getTelegramFileUrl({ botToken, fileId: chunk.telegram_file_id });
  const telegramResponse = await fetchTelegramFile({
    fileUrl: telegramFileUrl,
    rangeHeader: null
  });

  if (!telegramResponse.body) {
    throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.payload.mime_type || telegramResponse.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(chunkDownloadFileName(params.payload, params.chunkIndex)));
  headers.set("Content-Length", String(chunk.size));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Chunk-Index", String(params.chunkIndex));
  headers.set("X-Chunk-Count", String(params.payload.chunk_count));
  headers.set("X-Chunk-Offset", String(params.chunkIndex * params.payload.chunk_size));

  return new Response(telegramResponse.body, {
    status: 200,
    headers
  });
}

async function handleMultipartFileAccess(params: {
  env: Env;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  rangeHeader: string | null;
  forceDownload: boolean;
}): Promise<Response> {
  if (!canDirectlyAccessMultipartPayload(params.payload)) {
    throw new AppError(
      403,
      "DirectAccessDisabled",
      "该文件分片数量过多，不提供完整文件访问链接，请在控制台使用加速下载",
      {
        chunk_count: params.payload.chunk_count,
        direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS
      }
    );
  }

  const db = requireDb(params.env);
  const chunks = await listFileChunkRecords(db, params.payload.file_record_id);

  validateTokenChunks(params.payload, chunks);
  const range = parseByteRange(params.rangeHeader, params.payload.size);
  if (!range) {
    return rangeNotSatisfiableResponse(params.payload.size);
  }

  const headers = withSecurityHeaders();
  headers.set("Content-Type", params.payload.mime_type);
  headers.set(
    "Content-Disposition",
    params.forceDownload
      ? contentDispositionAttachment(params.payload.name)
      : contentDispositionInline(params.payload.name)
  );
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range.end - range.start + 1));

  if (range.partial) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${params.payload.size}`);
  }

  return new Response(streamMultipartFile({
    env: params.env,
    payload: params.payload,
    chunks,
    range
  }), {
    status: range.partial ? 206 : 200,
    headers
  });
}

function validateTokenChunks(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunks: FileChunkRecord[]
): void {
  if (chunks.length !== payload.chunk_count) {
    throw new AppError(404, "FileChunksNotFound", "Multipart file chunks are incomplete");
  }

  for (let index = 0; index < payload.chunk_count; index += 1) {
    const chunk = chunks[index];
    const expectedSize = expectedPayloadChunkSize(payload, index);

    if (!chunk || chunk.chunk_index !== index || chunk.size !== expectedSize) {
      throw new AppError(404, "FileChunksNotFound", "Multipart file chunks are incomplete");
    }
  }
}

function validatePayloadChunkIndex(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= payload.chunk_count) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index is out of range");
  }
}

function expectedPayloadChunkSize(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): number {
  return chunkIndex === payload.chunk_count - 1
    ? payload.size - payload.chunk_size * chunkIndex
    : payload.chunk_size;
}

function chunkDownloadFileName(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>,
  chunkIndex: number
): string {
  const paddedIndex = String(chunkIndex + 1).padStart(String(payload.chunk_count).length, "0");
  return `${payload.name}.part-${paddedIndex}-of-${payload.chunk_count}`;
}

function streamMultipartFile(params: {
  env: Env;
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>;
  chunks: FileChunkRecord[];
  range: ParsedByteRange;
}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const botToken = requireEnv(params.env, "TELEGRAM_BOT_TOKEN");

        for (const chunk of params.chunks) {
          const chunkStart = chunk.chunk_index * params.payload.chunk_size;
          const chunkEnd = chunkStart + chunk.size - 1;
          const overlapStart = Math.max(params.range.start, chunkStart);
          const overlapEnd = Math.min(params.range.end, chunkEnd);

          if (overlapStart > overlapEnd) {
            continue;
          }

          const telegramFileUrl = await getTelegramFileUrl({ botToken, fileId: chunk.telegram_file_id });
          const telegramResponse = await fetchTelegramFile({
            fileUrl: telegramFileUrl,
            rangeHeader: `bytes=${overlapStart - chunkStart}-${overlapEnd - chunkStart}`
          });

          if (telegramResponse.status !== 206 && (overlapStart !== chunkStart || overlapEnd !== chunkEnd)) {
            throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file server ignored a partial Range request");
          }

          if (!telegramResponse.body) {
            throw new AppError(502, "TelegramFileDownloadFailed", "Telegram file response did not include a body");
          }

          const reader = telegramResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              controller.enqueue(value);
            }
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

function parseByteRange(rangeHeader: string | null, size: number): ParsedByteRange | null {
  if (!rangeHeader) {
    return { start: 0, end: size - 1, partial: false };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }

  let start: number;
  let end: number;

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      return null;
    }

    if (start >= size) {
      return null;
    }

    end = Math.min(end, size - 1);
  }

  return { start, end, partial: true };
}

function rangeNotSatisfiableResponse(size: number): Response {
  const headers = withSecurityHeaders();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes */${size}`);
  return new Response(null, { status: 416, headers });
}

async function requireUploadApiKey(request: Request, db: D1Database): Promise<void> {
  const authorization = request.headers.get("Authorization") || "";
  const [scheme, token, extra] = authorization.split(/\s+/);

  if (scheme !== "Bearer" || !token || extra !== undefined) {
    throw new AppError(401, "Unauthorized", "Missing or invalid bearer token");
  }

  const apiKey = await findActiveApiKeyRecord(db, token);

  if (!apiKey) {
    throw new AppError(401, "Unauthorized", "Missing or invalid bearer token");
  }

  await touchApiKeyRecord(db, apiKey.id, new Date().toISOString());
}

async function readLoginCredentials(request: Request): Promise<{ username: string; password: string; rememberMe: boolean }> {
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.toLowerCase().includes("application/json")) {
    const body = await request.json() as Partial<{ username: unknown; password: unknown; remember_me: unknown }>;

    return {
      username: typeof body.username === "string" ? body.username : "",
      password: typeof body.password === "string" ? body.password : "",
      rememberMe: body.remember_me !== false
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

function serializeFileRecord(file: FileRecord, baseUrl: string): Record<string, unknown> {
  const storageBackend = fileStorageBackend(file);
  const directAccess = canDirectlyAccessFileRecord(file);
  const url = directAccess ? `${baseUrl}${file.file_path}` : null;

  return {
    ...file,
    directory_id: file.directory_id ?? null,
    directory_path: file.directory_path ?? "/",
    storage_backend: storageBackend,
    chunk_size: storageBackend === "telegram_multipart" ? file.chunk_size ?? null : null,
    chunk_count: storageBackend === "telegram_multipart" ? file.chunk_count ?? null : null,
    direct_access: directAccess,
    download_strategy: downloadStrategy(storageBackend, directAccess),
    url,
    download_url: url ? appendDownloadParam(url) : null
  };
}

function serializeMultipartInit(result: MultipartInitResult): Record<string, unknown> {
  return {
    id: result.id,
    file_name: result.fileName,
    mime_type: result.mimeType,
    size: result.size,
    chunk_size: result.chunkSize,
    chunk_count: result.chunkCount,
    directory_path: result.directoryPath,
    max_multipart_file_bytes: MAX_TELEGRAM_MULTIPART_BYTES,
    direct_access: result.chunkCount <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_chunks: DIRECT_MULTIPART_ACCESS_MAX_CHUNKS,
    direct_access_max_bytes: DIRECT_MULTIPART_ACCESS_MAX_BYTES
  };
}

function serializeDirectoryRecord(record: DirectoryRecord, usage?: { file_count: number; total_size: number }): Record<string, unknown> {
  return {
    id: record.id,
    parent_id: record.parent_id,
    name: record.name,
    path: record.path,
    created_at: record.created_at,
    deleted_at: record.deleted_at,
    file_count: usage?.file_count ?? 0,
    total_size: usage?.total_size ?? 0
  };
}

function serializeCurrentDirectory(record: DirectoryRecord | null, path: string): Record<string, unknown> {
  if (path === "/") {
    return {
      id: null,
      parent_id: null,
      name: "/",
      path: "/",
      created_at: null,
      deleted_at: null
    };
  }

  if (!record) {
    return {
      id: null,
      parent_id: null,
      name: path.split("/").filter(Boolean).at(-1) ?? path,
      path,
      created_at: null,
      deleted_at: null
    };
  }

  return serializeDirectoryRecord(record);
}

function serializeChunk(record: Awaited<ReturnType<typeof uploadChunkToTelegram>>): Record<string, unknown> {
  return {
    chunk_index: record.chunkIndex,
    size: record.size,
    md5: record.md5,
    telegram_file_id: record.telegramFileId
  };
}

function serializeUploadedFileResult(result: UploadResult, username: string): Record<string, unknown> {
  const directAccess = canDirectlyAccessUploadResult(result);
  const url = directAccess ? result.publicUrl : null;

  return {
    id: result.id,
    file_name: result.name,
    mime_type: result.mimeType,
    size: result.size,
    md5: result.md5,
    telegram_file_id: result.telegramFileId,
    telegram_file_unique_id: result.telegramFileUniqueId ?? null,
    file_path: result.filePath,
    remark: result.remark ?? null,
    url,
    download_url: url ? appendDownloadParam(url) : null,
    uploaded_by: username,
    created_at: result.createdAt,
    directory_id: result.directoryId ?? null,
    directory_path: result.directoryPath,
    storage_backend: result.storageBackend,
    chunk_size: result.storageBackend === "telegram_multipart" ? result.chunkSize ?? null : null,
    chunk_count: result.storageBackend === "telegram_multipart" ? result.chunkCount ?? null : null,
    direct_access: directAccess,
    download_strategy: downloadStrategy(result.storageBackend, directAccess)
  };
}

function fileStorageBackend(file: FileRecord): "telegram_single" | "telegram_multipart" {
  if (file.storage_backend === "telegram_multipart" || file.telegram_file_id.startsWith("multipart:")) {
    return "telegram_multipart";
  }

  return "telegram_single";
}

function canDirectlyAccessFileRecord(file: FileRecord): boolean {
  const storageBackend = fileStorageBackend(file);

  if (storageBackend === "telegram_single") {
    return true;
  }

  return Number.isSafeInteger(file.chunk_count) &&
    Number(file.chunk_count) > 0 &&
    Number(file.chunk_count) <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
}

function canDirectlyAccessUploadResult(result: UploadResult): boolean {
  if (result.storageBackend === "telegram_single") {
    return true;
  }

  return Number.isSafeInteger(result.chunkCount) &&
    Number(result.chunkCount) > 0 &&
    Number(result.chunkCount) <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
}

function canDirectlyAccessMultipartPayload(
  payload: Extract<Awaited<ReturnType<typeof verifySignedToken>>, { v: 2 }>
): boolean {
  return payload.chunk_count <= DIRECT_MULTIPART_ACCESS_MAX_CHUNKS;
}

function downloadStrategy(
  storageBackend: "telegram_single" | "telegram_multipart",
  directAccess: boolean
): "direct" | "direct_or_accelerated" | "accelerated" {
  if (storageBackend === "telegram_single") {
    return "direct";
  }

  return directAccess ? "direct_or_accelerated" : "accelerated";
}

function serializeApiKeyRecord(record: ApiKeyRecord, includeKey: boolean): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    masked_key: maskApiKey(record.key),
    ...(includeKey ? { key: record.key } : {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
    last_used_at: record.last_used_at
  };
}

function maskApiKey(key: string): string {
  if (key.length <= 12) {
    return `${key.slice(0, 3)}••••${key.slice(-2)}`;
  }

  return `${key.slice(0, 8)}••••••••${key.slice(-4)}`;
}

function generateApiKey(): string {
  const left = crypto.randomUUID().replace(/-/g, "");
  const right = crypto.randomUUID().replace(/-/g, "");

  return `tgf_${left}${right.slice(0, 16)}`;
}

function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} is required`);
  }

  return value.trim();
}

function positiveIntegerField(value: unknown, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be a positive integer`);
  }

  return parsed;
}

function normalizeMimeTypeField(value: unknown): string {
  if (typeof value !== "string") {
    return "application/octet-stream";
  }

  const normalized = value.split(";")[0]?.trim().toLowerCase();
  return normalized || "application/octet-stream";
}

function parseContentRange(value: string | null): { start: number; end: number; size: number } | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    end < start ||
    size <= 0
  ) {
    return undefined;
  }

  return { start, end, size };
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AppError(400, "InvalidContentType", "Request must use application/json");
  }

  const body = await request.json();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(400, "InvalidBody", "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

function normalizeName(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", `${fieldName} is required`);
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 80) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be 1-80 characters`);
  }

  return normalized;
}

function normalizeFileNameUpdate(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "InvalidFileName", "File name must be 1-180 characters");
  }

  const normalized = sanitizeFileName(value);

  if (!normalized || normalized === "file" && value.trim().length === 0) {
    throw new AppError(400, "InvalidFileName", "File name must be 1-180 characters");
  }

  return normalized;
}

function normalizeDirectoryName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError(400, "InvalidDirectoryName", "Directory name is required");
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 80) {
    throw new AppError(400, "InvalidDirectoryName", "Directory name must be 1-80 characters");
  }

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AppError(400, "InvalidDirectoryName", "Directory name contains unsupported characters");
  }

  return normalized;
}

function normalizeDirectoryPath(value: unknown): string {
  if (typeof value !== "string") {
    return "/";
  }

  let normalized = value.trim();

  if (!normalized) {
    return "/";
  }

  if (normalized.length > 512) {
    throw new AppError(400, "InvalidDirectoryPath", "Directory path is too long");
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/g, "");
  }

  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    if (
      segment.length > 80 ||
      segment !== segment.trim() ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      throw new AppError(400, "InvalidDirectoryPath", "Directory path is invalid");
    }
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

async function requireReadableDirectory(db: D1Database, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const directory = await getDirectoryRecordByPath(db, path);
  if (!directory) {
    throw new AppError(404, "DirectoryNotFound", "Directory not found");
  }

  return directory;
}

async function requireWritableDirectory(db: D1Database, path: string): Promise<DirectoryRecord | null> {
  return requireReadableDirectory(db, path);
}

async function ensureWritableDirectory(db: D1Database, path: string): Promise<DirectoryRecord | null> {
  if (path === "/") {
    return null;
  }

  const segments = path.split("/").filter(Boolean);
  let parentPath = "/";
  let current: DirectoryRecord | null = null;

  for (const segment of segments) {
    const currentPath = parentPath === "/" ? `/${segment}` : `${parentPath}/${segment}`;
    current = await getDirectoryRecordByPath(db, currentPath);

    if (!current) {
      try {
        current = await insertDirectoryRecord({
          db,
          parentPath,
          name: segment,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        if (!(error instanceof AppError) || error.error !== "DirectoryExists") {
          throw error;
        }

        current = await getDirectoryRecordByPath(db, currentPath);
        if (!current) {
          throw error;
        }
      }
    }

    parentPath = currentPath;
  }

  return current;
}

function normalizeFileIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", "file_ids must be an array");
  }

  const ids = Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))).filter(Boolean);

  if (ids.length === 0) {
    throw new AppError(400, "InvalidBody", "file_ids must not be empty");
  }

  if (ids.length > 100) {
    throw new AppError(400, "InvalidBody", "file_ids must contain at most 100 ids");
  }

  return ids;
}

function normalizeOptionalIdList(value: unknown, fieldName: "file_ids" | "directory_ids"): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", `${fieldName} must be an array`);
  }

  const ids = Array.from(new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))).filter(Boolean);

  if (ids.length > 100) {
    throw new AppError(400, "InvalidBody", `${fieldName} must contain at most 100 ids`);
  }

  return ids;
}

function requireEntrySelection(fileIds: string[], directoryIds: string[]): void {
  if (fileIds.length === 0 && directoryIds.length === 0) {
    throw new AppError(400, "InvalidBody", "file_ids or directory_ids must not be empty");
  }
}

async function requireFileRecords(db: D1Database, ids: string[]): Promise<void> {
  for (const id of ids) {
    const file = await getFileRecord(db, id);
    if (!file) {
      throw new AppError(404, "NotFound", "File record not found");
    }
  }
}

async function requireDirectoryRecords(db: D1Database, ids: string[]): Promise<DirectoryRecord[]> {
  const records: DirectoryRecord[] = [];

  for (const id of ids) {
    const directory = await getDirectoryRecord(db, id);
    if (!directory) {
      throw new AppError(404, "DirectoryNotFound", "Directory not found");
    }
    records.push(directory);
  }

  return records;
}

function moveTargetParentPath(body: Record<string, unknown>): string {
  if (body.new_directory_name !== undefined) {
    return normalizeDirectoryPath(body.new_directory_parent_path ?? body.parent_path ?? body.directory_path ?? "/");
  }

  return normalizeDirectoryPath(body.directory_path ?? "/");
}

function validateEntryMoveParent(directories: DirectoryRecord[], parentPath: string): void {
  for (const directory of directories) {
    if (parentPath === directory.path || parentPath.startsWith(`${directory.path}/`)) {
      throw new AppError(400, "InvalidDirectoryMove", "Cannot move a directory into itself or its subdirectory");
    }
  }
}

async function validateEntryMoveTarget(
  db: D1Database,
  directories: DirectoryRecord[],
  parentPath: string
): Promise<void> {
  for (const directory of directories) {
    validateEntryMoveParent([directory], parentPath);

    const nextPath = parentPath === "/" ? `/${directory.name}` : `${parentPath}/${directory.name}`;
    if (nextPath === directory.path) {
      continue;
    }

    const conflict = await getDirectoryRecordByPath(db, nextPath);
    if (conflict && conflict.id !== directory.id) {
      throw new AppError(409, "DirectoryExists", "Target directory already contains a directory with the same name");
    }
  }
}

async function resolveMoveTargetDirectory(db: D1Database, body: Record<string, unknown>): Promise<string> {
  if (body.new_directory_name !== undefined) {
    const parentPath = normalizeDirectoryPath(
      body.new_directory_parent_path ?? body.parent_path ?? body.directory_path ?? "/"
    );
    const name = normalizeDirectoryName(body.new_directory_name);
    const directory = await insertDirectoryRecord({
      db,
      parentPath,
      name,
      createdAt: new Date().toISOString()
    });

    return directory.path;
  }

  const directoryPath = normalizeDirectoryPath(body.directory_path ?? "/");
  await requireWritableDirectory(db, directoryPath);
  return directoryPath;
}

function normalizeApiKeyStatus(value: unknown): ApiKeyStatus {
  if (value === "active" || value === "disabled") {
    return value;
  }

  throw new AppError(400, "InvalidBody", "API key status must be active or disabled");
}

function normalizeRemark(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 1000);
}

function normalizeRemarkUpdate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, "InvalidBody", "remark must be a string or null");
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function appendDownloadParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function getPublicBaseUrl(request: Request, env: Env): string {
  return normalizeBaseUrl(env.PUBLIC_BASE_URL || new URL(request.url).origin);
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeFileTypeFilter(value: string | null): FileTypeFilter | undefined {
  if (!value || value === "all") {
    return undefined;
  }

  if (
    value === "image" ||
    value === "text" ||
    value === "pdf" ||
    value === "archive" ||
    value === "other"
  ) {
    return value;
  }

  throw new AppError(400, "InvalidQuery", "File type filter is invalid");
}

function normalizeDateTimeParam(value: string | null, fieldName: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "InvalidQuery", `${fieldName} must be a valid date time`);
  }

  return date.toISOString();
}

function maskSecret(value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    return "未配置";
  }

  if (normalized.length <= 8) {
    return "••••";
  }

  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

function parsePositiveInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function extractFileToken(pathname: string): string {
  const token = extractOptionalFileToken(pathname);

  if (!token) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  return token;
}

function extractMultipartChunkAccess(pathname: string): { token: string; chunkIndex: number } | null {
  const match = /^\/f\/([^/]+)\/chunks\/([^/]+)$/.exec(pathname);

  if (!match) {
    return null;
  }

  const token = match[1];
  const chunkIndex = Number(match[2]);
  if (!token) {
    throw new AppError(404, "NotFound", "File route not found");
  }

  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new AppError(400, "InvalidChunkIndex", "Chunk index must be a non-negative integer");
  }

  return {
    token,
    chunkIndex
  };
}

function extractOptionalFileToken(pathname: string): string | undefined {
  const match = /^\/f\/([^/]+)(?:\/.*)?$/.exec(pathname);

  return match?.[1];
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);

  if (value) {
    target.set(name, value);
  }
}
