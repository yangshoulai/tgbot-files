import {
  findActiveApiKeyRecord,
  findActiveFileNameConflict,
  getFileRecord,
  touchApiKeyRecord,
  type ApiKeyRecord,
  type FileNameConflictAction,
  type FileRecord
} from "../database";
import { AppError, sanitizeFileName } from "../utils/http";
import type { AppDatabase } from "../runtime";
import {
  normalizeDirectoryPath,
  optionalNonNegativeInteger,
  optionalTrimmedString,
  isPlainRecord,
  stringField
} from "../validators/request";

export async function requireFileRecord(db: AppDatabase, id: string): Promise<FileRecord> {
  const file = await getFileRecord(db, id);

  if (!file) {
    throw new AppError(404, "FileNotFound", "File record not found");
  }

  return file;
}

export async function requireFileNameAvailable(params: {
  db: AppDatabase;
  directoryPath: string;
  fileName: string;
  excludeId?: string;
}): Promise<void> {
  const conflict = await findActiveFileNameConflict(params);

  if (conflict) {
    throw fileNameConflictError(params.directoryPath, params.fileName, conflict.source);
  }
}

export async function requireFileNameWritable(params: {
  db: AppDatabase;
  directoryPath: string;
  fileName: string;
  conflictAction: FileNameConflictAction;
  excludeId?: string;
}): Promise<void> {
  if (params.conflictAction === "overwrite") {
    return;
  }

  await requireFileNameAvailable(params);
}

interface UploadPreflightEntry {
  client_id: string;
  directory_path: string;
  file_name: string;
  relative_path?: string;
  size?: number;
}

type UploadPreflightConflictSource = "file" | "batch";

type UploadPreflightResultEntry = UploadPreflightEntry & {
  status: "ready" | "conflict";
  source?: UploadPreflightConflictSource;
  suggested_name?: string;
  message?: string;
};

export function normalizeUploadPreflightEntries(value: unknown): UploadPreflightEntry[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, "InvalidBody", "entries must be an array");
  }

  if (value.length === 0) {
    throw new AppError(400, "InvalidBody", "entries must not be empty");
  }

  if (value.length > 1000) {
    throw new AppError(400, "InvalidBody", "entries must contain at most 1000 files");
  }

  return value.map((item, index) => {
    if (!isPlainRecord(item)) {
      throw new AppError(400, "InvalidBody", `entries[${index}] must be an object`);
    }

    const clientId = stringField(item.client_id, `entries[${index}].client_id`);
    const fileName = sanitizeFileName(stringField(item.file_name, `entries[${index}].file_name`));
    const directoryPath = normalizeDirectoryPath(item.directory_path ?? "/");
    const relativePath = optionalTrimmedString(item.relative_path, 512);
    const size = optionalNonNegativeInteger(item.size, `entries[${index}].size`);

    return {
      client_id: clientId,
      directory_path: directoryPath,
      file_name: fileName,
      ...(relativePath ? { relative_path: relativePath } : {}),
      ...(size !== undefined ? { size } : {})
    };
  });
}

export async function preflightUploadEntries(
  db: AppDatabase,
  entries: UploadPreflightEntry[]
): Promise<UploadPreflightResultEntry[]> {
  const seenTargets = new Map<string, string>();
  const results: UploadPreflightResultEntry[] = [];

  for (const entry of entries) {
    const targetKey = `${entry.directory_path}\u0000${entry.file_name}`;
    const firstClientId = seenTargets.get(targetKey);

    if (firstClientId) {
      results.push({
        ...entry,
        status: "conflict",
        source: "batch",
        suggested_name: suggestAlternativeFileName(entry.file_name),
        message: "本次上传队列中已有相同目标路径的文件"
      });
      continue;
    }

    seenTargets.set(targetKey, entry.client_id);
    const conflict = await findActiveFileNameConflict({
      db,
      directoryPath: entry.directory_path,
      fileName: entry.file_name
    });

    if (conflict) {
      results.push({
        ...entry,
        status: "conflict",
        source: conflict.source,
        suggested_name: suggestAlternativeFileName(entry.file_name),
        message: "目标目录已存在同名文件"
      });
      continue;
    }

    results.push({
      ...entry,
      status: "ready"
    });
  }

  return results;
}

export async function requireFileMoveNamesAvailable(params: {
  db: AppDatabase;
  files: FileRecord[];
  directoryPath: string;
}): Promise<void> {
  const seenNames = new Set<string>();

  for (const file of params.files) {
    if (seenNames.has(file.file_name)) {
      throw fileNameConflictError(params.directoryPath, file.file_name, "file");
    }

    seenNames.add(file.file_name);
    await requireFileNameAvailable({
      db: params.db,
      directoryPath: params.directoryPath,
      fileName: file.file_name,
      excludeId: file.id
    });
  }
}

function fileNameConflictError(
  directoryPath: string,
  fileName: string,
  source: "file"
): AppError {
  return new AppError(
    409,
    "FileNameConflict",
    "当前目录已存在同名文件，请输入新的文件名",
    {
      directory_path: directoryPath,
      file_name: fileName,
      suggested_name: suggestAlternativeFileName(fileName),
      source
    }
  );
}

function suggestAlternativeFileName(fileName: string): string {
  const match = /^(.*?)(\.[^./\\]{1,12})$/.exec(fileName);
  const base = match?.[1] || fileName;
  const extension = match?.[2] || "";

  return `${base} (1)${extension}`;
}

export async function requireUploadApiKey(request: Request, db: AppDatabase): Promise<ApiKeyRecord> {
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
  return apiKey;
}
