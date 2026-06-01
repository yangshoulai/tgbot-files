import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { createSignedToken, verifySignedToken } from "../src/crypto";
import type {
  ApiKeyRecord,
  ApiKeyStatus,
  DirectoryRecord,
  FileChunkRecord,
  FileRecord,
  MultipartUploadRecord
} from "../src/database";

const uploadApiKey = "upload-secret";
const env: Env = {
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_STORAGE_CHAT_ID: "-1001234567890",
  LINK_SIGNING_SECRET: "link-secret",
  MAX_FILE_BYTES: "20971520"
};
const directAccessMaxChunks = 24;
const maxMultipartFileBytes = 5 * 1024 * 1024 * 1024;

class FakeD1 {
  readonly directories: DirectoryRecord[] = [];
  readonly files: FileRecord[] = [];
  readonly apiKeys: ApiKeyRecord[] = [];
  readonly multipartUploads: MultipartUploadRecord[] = [];
  readonly fileChunks: FileChunkRecord[] = [];

  prepare(sql: string): D1PreparedStatement {
    return new FakeD1Statement(this, sql) as unknown as D1PreparedStatement;
  }
}

class FakeD1Statement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): FakeD1Statement {
    this.bindings = values;
    return this;
  }

  async run(): Promise<D1Result> {
    const normalizedSql = this.sql.trim().toUpperCase();

    if (normalizedSql.startsWith("INSERT INTO FILES")) {
      const [
        id,
        fileName,
        mimeType,
        size,
        md5,
        telegramFileId,
        telegramFileUniqueId,
        filePath,
        remark,
        uploadedBy,
        createdAt,
        directoryId,
        directoryPath
      ] = this.bindings;

      this.db.files.push({
        id: String(id),
        file_name: String(fileName),
        mime_type: String(mimeType),
        size: Number(size),
        md5: String(md5),
        telegram_file_id: String(telegramFileId),
        telegram_file_unique_id: telegramFileUniqueId === null ? null : String(telegramFileUniqueId),
        file_path: String(filePath),
        remark: remark === null ? null : String(remark),
        uploaded_by: uploadedBy === null ? null : String(uploadedBy),
        created_at: String(createdAt),
        deleted_at: null,
        directory_id: directoryId === null ? null : String(directoryId),
        directory_path: String(directoryPath || "/"),
        storage_backend: this.bindings[13] === "telegram_multipart" ? "telegram_multipart" : "telegram_single",
        chunk_size: this.bindings[14] === null ? null : Number(this.bindings[14]),
        chunk_count: this.bindings[15] === null ? null : Number(this.bindings[15])
      });
    }

    if (normalizedSql.startsWith("INSERT INTO MULTIPART_UPLOADS")) {
      const [
        id,
        sourceKind,
        sourceUrl,
        fileName,
        mimeType,
        size,
        chunkSize,
        chunkCount,
        remark,
        uploadedBy,
        createdAt
      ] = this.bindings;

      this.db.multipartUploads.push({
        id: String(id),
        source_kind: sourceKind as MultipartUploadRecord["source_kind"],
        source_url: sourceUrl === null ? null : String(sourceUrl),
        file_name: String(fileName),
        mime_type: String(mimeType),
        size: Number(size),
        chunk_size: Number(chunkSize),
        chunk_count: Number(chunkCount),
        remark: remark === null ? null : String(remark),
        uploaded_by: uploadedBy === null ? null : String(uploadedBy),
        created_at: String(createdAt),
        directory_id: this.bindings[11] === null ? null : String(this.bindings[11]),
        directory_path: String(this.bindings[12] || "/"),
        completed_at: null
      });
    }

    if (normalizedSql.startsWith("INSERT INTO DIRECTORIES")) {
      const [id, parentId, name, path, createdAt] = this.bindings;

      this.db.directories.push({
        id: String(id),
        parent_id: parentId === null ? null : String(parentId),
        name: String(name),
        path: String(path),
        created_at: String(createdAt),
        deleted_at: null
      });
    }

    if (normalizedSql.startsWith("INSERT OR REPLACE INTO FILE_CHUNKS")) {
      const [fileId, chunkIndex, size, md5, telegramFileId, telegramFileUniqueId, createdAt] = this.bindings;
      const existingIndex = this.db.fileChunks.findIndex((item) =>
        item.file_id === fileId && item.chunk_index === chunkIndex
      );
      const chunk: FileChunkRecord = {
        file_id: String(fileId),
        chunk_index: Number(chunkIndex),
        size: Number(size),
        md5: String(md5),
        telegram_file_id: String(telegramFileId),
        telegram_file_unique_id: telegramFileUniqueId === null ? null : String(telegramFileUniqueId),
        created_at: String(createdAt)
      };

      if (existingIndex >= 0) {
        this.db.fileChunks[existingIndex] = chunk;
      } else {
        this.db.fileChunks.push(chunk);
      }
    }

    if (normalizedSql.startsWith("INSERT INTO API_KEYS")) {
      const [id, name, key, createdAt, updatedAt] = this.bindings;

      this.db.apiKeys.push({
        id: String(id),
        name: String(name),
        key: String(key),
        status: "active",
        created_at: String(createdAt),
        updated_at: String(updatedAt),
        last_used_at: null,
        deleted_at: null
      });
    }

    if (normalizedSql.startsWith("UPDATE FILES") && normalizedSql.includes("SET DELETED_AT")) {
      const [deletedAt, first, second] = this.bindings;
      if (normalizedSql.includes("DIRECTORY_ID IN")) {
        const selectionBindings = this.bindings.slice(1);
        for (const file of this.db.files) {
          if (file.deleted_at === null && this.fileMatchesDirectorySelection(file, selectionBindings)) {
            file.deleted_at = String(deletedAt);
          }
        }
      } else if (normalizedSql.includes("COALESCE(DIRECTORY_PATH")) {
        for (const file of this.db.files) {
          const path = file.directory_path ?? "/";
          if (file.deleted_at === null && (path === first || path.startsWith(String(second).replace(/\/%$/, "/")))) {
            file.deleted_at = String(deletedAt);
          }
        }
      } else {
        const file = this.db.files.find((item) => item.id === first);
        if (file) {
          file.deleted_at = String(deletedAt);
        }
      }
    }

    if (normalizedSql.startsWith("UPDATE FILES") && normalizedSql.includes("SET DIRECTORY_ID")) {
      const [directoryId, directoryPath, ...ids] = this.bindings;
      for (const file of this.db.files) {
        if (ids.includes(file.id) && file.deleted_at === null) {
          file.directory_id = directoryId === null ? null : String(directoryId);
          file.directory_path = String(directoryPath);
        }
      }
    }

    if (normalizedSql.startsWith("UPDATE FILES") && normalizedSql.includes("SET FILE_NAME")) {
      const [fileName, remark, filePath, id] = this.bindings;
      const file = this.db.files.find((item) => item.id === id && item.deleted_at === null);
      if (file) {
        file.file_name = String(fileName);
        file.remark = remark === null ? null : String(remark);
        file.file_path = String(filePath);
      }
    }

    if (normalizedSql.startsWith("UPDATE FILES") && normalizedSql.includes("DIRECTORY_PATH = ? || SUBSTR")) {
      const [nextPath, , oldPath, likePattern] = this.bindings;
      const prefix = String(likePattern).replace(/\/%$/, "/");
      for (const file of this.db.files) {
        const currentPath = file.directory_path ?? "/";
        if (file.deleted_at === null && (currentPath === oldPath || currentPath.startsWith(prefix))) {
          file.directory_path = String(nextPath) + currentPath.slice(String(oldPath).length);
        }
      }
    }

    if (normalizedSql.startsWith("UPDATE DIRECTORIES") && normalizedSql.includes("SET PARENT_ID")) {
      const [parentId, path, id] = this.bindings;
      const directory = this.db.directories.find((item) => item.id === id && item.deleted_at === null);
      if (directory) {
        directory.parent_id = parentId === null ? null : String(parentId);
        directory.path = String(path);
      }
    }

    if (normalizedSql.startsWith("UPDATE DIRECTORIES") && normalizedSql.includes("SET NAME")) {
      const [name, path, id] = this.bindings;
      const directory = this.db.directories.find((item) => item.id === id && item.deleted_at === null);
      if (directory) {
        directory.name = String(name);
        directory.path = String(path);
      }
    }

    if (normalizedSql.startsWith("UPDATE DIRECTORIES") && normalizedSql.includes("PATH = ? || SUBSTR")) {
      const [nextPath, , likePattern] = this.bindings;
      const prefix = String(likePattern).replace(/\/%$/, "/");
      const oldPath = prefix.replace(/\/$/, "");
      for (const directory of this.db.directories) {
        if (directory.deleted_at === null && directory.path.startsWith(prefix)) {
          directory.path = String(nextPath) + directory.path.slice(oldPath.length);
        }
      }
    }

    if (normalizedSql.startsWith("UPDATE DIRECTORIES") && normalizedSql.includes("SET DELETED_AT")) {
      const [deletedAt, path, likePattern] = this.bindings;
      if (normalizedSql.includes("ID IN")) {
        const ids = new Set(this.bindings.slice(1).map(String));
        for (const directory of this.db.directories) {
          if (directory.deleted_at === null && ids.has(directory.id)) {
            directory.deleted_at = String(deletedAt);
          }
        }
      } else {
        const prefix = String(likePattern).replace(/\/%$/, "/");
        for (const directory of this.db.directories) {
          if (directory.deleted_at === null && (directory.path === path || directory.path.startsWith(prefix))) {
            directory.deleted_at = String(deletedAt);
          }
        }
      }
    }

    if (normalizedSql.startsWith("DELETE FROM FILE_CHUNKS")) {
      const fileIds = normalizedSql.includes("WHERE FILE_ID = ?")
        ? new Set([String(this.bindings[0])])
        : new Set(
            this.db.files
              .filter((file) => this.fileMatchesDirectorySelection(file, this.bindings))
              .map((file) => file.id)
          );
      this.deleteWhere(this.db.fileChunks, (chunk) => fileIds.has(chunk.file_id));
    }

    if (normalizedSql.startsWith("DELETE FROM FILES")) {
      if (normalizedSql.includes("WHERE ID = ?")) {
        const id = String(this.bindings[0]);
        this.deleteWhere(this.db.files, (file) => file.id === id);
      } else {
        this.deleteWhere(this.db.files, (file) => this.fileMatchesDirectorySelection(file, this.bindings));
      }
    }

    if (normalizedSql.startsWith("DELETE FROM MULTIPART_UPLOADS")) {
      this.deleteWhere(this.db.multipartUploads, (upload) => this.uploadMatchesDirectorySelection(upload, this.bindings));
    }

    if (normalizedSql.startsWith("DELETE FROM DIRECTORIES")) {
      const id = String(this.bindings[0]);
      this.deleteWhere(this.db.directories, (directory) => directory.id === id);
    }

    if (normalizedSql.startsWith("UPDATE API_KEYS SET LAST_USED_AT")) {
      const [lastUsedAt, updatedAt, id] = this.bindings;
      const apiKey = this.db.apiKeys.find((item) => item.id === id && item.deleted_at === null);
      if (apiKey) {
        apiKey.last_used_at = String(lastUsedAt);
        apiKey.updated_at = String(updatedAt);
      }
    }

    if (normalizedSql.startsWith("UPDATE API_KEYS SET NAME")) {
      const [name, status, updatedAt, id] = this.bindings;
      const apiKey = this.db.apiKeys.find((item) => item.id === id && item.deleted_at === null);
      if (apiKey) {
        apiKey.name = String(name);
        apiKey.status = status as ApiKeyStatus;
        apiKey.updated_at = String(updatedAt);
      }
    }

    if (normalizedSql.startsWith("UPDATE API_KEYS SET DELETED_AT")) {
      const [deletedAt, updatedAt, id] = this.bindings;
      const apiKey = this.db.apiKeys.find((item) => item.id === id);
      if (apiKey) {
        apiKey.deleted_at = String(deletedAt);
        apiKey.updated_at = String(updatedAt);
      }
    }

    if (normalizedSql.startsWith("UPDATE MULTIPART_UPLOADS SET COMPLETED_AT")) {
      const [completedAt, id] = this.bindings;
      const upload = this.db.multipartUploads.find((item) => item.id === id && item.completed_at === null);
      if (upload) {
        upload.completed_at = String(completedAt);
      }
    }

    return { success: true, meta: fakeD1Meta(), results: [] };
  }

  async first<T = unknown>(): Promise<T | null> {
    const normalizedSql = this.sql.trim().toUpperCase();

    if (normalizedSql.startsWith("SELECT COUNT(*)")) {
      if (normalizedSql.includes("AS FILE_COUNT")) {
        let files = this.visibleFiles();
        if (normalizedSql.includes("COALESCE(DIRECTORY_PATH")) {
          const [path, likePattern] = this.bindings;
          const prefix = String(likePattern).replace(/\/%$/, "/");
          files = files.filter((file) => {
            const directoryPath = file.directory_path ?? "/";
            return directoryPath === path || directoryPath.startsWith(prefix);
          });
        }

        return {
          file_count: files.length,
          total_size: files.reduce((total, file) => total + file.size, 0)
        } as T;
      }

      if (normalizedSql.includes("FROM FILES") && normalizedSql.includes("DIRECTORY_ID IN")) {
        const files = normalizedSql.includes("DELETED_AT IS NULL")
          ? this.db.files.filter((item) => item.deleted_at === null)
          : this.db.files;
        return {
          total: files.filter((item) => this.fileMatchesDirectorySelection(item, this.bindings)).length
        } as T;
      }

      if (normalizedSql.includes("FROM DIRECTORIES")) {
        return { total: this.visibleDirectories().length } as T;
      }

      if (normalizedSql.includes("ID IN")) {
        const ids = this.bindings;
        return {
          total: this.db.files.filter((item) => ids.includes(item.id) && item.deleted_at === null).length
        } as T;
      }

      return { total: this.visibleFiles().length } as T;
    }

    if (normalizedSql.startsWith("SELECT ID FROM FILES")) {
      const id = this.bindings[0];
      const file = this.db.files.find((item) => item.id === id && item.deleted_at === null);
      return (file ? { id: file.id } : null) as T | null;
    }

    if (normalizedSql.includes("FROM FILES") && normalizedSql.includes("WHERE ID =")) {
      const id = this.bindings[0];
      const file = this.db.files.find((item) => item.id === id && item.deleted_at === null);
      return (file ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM MULTIPART_UPLOADS")) {
      const id = this.bindings[0];
      const upload = this.db.multipartUploads.find((item) => item.id === id && item.completed_at === null);
      return (upload ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM FILE_CHUNKS")) {
      const [fileId, chunkIndex] = this.bindings;
      const chunk = this.db.fileChunks.find((item) =>
        item.file_id === fileId && item.chunk_index === Number(chunkIndex)
      );
      return (chunk ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM DIRECTORIES")) {
      const directory = this.matchingDirectory(normalizedSql);
      return (directory ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM API_KEYS")) {
      const apiKey = this.matchingApiKey(normalizedSql);
      return (apiKey ?? null) as T | null;
    }

    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const normalizedSql = this.sql.trim().toUpperCase();
    if (normalizedSql.includes("FROM API_KEYS")) {
      return {
        success: true,
        meta: fakeD1Meta(),
        results: this.db.apiKeys.filter((item) => item.deleted_at === null) as T[]
      };
    }

    if (normalizedSql.includes("FROM FILE_CHUNKS")) {
      const fileId = this.bindings[0];
      return {
        success: true,
        meta: fakeD1Meta(),
        results: this.db.fileChunks
          .filter((item) => item.file_id === fileId)
          .sort((left, right) => left.chunk_index - right.chunk_index) as T[]
      };
    }

    if (normalizedSql.includes("FROM DIRECTORIES")) {
      const directories = normalizedSql.includes("DELETED_AT IS NULL") ||
        normalizedSql.includes("PARENT_ID IS NULL") ||
        normalizedSql.includes("PARENT_ID = ?") ||
        normalizedSql.includes("PATH = ? OR PATH LIKE ?")
        ? this.visibleDirectories()
        : this.db.directories.slice().sort((left, right) => left.path.localeCompare(right.path));
      return {
        success: true,
        meta: fakeD1Meta(),
        results: directories as T[]
      };
    }

    if (normalizedSql.includes("GROUP BY COALESCE(DIRECTORY_PATH")) {
      const rows = new Map<string, { directory_path: string; file_count: number; total_size: number }>();
      for (const file of this.db.files) {
        if (file.deleted_at !== null) {
          continue;
        }

        const directoryPath = file.directory_path ?? "/";
        const row = rows.get(directoryPath) ?? { directory_path: directoryPath, file_count: 0, total_size: 0 };
        row.file_count += 1;
        row.total_size += file.size;
        rows.set(directoryPath, row);
      }

      return {
        success: true,
        meta: fakeD1Meta(),
        results: Array.from(rows.values()) as T[]
      };
    }

    const files = this.visibleFiles();
    const limit = Number(this.bindings.at(-2));
    const offset = Number(this.bindings.at(-1));

    return {
      success: true,
      meta: fakeD1Meta(),
      results: files.slice(offset || 0, Number.isFinite(limit) ? (offset || 0) + limit : undefined) as T[]
    };
  }

  private visibleFiles(): FileRecord[] {
    const normalizedSql = this.sql.trim().toUpperCase();
    let bindingIndex = 0;
    let directoryPath = "";
    let directoryPrefix = "";

    if (normalizedSql.includes("COALESCE(DIRECTORY_PATH, '/') = ?")) {
      directoryPath = String(this.bindings[bindingIndex++]);
      if (normalizedSql.includes("COALESCE(DIRECTORY_PATH, '/') LIKE ?")) {
        directoryPrefix = String(this.bindings[bindingIndex++]).replace(/\/%$/, "/");
      }
    }

    const pattern = typeof this.bindings[bindingIndex] === "string" && String(this.bindings[bindingIndex]).startsWith("%")
      ? String(this.bindings[bindingIndex]).slice(1, -1).toLowerCase()
      : "";

    if (pattern) {
      bindingIndex += 2;
    }

    const createdFrom = normalizedSql.includes("CREATED_AT >= ?")
      ? String(this.bindings[bindingIndex++])
      : "";
    const createdTo = normalizedSql.includes("CREATED_AT <= ?")
      ? String(this.bindings[bindingIndex])
      : "";

    return this.db.files.filter((file) => {
      if (file.deleted_at !== null) {
        return false;
      }

      const fileDirectoryPath = file.directory_path ?? "/";
      if (directoryPath) {
        const matchesDirectory = directoryPrefix
          ? fileDirectoryPath === directoryPath || fileDirectoryPath.startsWith(directoryPrefix)
          : fileDirectoryPath === directoryPath;
        if (!matchesDirectory) {
          return false;
        }
      }

      if (pattern && ![file.file_name, file.remark ?? ""].some((value) => value.toLowerCase().includes(pattern))) {
        return false;
      }

      if (createdFrom && file.created_at < createdFrom) {
        return false;
      }

      if (createdTo && file.created_at > createdTo) {
        return false;
      }

      const mime = file.mime_type.toLowerCase();
      const name = file.file_name.toLowerCase();
      const isImage = mime.startsWith("image/");
      const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
      const isArchive = /\.(zip|rar|7z|tar|gz)$/i.test(name);
      const isText = mime.startsWith("text/") || /\.(json|xml|ya?ml|md|markdown|log)$/i.test(name);

      if (normalizedSql.includes("NOT (LOWER(MIME_TYPE) LIKE 'IMAGE/%'")) {
        return !(isImage || isText || isPdf || isArchive);
      }

      if (normalizedSql.includes("LOWER(MIME_TYPE) LIKE 'IMAGE/%'")) {
        return isImage;
      }

      if (normalizedSql.includes("LOWER(MIME_TYPE) = 'APPLICATION/PDF'")) {
        return isPdf;
      }

      if (normalizedSql.includes("APPLICATION/ZIP")) {
        return isArchive;
      }

      if (normalizedSql.includes("LOWER(MIME_TYPE) LIKE 'TEXT/%'")) {
        return isText;
      }

      return true;
    });
  }

  private visibleDirectories(): DirectoryRecord[] {
    const normalizedSql = this.sql.trim().toUpperCase();
    let directories = this.db.directories.filter((item) => item.deleted_at === null);

    if (normalizedSql.includes("PARENT_ID IS NULL")) {
      directories = directories.filter((item) => item.parent_id === null);
    } else if (normalizedSql.includes("PARENT_ID = ?")) {
      const parentId = this.bindings[0];
      directories = directories.filter((item) => item.parent_id === parentId);
    } else if (normalizedSql.includes("PATH = ? OR PATH LIKE ?")) {
      const [path, likePattern] = this.bindings;
      const prefix = String(likePattern).replace(/\/%$/, "/");
      directories = directories.filter((item) => item.path === path || item.path.startsWith(prefix));
    }

    return directories.sort((left, right) => left.path.localeCompare(right.path));
  }

  private fileMatchesDirectorySelection(file: FileRecord, bindings: unknown[]): boolean {
    const { directoryIds, directoryPaths } = this.selectedDirectoryValues(bindings);
    const directoryId = file.directory_id ?? null;

    return (
      (directoryId !== null && directoryIds.has(directoryId)) ||
      directoryPaths.has(file.directory_path ?? "/")
    );
  }

  private uploadMatchesDirectorySelection(upload: MultipartUploadRecord, bindings: unknown[]): boolean {
    const { directoryIds, directoryPaths } = this.selectedDirectoryValues(bindings);
    const directoryId = upload.directory_id ?? null;

    return (
      (directoryId !== null && directoryIds.has(directoryId)) ||
      directoryPaths.has(upload.directory_path ?? "/")
    );
  }

  private deleteWhere<T>(items: T[], predicate: (item: T) => boolean): void {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item !== undefined && predicate(item)) {
        items.splice(index, 1);
      }
    }
  }

  private selectedDirectoryValues(bindings: unknown[]): {
    directoryIds: Set<string>;
    directoryPaths: Set<string>;
  } {
    const normalizedSql = this.sql.trim().toUpperCase();
    const directoryIdCount = this.placeholderCount(normalizedSql, "DIRECTORY_ID IN (");
    const directoryPathCount = this.placeholderCount(normalizedSql, "COALESCE(DIRECTORY_PATH, '/') IN (");

    return {
      directoryIds: new Set(bindings.slice(0, directoryIdCount).map(String)),
      directoryPaths: new Set(bindings.slice(directoryIdCount, directoryIdCount + directoryPathCount).map(String))
    };
  }

  private placeholderCount(normalizedSql: string, marker: string): number {
    const start = normalizedSql.indexOf(marker);
    if (start < 0) {
      return 0;
    }

    const bodyStart = start + marker.length;
    const bodyEnd = normalizedSql.indexOf(")", bodyStart);
    if (bodyEnd < 0) {
      return 0;
    }

    return normalizedSql.slice(bodyStart, bodyEnd).split("?").length - 1;
  }

  private matchingApiKey(normalizedSql: string): ApiKeyRecord | undefined {
    if (normalizedSql.includes("WHERE KEY =")) {
      const key = this.bindings[0];
      return this.db.apiKeys.find((item) =>
        item.key === key &&
        item.status === "active" &&
        item.deleted_at === null
      );
    }

    if (normalizedSql.includes("WHERE ID =")) {
      const id = this.bindings[0];
      return this.db.apiKeys.find((item) => item.id === id && item.deleted_at === null);
    }

    return undefined;
  }

  private matchingDirectory(normalizedSql: string): DirectoryRecord | undefined {
    if (normalizedSql.includes("WHERE ID =")) {
      const id = this.bindings[0];
      return this.db.directories.find((item) => item.id === id && item.deleted_at === null);
    }

    if (normalizedSql.includes("WHERE PATH =")) {
      const path = this.bindings[0];
      return this.db.directories.find((item) => item.path === path && item.deleted_at === null);
    }

    return undefined;
  }
}

function envWithDb(db: FakeD1): Env {
  return {
    ...env,
    FILES_DB: db as unknown as D1Database
  };
}

function addApiKey(db: FakeD1, options?: { key?: string; status?: ApiKeyStatus }): ApiKeyRecord {
  const apiKey: ApiKeyRecord = {
    id: crypto.randomUUID(),
    name: "primary",
    key: options?.key ?? uploadApiKey,
    status: options?.status ?? "active",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    last_used_at: null,
    deleted_at: null
  };
  db.apiKeys.push(apiKey);

  return apiKey;
}

function fakeD1Meta(): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0
  };
}

function uploadRequest(options?: {
  token?: string | null;
  file?: File | string | null;
  remark?: string;
  directoryPath?: string;
  contentTypeOverride?: string;
}): Request {
  const form = new FormData();
  const file = options?.file === undefined ? new File(["hello"], "hello.txt", { type: "text/plain" }) : options.file;

  if (file !== null) {
    form.set("file", file);
  }
  if (options?.remark) {
    form.set("remark", options.remark);
  }
  if (options?.directoryPath) {
    form.set("directory_path", options.directoryPath);
  }

  const headers = new Headers();
  if (options?.token !== null) {
    headers.set("Authorization", `Bearer ${options?.token ?? uploadApiKey}`);
  }
  if (options?.contentTypeOverride) {
    headers.set("Content-Type", options.contentTypeOverride);
  }

  return new Request("https://files.example.com/api/v1/files", {
    method: "POST",
    headers,
    body: form
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined)
    }
  });
}

describe("worker upload endpoint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects missing bearer auth", async () => {
    const response = await worker.fetch(uploadRequest({ token: null }), envWithDb(new FakeD1()));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects invalid bearer auth", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const response = await worker.fetch(uploadRequest({ token: "wrong" }), envWithDb(db));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects disabled upload API keys", async () => {
    const db = new FakeD1();
    addApiKey(db, { status: "disabled" });
    const response = await worker.fetch(uploadRequest(), envWithDb(db));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects missing file", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const response = await worker.fetch(uploadRequest({ file: null }), envWithDb(db));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("MissingFile");
  });

  it("rejects empty file", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const response = await worker.fetch(
      uploadRequest({ file: new File([""], "empty.txt", { type: "text/plain" }) }),
      envWithDb(db)
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("EmptyFile");
  });

  it("rejects files over configured limit", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const smallLimitEnv = { ...envWithDb(db), MAX_FILE_BYTES: "5" };
    const response = await worker.fetch(
      uploadRequest({ file: new File(["123456"], "too-large.txt", { type: "text/plain" }) }),
      smallLimitEnv
    );
    const body = await response.json() as {
      error: string;
      message: string;
      details: {
        max_file_bytes: number;
        actual_file_bytes: number;
        max_file_size: string;
        actual_file_size: string;
      };
    };

    expect(response.status).toBe(413);
    expect(body.error).toBe("FileTooLarge");
    expect(body.message).toContain("5B");
    expect(body.message).toContain("6B");
    expect(body.details.max_file_bytes).toBe(5);
    expect(body.details.actual_file_bytes).toBe(6);
    expect(body.details.max_file_size).toBe("5B");
    expect(body.details.actual_file_size).toBe("6B");
  });

  it("uploads a file to Telegram and returns a signed public URL", async () => {
    const db = new FakeD1();
    const apiKey = addApiKey(db);
    const fetchCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "tg-file-id",
            file_name: "hello.txt",
            mime_type: "text/plain",
            file_size: 5
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(uploadRequest(), envWithDb(db));
    const body = await response.json() as {
      ok: boolean;
      url: string;
      name: string;
      size: number;
      mime_type: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^https:\/\/files\.example\.com\/f\//);
    expect(body.name).toBe("hello.txt");
    expect(body.size).toBe(5);
    expect(body.mime_type).toBe("text/plain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCalls[0]).toBe("https://api.telegram.org/bot123456:test-token/sendDocument");
    expect(db.files).toHaveLength(1);
    expect(db.files[0]?.uploaded_by).toBeNull();
    expect(apiKey.last_used_at).not.toBeNull();
  });

  it("auto-creates missing directory path for upload API requests", async () => {
    const db = new FakeD1();
    addApiKey(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-auto-dir-file-id",
              file_name: "hello.txt",
              mime_type: "text/plain",
              file_size: 5
            }
          }
        })
      )
    );

    const response = await worker.fetch(
      uploadRequest({ directoryPath: "/auto/nested" }),
      envWithDb(db)
    );
    const body = await response.json() as { ok: boolean; url: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(db.directories.map((item) => item.path)).toEqual(["/auto", "/auto/nested"]);
    expect(db.directories[0]?.parent_id).toBeNull();
    expect(db.directories[1]?.parent_id).toBe(db.directories[0]?.id);
    expect(db.files[0]?.directory_id).toBe(db.directories[1]?.id);
    expect(db.files[0]?.directory_path).toBe("/auto/nested");
  });

  it("accepts small webp files when Telegram returns them as stickers", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          sticker: {
            file_id: "tg-sticker-file-id",
            file_unique_id: "tg-sticker-unique-id",
            file_size: 4
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      uploadRequest({ file: new File(["webp"], "tiny.webp", { type: "image/webp" }) }),
      envWithDb(db)
    );
    const body = await response.json() as {
      ok: boolean;
      url: string;
      name: string;
      size: number;
      mime_type: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^https:\/\/files\.example\.com\/f\//);
    expect(body.name).toBe("tiny.webp");
    expect(body.size).toBe(4);
    expect(body.mime_type).toBe("image/webp");
  });

  it("sniffs WebP MIME type from file bytes when upload headers are octet-stream", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x02, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-webp-file-id",
              file_unique_id: "tg-webp-unique-id",
              file_name: "tiny.webp",
              mime_type: "application/octet-stream",
              file_size: webpBytes.byteLength
            }
          }
        })
      )
    );

    const response = await worker.fetch(
      uploadRequest({ file: new File([webpBytes], "tiny.webp", { type: "application/octet-stream" }) }),
      envWithDb(db)
    );
    const body = await response.json() as {
      ok: boolean;
      mime_type: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mime_type).toBe("image/webp");
    expect(db.files[0]?.mime_type).toBe("image/webp");
  });

  it("surfaces Telegram upload errors", async () => {
    const db = new FakeD1();
    addApiKey(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, description: "chat not found", error_code: 400 }, { status: 400 }))
    );

    const response = await worker.fetch(uploadRequest(), envWithDb(db));
    const body = await response.json() as { error: string; message: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe("TelegramUploadFailed");
    expect(body.message).toBe("chat not found");
  });
});

describe("API key multipart endpoints", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads, inspects, and downloads a small multipart file", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const apiEnv = envWithDb(db);
    const telegramFileRanges: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = String(input);
      const headers = new Headers(init?.headers);
      const range = headers.get("Range");

      if (inputUrl.endsWith("/sendDocument")) {
        return jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-small-chunk",
              file_unique_id: "tg-small-unique",
              file_name: "small.txt.part-1-of-1",
              mime_type: "text/plain",
              file_size: 5
            }
          }
        });
      }

      if (inputUrl.includes("/getFile?file_id=tg-small-chunk")) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "tg-small-chunk",
            file_path: "documents/small-part"
          }
        });
      }

      if (inputUrl.endsWith("/documents/small-part")) {
        telegramFileRanges.push(range);
        if (range === "bytes=1-3") {
          return new Response("ell", {
            status: 206,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Range": "bytes 1-3/5",
              "Content-Length": "3"
            }
          });
        }

        return new Response("hello", {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "5"
          }
        });
      }

      throw new Error(`Unexpected fetch ${inputUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const initResponse = await worker.fetch(
      new Request("https://files.example.com/api/v1/uploads/init", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_name: "small.txt",
          mime_type: "text/plain",
          size: 5,
          directory_path: "/api/small"
        })
      }),
      apiEnv
    );
    const initBody = await initResponse.json() as {
      upload: { id: string; chunk_count: number; direct_access: boolean; directory_path: string };
    };

    expect(initResponse.status).toBe(201);
    expect(initBody.upload.chunk_count).toBe(1);
    expect(initBody.upload.direct_access).toBe(true);
    expect(initBody.upload.directory_path).toBe("/api/small");

    const chunkForm = new FormData();
    chunkForm.set("chunk", new File(["hello"], "small.txt.part-1", { type: "text/plain" }));
    const chunkResponse = await worker.fetch(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/chunks/0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` },
        body: chunkForm
      }),
      apiEnv
    );
    const chunkBody = await chunkResponse.json() as { uploaded_chunks: number };

    expect(chunkResponse.status).toBe(200);
    expect(chunkBody.uploaded_chunks).toBe(1);

    const completeResponse = await worker.fetch(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );
    const completeBody = await completeResponse.json() as {
      file: {
        id: string;
        storage_backend: string;
        chunk_count: number;
        direct_access: boolean;
        url: string;
        uploaded_by: string | null;
      };
    };

    expect(completeResponse.status).toBe(200);
    expect(completeBody.file.id).toBe(initBody.upload.id);
    expect(completeBody.file.storage_backend).toBe("telegram_multipart");
    expect(completeBody.file.chunk_count).toBe(1);
    expect(completeBody.file.direct_access).toBe(true);
    expect(completeBody.file.url).toMatch(/^https:\/\/files\.example\.com\/f\//);
    expect(completeBody.file.uploaded_by).toBeNull();

    const infoResponse = await worker.fetch(
      new Request(`https://files.example.com/api/v1/files/${completeBody.file.id}`, {
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );
    const infoBody = await infoResponse.json() as {
      file: { id: string; chunk_count: number; direct_access: boolean; download_strategy: string };
    };

    expect(infoResponse.status).toBe(200);
    expect(infoBody.file).toMatchObject({
      id: completeBody.file.id,
      chunk_count: 1,
      direct_access: true,
      download_strategy: "direct_or_accelerated"
    });

    const downloadResponse = await worker.fetch(
      new Request(`https://files.example.com/api/v1/files/${completeBody.file.id}/chunks/0`, {
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );

    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe("hello");
    expect(downloadResponse.headers.get("X-Chunk-Count")).toBe("1");
    expect(downloadResponse.headers.get("Content-Disposition")).toContain("small.txt.part-1-of-1");

    const publicPathParts = new URL(completeBody.file.url).pathname.split("/");
    const token = publicPathParts[2] ?? "";
    const rangeResponse = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/chunks/0`, {
        headers: { Range: "bytes=1-3" }
      }),
      apiEnv
    );

    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("Accept-Ranges")).toBe("bytes");
    expect(rangeResponse.headers.get("Content-Range")).toBe("bytes 1-3/5");
    expect(rangeResponse.headers.get("Content-Length")).toBe("3");
    expect(await rangeResponse.text()).toBe("ell");
    expect(telegramFileRanges).toContain("bytes=1-3");

    const unsatisfiableResponse = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/chunks/0`, {
        headers: { Range: "bytes=5-6" }
      }),
      apiEnv
    );

    expect(unsatisfiableResponse.status).toBe(416);
    expect(unsatisfiableResponse.headers.get("Content-Range")).toBe("bytes */5");
  });

  it("imports a small URL through the API key multipart URL flow", async () => {
    const db = new FakeD1();
    addApiKey(db);
    const apiEnv = envWithDb(db);
    const sourceUrl = "https://source.example.com/small.txt";
    const fetchCalls: Array<{ input: string; method: string | undefined; range: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = String(input);
      const headers = new Headers(init?.headers);
      fetchCalls.push({
        input: inputUrl,
        method: init?.method,
        range: headers.get("Range")
      });

      if (inputUrl === sourceUrl && init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Content-Length": "5",
            "Content-Type": "text/plain"
          }
        });
      }

      if (inputUrl === sourceUrl && headers.get("Range") === "bytes=0-0") {
        return new Response("h", {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-0/5",
            "Content-Length": "1"
          }
        });
      }

      if (inputUrl === sourceUrl && headers.get("Range") === "bytes=0-4") {
        return new Response("hello", {
          status: 206,
          headers: {
            "Content-Length": "5",
            "Content-Range": "bytes 0-4/5"
          }
        });
      }

      if (inputUrl.endsWith("/sendDocument")) {
        return jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-url-small-chunk",
              file_name: "small.txt.part-1-of-1",
              mime_type: "text/plain",
              file_size: 5
            }
          }
        });
      }

      throw new Error(`Unexpected fetch ${inputUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const initResponse = await worker.fetch(
      new Request("https://files.example.com/api/v1/uploads/url/init", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl, remark: "URL 小文件分片" })
      }),
      apiEnv
    );
    const initBody = await initResponse.json() as {
      mode: string;
      upload: { id: string; file_name: string; size: number; chunk_count: number };
    };

    expect(initResponse.status).toBe(201);
    expect(initBody.mode).toBe("multipart");
    expect(initBody.upload.file_name).toBe("small.txt");
    expect(initBody.upload.size).toBe(5);
    expect(initBody.upload.chunk_count).toBe(1);

    const chunkResponse = await worker.fetch(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/url-chunks/0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );
    expect(chunkResponse.status).toBe(200);

    const completeResponse = await worker.fetch(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );
    const completeBody = await completeResponse.json() as {
      file: { storage_backend: string; chunk_count: number; remark: string | null };
    };

    expect(completeResponse.status).toBe(200);
    expect(completeBody.file.storage_backend).toBe("telegram_multipart");
    expect(completeBody.file.chunk_count).toBe(1);
    expect(completeBody.file.remark).toBe("URL 小文件分片");
    expect(fetchCalls.some((call) => call.range === "bytes=0-4")).toBe(true);
  });

  it("rejects API key chunk downloads for non-multipart files", async () => {
    const db = new FakeD1();
    addApiKey(db);
    db.files.push({
      id: "single-file",
      file_name: "plain.txt",
      mime_type: "text/plain",
      size: 5,
      md5: "md5",
      telegram_file_id: "tg-single",
      telegram_file_unique_id: null,
      file_path: "/f/token/plain.txt",
      remark: null,
      uploaded_by: null,
      created_at: "2026-06-01T00:00:00.000Z",
      deleted_at: null,
      directory_id: null,
      directory_path: "/",
      storage_backend: "telegram_single",
      chunk_size: null,
      chunk_count: null
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/v1/files/single-file/chunks/0", {
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      envWithDb(db)
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("NotMultipartFile");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("worker file access endpoint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies a signed file link through Telegram getFile", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));

      if (fetchCalls.length === 1) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "tg-file-id",
            file_size: 5,
            file_path: "documents/file_1.txt"
          }
        });
      }

      return new Response("hello", {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "5",
          "Accept-Ranges": "bytes"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/hello.txt`), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain("hello.txt");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toEqual([
      "https://api.telegram.org/bot123456:test-token/getFile?file_id=tg-file-id",
      "https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt"
    ]);
  });

  it("proxies repeated signed file access through Telegram each time", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/getFile?")) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "tg-file-id",
            file_size: 5,
            file_path: "documents/file_1.txt"
          }
        });
      }

      return new Response("hello", {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "5"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fileUrl = `https://files.example.com/f/${token}/hello.txt`;
    const firstResponse = await worker.fetch(new Request(fileUrl), env);
    expect(await firstResponse.text()).toBe("hello");

    const secondResponse = await worker.fetch(new Request(fileUrl), env);
    expect(await secondResponse.text()).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("forwards range requests to Telegram file download", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchCalls: Array<{ input: string; range: string | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        input: String(input),
        range: new Headers(init?.headers).get("Range") ?? undefined
      });

      if (fetchCalls.length === 1) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "tg-file-id",
            file_size: 5,
            file_path: "documents/file_1.txt"
          }
        });
      }

      return new Response("he", {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "2",
          "Content-Range": "bytes 0-1/5"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/hello.txt`, {
        headers: { Range: "bytes=0-1" }
      }),
      env
    );

    expect(response.status).toBe(206);
    expect(fetchCalls[1]).toEqual({
      input: "https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt",
      range: "bytes=0-1"
    });
  });

  it("can force attachment disposition with download query parameter", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/getFile?")) {
          return jsonResponse({
            ok: true,
            result: {
              file_id: "tg-file-id",
              file_size: 5,
              file_path: "documents/file_1.txt"
            }
          });
        }

        return new Response("hello", {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "5"
          }
        });
      })
    );

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/hello.txt?download=1`), env);

    expect(response.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("streams range requests across multipart Telegram chunks", async () => {
    const db = new FakeD1();
    db.fileChunks.push(
      {
        file_id: "file-multipart",
        chunk_index: 0,
        size: 3,
        md5: "chunk-a",
        telegram_file_id: "tg-chunk-0",
        telegram_file_unique_id: null,
        created_at: "2026-05-31T00:00:00.000Z"
      },
      {
        file_id: "file-multipart",
        chunk_index: 1,
        size: 3,
        md5: "chunk-b",
        telegram_file_id: "tg-chunk-1",
        telegram_file_unique_id: null,
        created_at: "2026-05-31T00:00:01.000Z"
      }
    );
    const token = await createSignedToken(
      {
        v: 2,
        file_record_id: "file-multipart",
        name: "letters.txt",
        mime_type: "text/plain",
        size: 6,
        chunk_size: 3,
        chunk_count: 2,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchCalls: Array<{ input: string; range: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = String(input);
        const range = new Headers(init?.headers).get("Range");
        fetchCalls.push({ input: inputUrl, range });

        if (inputUrl.includes("file_id=tg-chunk-0")) {
          return jsonResponse({ ok: true, result: { file_id: "tg-chunk-0", file_path: "documents/chunk0" } });
        }
        if (inputUrl.includes("file_id=tg-chunk-1")) {
          return jsonResponse({ ok: true, result: { file_id: "tg-chunk-1", file_path: "documents/chunk1" } });
        }
        if (inputUrl.endsWith("/documents/chunk0")) {
          expect(range).toBe("bytes=2-2");
          return new Response("c", { status: 206, headers: { "Content-Length": "1" } });
        }
        if (inputUrl.endsWith("/documents/chunk1")) {
          expect(range).toBe("bytes=0-1");
          return new Response("de", { status: 206, headers: { "Content-Length": "2" } });
        }

        throw new Error(`Unexpected fetch ${inputUrl}`);
      })
    );

    const response = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/letters.txt`, {
        headers: { Range: "bytes=2-4" }
      }),
      envWithDb(db)
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-4/6");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(await response.text()).toBe("cde");
    expect(fetchCalls).toHaveLength(4);
  });

  it("rejects direct multipart file access when the chunk count exceeds the direct-link budget", async () => {
    const token = await createSignedToken(
      {
        v: 2,
        file_record_id: "file-large-multipart",
        name: "large.bin",
        mime_type: "application/octet-stream",
        size: 75,
        chunk_size: 3,
        chunk_count: directAccessMaxChunks + 1,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/large.bin`), env);
    const body = await response.json() as {
      error: string;
      details: { chunk_count: number; direct_access_max_chunks: number };
    };

    expect(response.status).toBe(403);
    expect(body.error).toBe("DirectAccessDisabled");
    expect(body.details.chunk_count).toBe(directAccessMaxChunks + 1);
    expect(body.details.direct_access_max_chunks).toBe(directAccessMaxChunks);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads an existing multipart chunk without issuing Telegram range requests", async () => {
    const db = new FakeD1();
    db.fileChunks.push(
      {
        file_id: "file-multipart",
        chunk_index: 0,
        size: 3,
        md5: "chunk-a",
        telegram_file_id: "tg-chunk-0",
        telegram_file_unique_id: null,
        created_at: "2026-05-31T00:00:00.000Z"
      },
      {
        file_id: "file-multipart",
        chunk_index: 1,
        size: 2,
        md5: "chunk-b",
        telegram_file_id: "tg-chunk-1",
        telegram_file_unique_id: null,
        created_at: "2026-05-31T00:00:01.000Z"
      }
    );
    const token = await createSignedToken(
      {
        v: 2,
        file_record_id: "file-multipart",
        name: "letters.txt",
        mime_type: "text/plain",
        size: 5,
        chunk_size: 3,
        chunk_count: 2,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchCalls: Array<{ input: string; range: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = String(input);
        const range = new Headers(init?.headers).get("Range");
        fetchCalls.push({ input: inputUrl, range });

        if (inputUrl.includes("file_id=tg-chunk-1")) {
          return jsonResponse({ ok: true, result: { file_id: "tg-chunk-1", file_path: "documents/chunk1" } });
        }
        if (inputUrl.endsWith("/documents/chunk1")) {
          expect(range).toBeNull();
          return new Response("de", {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": "2"
            }
          });
        }

        throw new Error(`Unexpected fetch ${inputUrl}`);
      })
    );

    const response = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/chunks/1`),
      envWithDb(db)
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("de");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Length")).toBe("2");
    expect(response.headers.get("X-Chunk-Index")).toBe("1");
    expect(response.headers.get("X-Chunk-Count")).toBe("2");
    expect(response.headers.get("X-Chunk-Offset")).toBe("3");
    expect(response.headers.get("Content-Disposition")).toContain("letters.txt.part-2-of-2");
    expect(fetchCalls).toEqual([
      {
        input: "https://api.telegram.org/bot123456:test-token/getFile?file_id=tg-chunk-1",
        range: null
      },
      {
        input: "https://api.telegram.org/file/bot123456:test-token/documents/chunk1",
        range: null
      }
    ]);
  });

  it("rejects out-of-range multipart chunk downloads before fetching Telegram", async () => {
    const db = new FakeD1();
    const token = await createSignedToken(
      {
        v: 2,
        file_record_id: "file-multipart",
        name: "letters.txt",
        mime_type: "text/plain",
        size: 5,
        chunk_size: 3,
        chunk_count: 2,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request(`https://files.example.com/f/${token}/chunks/2`),
      envWithDb(db)
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("InvalidChunkIndex");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects chunk downloads for single-file tokens", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/chunks/0`), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("NotMultipartFile");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects tampered file links", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    const response = await worker.fetch(new Request(`https://files.example.com/f/${tampered}/hello.txt`), env);
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("InvalidFileToken");
  });

  it("surfaces Telegram getFile errors", async () => {
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "tg-file-id",
        name: "hello.txt",
        mime_type: "text/plain",
        size: 5,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, description: "file is too big", error_code: 400 }, { status: 400 }))
    );

    const response = await worker.fetch(new Request(`https://files.example.com/f/${token}/hello.txt`), env);
    const body = await response.json() as { error: string; message: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe("TelegramFileLookupFailed");
    expect(body.message).toBe("file is too big");
  });
});

describe("admin file manager", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets an admin session cookie after form login", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const form = new URLSearchParams({ username: "admin", password: "secret" });

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form
      }),
      adminEnv
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin");
    expect(response.headers.get("Set-Cookie")).toContain("tgbot_admin=");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=2592000");
  });

  it("sets a browser session cookie when remember me is disabled", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret", remember_me: false })
      }),
      adminEnv
    );
    const cookie = response.headers.get("Set-Cookie");

    expect(response.status).toBe(200);
    expect(cookie).toContain("tgbot_admin=");
    expect(cookie).not.toContain("Max-Age");

    const sessionResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/session", {
        headers: { Cookie: cookie || "" }
      }),
      adminEnv
    );
    const refreshedCookie = sessionResponse.headers.get("Set-Cookie");

    expect(sessionResponse.status).toBe(200);
    expect(refreshedCookie).toContain("tgbot_admin=");
    expect(refreshedCookie).not.toContain("Max-Age");
  });

  it("refreshes an admin session cookie after a valid protected request", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(Date.parse("2026-01-01T00:00:00.000Z"));
      const cookie = await loginAndGetCookie(adminEnv);

      now.mockReturnValue(Date.parse("2026-01-02T00:00:00.000Z"));
      const response = await worker.fetch(
        new Request("https://files.example.com/api/admin/session", {
          headers: { Cookie: cookie }
        }),
        adminEnv
      );
      const refreshedCookie = response.headers.get("Set-Cookie");

      expect(response.status).toBe(200);
      expect(refreshedCookie).toContain("tgbot_admin=");
      expect(refreshedCookie).toContain("Max-Age=2592000");
      expect(refreshedCookie).not.toBe(cookie);
    } finally {
      now.mockRestore();
    }
  });

  it("expires the admin session cookie on manual logout", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/logout", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const expiredCookie = response.headers.get("Set-Cookie");

    expect(response.status).toBe(200);
    expect(expiredCookie).toContain("tgbot_admin=");
    expect(expiredCookie).toContain("Max-Age=0");

    const sessionResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/session", {
        headers: { Cookie: expiredCookie || "" }
      }),
      adminEnv
    );
    expect(sessionResponse.status).toBe(401);
  });

  it("creates, lists, reveals, disables, and deletes upload API keys", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);

    const createResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "脚本备份任务" })
      }),
      adminEnv
    );
    const createBody = await createResponse.json() as {
      api_key: { id: string; name: string; key: string; masked_key: string; status: string };
    };

    expect(createResponse.status).toBe(201);
    expect(createBody.api_key.name).toBe("脚本备份任务");
    expect(createBody.api_key.key).toMatch(/^tgf_/);
    expect(createBody.api_key.masked_key).toContain("••••");

    const listResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/api-keys", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const listBody = await listResponse.json() as {
      api_keys: Array<{ id: string; key?: string; masked_key: string; status: string }>;
    };
    expect(listBody.api_keys).toHaveLength(1);
    expect(listBody.api_keys[0]?.key).toBeUndefined();

    const detailResponse = await worker.fetch(
      new Request(`https://files.example.com/api/admin/api-keys/${createBody.api_key.id}`, {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const detailBody = await detailResponse.json() as { api_key: { key: string } };
    expect(detailBody.api_key.key).toBe(createBody.api_key.key);

    const patchResponse = await worker.fetch(
      new Request(`https://files.example.com/api/admin/api-keys/${createBody.api_key.id}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ status: "disabled" })
      }),
      adminEnv
    );
    const patchBody = await patchResponse.json() as { api_key: { status: string } };
    expect(patchBody.api_key.status).toBe("disabled");

    const deleteResponse = await worker.fetch(
      new Request(`https://files.example.com/api/admin/api-keys/${createBody.api_key.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const deleteBody = await deleteResponse.json() as { ok: boolean };
    expect(deleteBody.ok).toBe(true);
    expect(db.apiKeys[0]?.deleted_at).not.toBeNull();
  });

  it("uploads from admin UI and writes D1 metadata with a path-only file URL", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-file-id",
              file_unique_id: "tg-unique-id",
              file_name: "hello.txt",
              mime_type: "text/plain",
              file_size: 5
            }
          }
        })
      )
    );
    const cookie = await loginAndGetCookie(adminEnv);
    const upload = uploadRequest({
      token: null,
      remark: "季度报告归档"
    });
    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: { Cookie: cookie },
        body: await upload.formData()
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: { md5: string; file_path: string; remark: string | null; url: string; download_url: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file.md5).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(body.file.file_path).toMatch(/^\/f\//);
    expect(body.file.remark).toBe("季度报告归档");
    expect(body.file.url).toBe(`https://cdn.example.com${body.file.file_path}`);
    expect(body.file.download_url).toBe(`${body.file.url}?download=1`);
    expect(db.files).toHaveLength(1);
    expect(db.files[0]?.file_path).toBe(body.file.file_path);
    expect(db.files[0]?.remark).toBe("季度报告归档");
  });

  it("uploads from admin UI by source URL and infers remote file type", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/download?id=42";
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const inputUrl = String(input);

      if (inputUrl === sourceUrl) {
        return new Response(pngBytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment; filename*=UTF-8''remote%20image"
          }
        });
      }

      return jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "tg-url-file-id",
            file_unique_id: "tg-url-unique-id",
            file_name: "remote image.png",
            mime_type: "application/octet-stream",
            file_size: pngBytes.byteLength
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: sourceUrl,
          remark: "从 URL 导入"
        })
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: { file_name: string; mime_type: string; size: number; remark: string | null; url: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file.file_name).toBe("remote image.png");
    expect(body.file.mime_type).toBe("image/png");
    expect(body.file.size).toBe(pngBytes.byteLength);
    expect(body.file.remark).toBe("从 URL 导入");
    expect(body.file.url).toMatch(/^https:\/\/cdn\.example\.com\/f\//);
    expect(db.files[0]?.mime_type).toBe("image/png");
    expect(db.files[0]?.uploaded_by).toBe("admin");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("initializes a range-based URL multipart upload", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/big-video.mp4";
    const fileSize = 25 * 1024 * 1024;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      if (String(input) === sourceUrl && init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Content-Length": String(fileSize),
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes"
          }
        });
      }

      if (String(input) === sourceUrl && headers.get("Range") === "bytes=0-0") {
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-0/${fileSize}`,
            "Content-Length": "1"
          }
        });
      }

      throw new Error(`Unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/uploads/url/init", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl, remark: "大文件 URL" })
      }),
      adminEnv
    );
    const body = await response.json() as {
      mode: string;
      upload: { id: string; file_name: string; size: number; chunk_count: number };
    };

    expect(response.status).toBe(201);
    expect(body.mode).toBe("multipart");
    expect(body.upload.file_name).toBe("big-video.mp4");
    expect(body.upload.size).toBe(fileSize);
    expect(body.upload.chunk_count).toBe(2);
    expect(db.multipartUploads[0]?.source_url).toBe(sourceUrl);
    expect(db.multipartUploads[0]?.remark).toBe("大文件 URL");
  });

  it("can force a small admin URL upload into multipart mode", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/small-note.txt";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      if (String(input) === sourceUrl && init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Content-Length": "5",
            "Content-Type": "text/plain"
          }
        });
      }

      if (String(input) === sourceUrl && headers.get("Range") === "bytes=0-0") {
        return new Response("h", {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-0/5",
            "Content-Length": "1"
          }
        });
      }

      throw new Error(`Unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/uploads/url/init", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl, force_multipart: true })
      }),
      adminEnv
    );
    const body = await response.json() as {
      mode: string;
      upload: { file_name: string; size: number; chunk_count: number };
    };

    expect(response.status).toBe(201);
    expect(body.mode).toBe("multipart");
    expect(body.upload.file_name).toBe("small-note.txt");
    expect(body.upload.size).toBe(5);
    expect(body.upload.chunk_count).toBe(1);
  });

  it("auto-creates missing directory path for multipart upload sessions", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/uploads/init", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_name: "big.bin",
          mime_type: "application/octet-stream",
          size: 25 * 1024 * 1024,
          directory_path: "/incoming/big"
        })
      }),
      adminEnv
    );
    const body = await response.json() as { upload: { directory_path: string } };

    expect(response.status).toBe(201);
    expect(body.upload.directory_path).toBe("/incoming/big");
    expect(db.directories.map((item) => item.path)).toEqual(["/incoming", "/incoming/big"]);
    expect(db.multipartUploads[0]?.directory_id).toBe(db.directories[1]?.id);
    expect(db.multipartUploads[0]?.directory_path).toBe("/incoming/big");
  });

  it("completes oversized-direct multipart uploads without returning a full file link", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const chunkCount = directAccessMaxChunks + 1;
    const upload: MultipartUploadRecord = {
      id: "upload-large",
      source_kind: "local",
      source_url: null,
      file_name: "large.bin",
      mime_type: "application/octet-stream",
      size: chunkCount * 3,
      chunk_size: 3,
      chunk_count: chunkCount,
      remark: "仅加速下载",
      uploaded_by: "admin",
      created_at: "2026-06-01T00:00:00.000Z",
      completed_at: null,
      directory_id: null,
      directory_path: "/"
    };
    db.multipartUploads.push(upload);
    for (let index = 0; index < chunkCount; index += 1) {
      db.fileChunks.push({
        file_id: upload.id,
        chunk_index: index,
        size: 3,
        md5: `chunk-${index}`,
        telegram_file_id: `tg-chunk-${index}`,
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:00.000Z"
      });
    }

    const response = await worker.fetch(
      new Request(`https://files.example.com/api/admin/uploads/${upload.id}/complete`, {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: {
        file_path: string;
        url: string | null;
        download_url: string | null;
        direct_access: boolean;
        download_strategy: string;
        storage_backend: string;
        chunk_count: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file.file_path).toMatch(/^\/f\//);
    expect(body.file.url).toBeNull();
    expect(body.file.download_url).toBeNull();
    expect(body.file.direct_access).toBe(false);
    expect(body.file.download_strategy).toBe("accelerated");
    expect(body.file.storage_backend).toBe("telegram_multipart");
    expect(body.file.chunk_count).toBe(chunkCount);
    expect(db.files[0]?.file_path).toBe(body.file.file_path);
  });

  it("rejects multipart upload sessions over the limit with human-readable sizes", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const actualFileBytes = maxMultipartFileBytes + 1;
    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/uploads/init", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_name: "too-large.bin",
          mime_type: "application/octet-stream",
          size: actualFileBytes
        })
      }),
      adminEnv
    );
    const body = await response.json() as {
      error: string;
      message: string;
      details: {
        max_file_bytes: number;
        actual_file_bytes: number;
        max_file_size: string;
        actual_file_size: string;
        chunk_size: string;
      };
    };

    expect(response.status).toBe(413);
    expect(body.error).toBe("FileTooLarge");
    expect(body.message).toContain("5G");
    expect(body.message).toContain("5G1B");
    expect(body.details.max_file_bytes).toBe(maxMultipartFileBytes);
    expect(body.details.actual_file_bytes).toBe(actualFileBytes);
    expect(body.details.max_file_size).toBe("5G");
    expect(body.details.actual_file_size).toBe("5G1B");
    expect(body.details.chunk_size).toBe("18MB");
  });

  it("rejects oversized URL multipart sources with compact human-readable sizes", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/huge-video.mp4";
    const actualFileBytes = 1024 ** 4 + 20 * 1024 ** 3;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === sourceUrl && init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Content-Length": String(actualFileBytes),
            "Content-Type": "video/mp4"
          }
        });
      }

      throw new Error(`Unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/uploads/url/init", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl })
      }),
      adminEnv
    );
    const body = await response.json() as {
      error: string;
      message: string;
      details: {
        max_file_bytes: number;
        actual_file_bytes: number;
        max_file_size: string;
        actual_file_size: string;
      };
    };

    expect(response.status).toBe(413);
    expect(body.error).toBe("FileTooLarge");
    expect(body.message).toContain("5G");
    expect(body.message).toContain("1T20G");
    expect(body.details.max_file_bytes).toBe(maxMultipartFileBytes);
    expect(body.details.actual_file_bytes).toBe(actualFileBytes);
    expect(body.details.max_file_size).toBe("5G");
    expect(body.details.actual_file_size).toBe("1T20G");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads an existing signed file URL without fetching the public source URL", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const mp4Bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x02, 0x00,
      0x6d, 0x70, 0x34, 0x32
    ]);
    const token = await createSignedToken(
      {
        v: 1,
        file_id: "original-tg-file-id",
        name: "movie.mp4",
        mime_type: "video/mp4",
        size: mp4Bytes.byteLength,
        iat: 1_768_566_400
      },
      env.LINK_SIGNING_SECRET
    );
    const sourceUrl = `https://files.example.com/f/${token}/movie.mp4`;
    const fetchCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const inputUrl = String(input);
      fetchCalls.push(inputUrl);

      if (inputUrl.includes("/getFile?")) {
        return jsonResponse({
          ok: true,
          result: {
            file_id: "original-tg-file-id",
            file_path: "videos/file_1.mp4",
            file_size: mp4Bytes.byteLength
          }
        });
      }

      if (inputUrl.includes("/file/bot")) {
        return new Response(mp4Bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(mp4Bytes.byteLength)
          }
        });
      }

      return jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "copied-tg-file-id",
            file_name: "movie.mp4",
            mime_type: "application/octet-stream",
            file_size: mp4Bytes.byteLength
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl })
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: { file_name: string; mime_type: string; size: number };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file.file_name).toBe("movie.mp4");
    expect(body.file.mime_type).toBe("video/mp4");
    expect(body.file.size).toBe(mp4Bytes.byteLength);
    expect(fetchCalls).not.toContain(sourceUrl);
    expect(fetchCalls).toEqual([
      "https://api.telegram.org/bot123456:test-token/getFile?file_id=original-tg-file-id",
      "https://api.telegram.org/file/bot123456:test-token/videos/file_1.mp4",
      "https://api.telegram.org/bot123456:test-token/sendDocument"
    ]);
  });

  it("rejects unsupported source URL protocols before fetching", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: "file:///etc/passwd" })
      }),
      adminEnv
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("InvalidUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists and hard-deletes D1 file records", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push({
      id: "file-1",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      size: 12,
      md5: "abc123",
      telegram_file_id: "tg-file-id",
      telegram_file_unique_id: "tg-unique-id",
      file_path: "/f/token/report.pdf",
      remark: "季度归档资料",
      uploaded_by: "admin",
      created_at: "2026-05-27T00:00:00.000Z",
      deleted_at: null
    });
    db.fileChunks.push({
      file_id: "file-1",
      chunk_index: 0,
      size: 12,
      md5: "chunk-md5",
      telegram_file_id: "tg-chunk-id",
      telegram_file_unique_id: null,
      created_at: "2026-05-27T00:00:00.000Z"
    });
    const cookie = await loginAndGetCookie(adminEnv);

    const listResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?q=季度", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const listBody = await listResponse.json() as {
      files: Array<{ remark: string | null; url: string }>;
      pagination: { total: number };
    };
    expect(listBody.pagination.total).toBe(1);
    expect(listBody.files[0]?.url).toBe("https://cdn.example.com/f/token/report.pdf");
    expect(listBody.files[0]?.remark).toBe("季度归档资料");

    const deleteResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files/file-1", {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const deleteBody = await deleteResponse.json() as { ok: boolean };
    expect(deleteBody.ok).toBe(true);
    expect(db.files).toHaveLength(0);
    expect(db.fileChunks).toHaveLength(0);

    const afterDeleteResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const afterDeleteBody = await afterDeleteResponse.json() as { pagination: { total: number } };
    expect(afterDeleteBody.pagination.total).toBe(0);
  });

  it("filters D1 file records by filename, remark, type and upload time", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(
      {
        id: "file-image",
        file_name: "photo.png",
        mime_type: "image/png",
        size: 10,
        md5: "photo-md5",
        telegram_file_id: "tg-image",
        telegram_file_unique_id: null,
        file_path: "/f/token/photo.png",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-05-27T02:00:00.000Z",
        deleted_at: null
      },
      {
        id: "file-text",
        file_name: "notes.txt",
        mime_type: "text/plain",
        size: 20,
        md5: "notes-md5",
        telegram_file_id: "tg-text",
        telegram_file_unique_id: null,
        file_path: "/f/token/notes.txt",
        remark: "会议记录",
        uploaded_by: "admin",
        created_at: "2026-05-28T02:00:00.000Z",
        deleted_at: null
      },
      {
        id: "file-pdf",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        size: 30,
        md5: "report-md5",
        telegram_file_id: "tg-pdf",
        telegram_file_unique_id: null,
        file_path: "/f/token/report.pdf",
        remark: "季度归档资料",
        uploaded_by: "admin",
        created_at: "2026-05-25T02:00:00.000Z",
        deleted_at: null
      },
      {
        id: "file-bin",
        file_name: "payload.bin",
        mime_type: "application/octet-stream",
        size: 40,
        md5: "季度-md5",
        telegram_file_id: "季度-tg-id",
        telegram_file_unique_id: null,
        file_path: "/f/token/payload.bin",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-05-28T03:00:00.000Z",
        deleted_at: null
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const remarkResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?q=季度", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const remarkBody = await remarkResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(remarkBody.pagination.total).toBe(1);
    expect(remarkBody.files[0]?.id).toBe("file-pdf");

    const imageResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?type=image", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const imageBody = await imageResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(imageBody.pagination.total).toBe(1);
    expect(imageBody.files[0]?.id).toBe("file-image");

    const dateResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?created_from=2026-05-28T00%3A00%3A00.000Z&type=text", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const dateBody = await dateResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(dateBody.pagination.total).toBe(1);
    expect(dateBody.files[0]?.id).toBe("file-text");
  });

  it("updates file name and remark, and regenerates the admin file link only when renamed", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push({
      id: "file-edit",
      file_name: "old.txt",
      mime_type: "text/plain",
      size: 8,
      md5: "old-md5",
      telegram_file_id: "tg-edit",
      telegram_file_unique_id: null,
      file_path: "/f/old-token/old.txt",
      remark: "旧备注",
      uploaded_by: "admin",
      created_at: "2026-06-01T00:00:00.000Z",
      deleted_at: null,
      directory_id: null,
      directory_path: "/"
    });
    const cookie = await loginAndGetCookie(adminEnv);

    const remarkResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files/file-edit", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ remark: "新备注" })
      }),
      adminEnv
    );
    const remarkBody = await remarkResponse.json() as {
      file: { file_name: string; remark: string | null; file_path: string; url: string };
    };
    expect(remarkResponse.status).toBe(200);
    expect(remarkBody.file).toMatchObject({
      file_name: "old.txt",
      remark: "新备注",
      file_path: "/f/old-token/old.txt",
      url: "https://cdn.example.com/f/old-token/old.txt"
    });

    const renameResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files/file-edit", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ file_name: "new name.txt", remark: "" })
      }),
      adminEnv
    );
    const renameBody = await renameResponse.json() as {
      file: { file_name: string; remark: string | null; file_path: string; url: string; download_url: string };
    };
    const token = renameBody.file.file_path.split("/")[2] || "";
    const payload = await verifySignedToken(token, env.LINK_SIGNING_SECRET);

    expect(renameResponse.status).toBe(200);
    expect(renameBody.file.file_name).toBe("new name.txt");
    expect(renameBody.file.remark).toBeNull();
    expect(renameBody.file.file_path).toMatch(/^\/f\/.+\/new%20name\.txt$/);
    expect(renameBody.file.file_path).not.toBe("/f/old-token/old.txt");
    expect(renameBody.file.url).toBe(`https://cdn.example.com${renameBody.file.file_path}`);
    expect(renameBody.file.download_url).toBe(`${renameBody.file.url}?download=1`);
    expect(payload).toMatchObject({
      v: 1,
      file_id: "tg-edit",
      name: "new name.txt",
      mime_type: "text/plain",
      size: 8
    });
    expect(db.files[0]).toMatchObject({
      file_name: "new name.txt",
      remark: null,
      file_path: renameBody.file.file_path
    });
  });

  it("creates virtual directories, moves files, searches current directory, and recursively hard-deletes directories", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(
      {
        id: "file-root",
        file_name: "root.txt",
        mime_type: "text/plain",
        size: 5,
        md5: "root-md5",
        telegram_file_id: "tg-root",
        telegram_file_unique_id: null,
        file_path: "/f/token/root.txt",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:00:00.000Z",
        deleted_at: null,
        directory_id: null,
        directory_path: "/"
      },
      {
        id: "file-trip",
        file_name: "旅行照片.jpg",
        mime_type: "image/jpeg",
        size: 10,
        md5: "trip-md5",
        telegram_file_id: "tg-trip",
        telegram_file_unique_id: null,
        file_path: "/f/token/trip.jpg",
        remark: "子目录文件",
        uploaded_by: "admin",
        created_at: "2026-06-01T00:01:00.000Z",
        deleted_at: null,
        directory_id: "dir-child",
        directory_path: "/photos/2026"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const createResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/directories", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ parent_path: "/", name: "photos" })
      }),
      adminEnv
    );
    const createBody = await createResponse.json() as { directory: { id: string; path: string } };
    db.directories.push({
      id: "dir-child",
      parent_id: createBody.directory.id,
      name: "2026",
      path: "/photos/2026",
      created_at: "2026-06-01T00:02:00.000Z",
      deleted_at: null
    });

    expect(createResponse.status).toBe(201);
    expect(createBody.directory.path).toBe("/photos");

    const rootListResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?dir=/", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const rootListBody = await rootListResponse.json() as {
      directories: Array<{ path: string; file_count: number; total_size: number }>;
      files: Array<{ id: string; directory_path: string }>;
      pagination: { total: number };
      global_stats: { file_count: number; total_size: number };
    };
    expect(rootListBody.directories.map((item) => item.path)).toEqual(["/photos"]);
    expect(rootListBody.directories[0]).toMatchObject({
      file_count: 1,
      total_size: 10
    });
    expect(rootListBody.files.map((item) => item.id)).toEqual(["file-root"]);
    expect(rootListBody.pagination.total).toBe(1);
    expect(rootListBody.global_stats).toEqual({
      file_count: 2,
      total_size: 15
    });

    const rootSearchResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?dir=/&q=%E6%97%85%E8%A1%8C", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const rootSearchBody = await rootSearchResponse.json() as {
      files: Array<{ id: string; directory_path: string }>;
      pagination: { total: number };
    };
    expect(rootSearchBody.pagination.total).toBe(0);
    expect(rootSearchBody.files).toHaveLength(0);

    const childSearchResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files?dir=/photos/2026&q=%E6%97%85%E8%A1%8C", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const childSearchBody = await childSearchResponse.json() as {
      files: Array<{ id: string; directory_path: string }>;
      pagination: { total: number };
    };
    expect(childSearchBody.pagination.total).toBe(1);
    expect(childSearchBody.files[0]).toMatchObject({ id: "file-trip", directory_path: "/photos/2026" });

    const moveResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/files/move", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ file_ids: ["file-root"], directory_path: "/photos" })
      }),
      adminEnv
    );
    const moveBody = await moveResponse.json() as { moved: number; directory_path: string };
    expect(moveBody).toMatchObject({ moved: 1, directory_path: "/photos" });
    expect(db.files.find((item) => item.id === "file-root")?.directory_path).toBe("/photos");

    const deleteResponse = await worker.fetch(
      new Request(`https://files.example.com/api/admin/directories/${createBody.directory.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const deleteBody = await deleteResponse.json() as { deleted_directories: number; deleted_files: number };
    expect(deleteBody.deleted_directories).toBe(2);
    expect(deleteBody.deleted_files).toBe(2);
    expect(db.files).toHaveLength(0);
    expect(db.directories).toHaveLength(0);
  });

  it("deletes directory trees without touching case-different sibling paths", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.directories.push(
      {
        id: "dir-upper",
        parent_id: null,
        name: "AImage",
        path: "/AImage",
        created_at: "2026-06-01T00:00:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-upper-child",
        parent_id: "dir-upper",
        name: "raw",
        path: "/AImage/raw",
        created_at: "2026-06-01T00:01:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-lower",
        parent_id: null,
        name: "aimage",
        path: "/aimage",
        created_at: "2026-06-01T00:02:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-lower-child",
        parent_id: "dir-lower",
        name: "raw",
        path: "/aimage/raw",
        created_at: "2026-06-01T00:03:00.000Z",
        deleted_at: null
      }
    );
    db.files.push(
      {
        id: "file-upper",
        file_name: "upper.jpg",
        mime_type: "image/jpeg",
        size: 1,
        md5: "upper-md5",
        telegram_file_id: "tg-upper",
        telegram_file_unique_id: null,
        file_path: "/f/token/upper.jpg",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:04:00.000Z",
        deleted_at: null,
        directory_id: "dir-upper",
        directory_path: "/AImage"
      },
      {
        id: "file-upper-child",
        file_name: "upper-raw.jpg",
        mime_type: "image/jpeg",
        size: 1,
        md5: "upper-child-md5",
        telegram_file_id: "tg-upper-child",
        telegram_file_unique_id: null,
        file_path: "/f/token/upper-raw.jpg",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:05:00.000Z",
        deleted_at: null,
        directory_id: "dir-upper-child",
        directory_path: "/AImage/raw"
      },
      {
        id: "file-lower",
        file_name: "lower.jpg",
        mime_type: "image/jpeg",
        size: 1,
        md5: "lower-md5",
        telegram_file_id: "tg-lower",
        telegram_file_unique_id: null,
        file_path: "/f/token/lower.jpg",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:06:00.000Z",
        deleted_at: null,
        directory_id: "dir-lower",
        directory_path: "/aimage"
      },
      {
        id: "file-lower-child",
        file_name: "lower-raw.jpg",
        mime_type: "image/jpeg",
        size: 1,
        md5: "lower-child-md5",
        telegram_file_id: "tg-lower-child",
        telegram_file_unique_id: null,
        file_path: "/f/token/lower-raw.jpg",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:07:00.000Z",
        deleted_at: null,
        directory_id: "dir-lower-child",
        directory_path: "/aimage/raw"
      }
    );
    db.fileChunks.push(
      {
        file_id: "file-upper",
        chunk_index: 0,
        size: 1,
        md5: "upper-chunk-md5",
        telegram_file_id: "tg-upper-chunk",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:08:00.000Z"
      },
      {
        file_id: "file-lower",
        chunk_index: 0,
        size: 1,
        md5: "lower-chunk-md5",
        telegram_file_id: "tg-lower-chunk",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:09:00.000Z"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/directories/dir-upper", {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as { deleted_directories: number; deleted_files: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      deleted_directories: 2,
      deleted_files: 2
    });
    expect(db.directories.find((item) => item.id === "dir-upper")).toBeUndefined();
    expect(db.directories.find((item) => item.id === "dir-upper-child")).toBeUndefined();
    expect(db.files.find((item) => item.id === "file-upper")).toBeUndefined();
    expect(db.files.find((item) => item.id === "file-upper-child")).toBeUndefined();
    expect(db.fileChunks.find((item) => item.file_id === "file-upper")).toBeUndefined();
    expect(db.fileChunks.find((item) => item.file_id === "file-lower")).toBeDefined();
    expect(db.directories.find((item) => item.id === "dir-lower")?.deleted_at).toBeNull();
    expect(db.directories.find((item) => item.id === "dir-lower-child")?.deleted_at).toBeNull();
    expect(db.files.find((item) => item.id === "file-lower")?.deleted_at).toBeNull();
    expect(db.files.find((item) => item.id === "file-lower-child")?.deleted_at).toBeNull();
  });

  it("moves a directory tree to another parent directory", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.directories.push(
      {
        id: "dir-archive",
        parent_id: null,
        name: "archive",
        path: "/archive",
        created_at: "2026-06-01T00:00:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-photos",
        parent_id: null,
        name: "photos",
        path: "/photos",
        created_at: "2026-06-01T00:01:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-child",
        parent_id: "dir-photos",
        name: "2026",
        path: "/photos/2026",
        created_at: "2026-06-01T00:02:00.000Z",
        deleted_at: null
      }
    );
    db.files.push(
      {
        id: "file-root-photo",
        file_name: "cover.jpg",
        mime_type: "image/jpeg",
        size: 1,
        md5: "cover-md5",
        telegram_file_id: "tg-cover",
        telegram_file_unique_id: null,
        file_path: "/f/token/cover.jpg",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:03:00.000Z",
        deleted_at: null,
        directory_id: "dir-photos",
        directory_path: "/photos"
      },
      {
        id: "file-child-photo",
        file_name: "trip.jpg",
        mime_type: "image/jpeg",
        size: 1,
        md5: "trip-md5",
        telegram_file_id: "tg-trip",
        telegram_file_unique_id: null,
        file_path: "/f/token/trip.jpg",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:04:00.000Z",
        deleted_at: null,
        directory_id: "dir-child",
        directory_path: "/photos/2026"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await worker.fetch(
      new Request("https://files.example.com/api/admin/directories/dir-photos/move", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ parent_path: "/archive" })
      }),
      adminEnv
    );
    const body = await response.json() as {
      directory: { id: string; parent_id: string | null; path: string };
      moved_directories: number;
      moved_files: number;
    };

    expect(response.status).toBe(200);
    expect(body.directory).toMatchObject({
      id: "dir-photos",
      parent_id: "dir-archive",
      path: "/archive/photos"
    });
    expect(body.moved_directories).toBe(2);
    expect(body.moved_files).toBe(2);
    expect(db.directories.find((item) => item.id === "dir-photos")).toMatchObject({
      parent_id: "dir-archive",
      path: "/archive/photos"
    });
    expect(db.directories.find((item) => item.id === "dir-child")?.path).toBe("/archive/photos/2026");
    expect(db.files.find((item) => item.id === "file-root-photo")?.directory_path).toBe("/archive/photos");
    expect(db.files.find((item) => item.id === "file-child-photo")?.directory_path).toBe("/archive/photos/2026");

    const invalidResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/directories/dir-photos/move", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ parent_path: "/archive/photos/2026" })
      }),
      adminEnv
    );
    const invalidBody = await invalidResponse.json() as { error: string };
    expect(invalidResponse.status).toBe(400);
    expect(invalidBody.error).toBe("InvalidDirectoryMove");

    const renameResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/directories/dir-photos", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "images" })
      }),
      adminEnv
    );
    const renameBody = await renameResponse.json() as {
      directory: { id: string; name: string; path: string };
      renamed_directories: number;
      updated_files: number;
    };
    expect(renameResponse.status).toBe(200);
    expect(renameBody.directory).toMatchObject({
      id: "dir-photos",
      name: "images",
      path: "/archive/images"
    });
    expect(renameBody.renamed_directories).toBe(2);
    expect(renameBody.updated_files).toBe(2);
    expect(db.directories.find((item) => item.id === "dir-photos")).toMatchObject({
      name: "images",
      path: "/archive/images"
    });
    expect(db.directories.find((item) => item.id === "dir-child")?.path).toBe("/archive/images/2026");
    expect(db.files.find((item) => item.id === "file-root-photo")?.directory_path).toBe("/archive/images");
    expect(db.files.find((item) => item.id === "file-child-photo")?.directory_path).toBe("/archive/images/2026");
  });

  it("moves and deletes selected files and directories together", async () => {
    const db = new FakeD1();
    const adminEnv: Env = {
      ...env,
      FILES_DB: db as unknown as D1Database,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.directories.push(
      {
        id: "dir-archive",
        parent_id: null,
        name: "archive",
        path: "/archive",
        created_at: "2026-06-01T00:00:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-docs",
        parent_id: null,
        name: "docs",
        path: "/docs",
        created_at: "2026-06-01T00:01:00.000Z",
        deleted_at: null
      },
      {
        id: "dir-docs-child",
        parent_id: "dir-docs",
        name: "drafts",
        path: "/docs/drafts",
        created_at: "2026-06-01T00:02:00.000Z",
        deleted_at: null
      }
    );
    db.files.push(
      {
        id: "file-root",
        file_name: "root.txt",
        mime_type: "text/plain",
        size: 1,
        md5: "root-md5",
        telegram_file_id: "tg-root",
        telegram_file_unique_id: null,
        file_path: "/f/token/root.txt",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:03:00.000Z",
        deleted_at: null,
        directory_id: null,
        directory_path: "/"
      },
      {
        id: "file-draft",
        file_name: "draft.txt",
        mime_type: "text/plain",
        size: 1,
        md5: "draft-md5",
        telegram_file_id: "tg-draft",
        telegram_file_unique_id: null,
        file_path: "/f/token/draft.txt",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:04:00.000Z",
        deleted_at: null,
        directory_id: "dir-docs-child",
        directory_path: "/docs/drafts"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const moveResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/entries/move", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_ids: ["file-root"],
          directory_ids: ["dir-docs"],
          directory_path: "/archive"
        })
      }),
      adminEnv
    );
    const moveBody = await moveResponse.json() as {
      moved: number;
      moved_directories: number;
      moved_files: number;
      directory_path: string;
    };

    expect(moveResponse.status).toBe(200);
    expect(moveBody).toMatchObject({
      moved: 4,
      moved_directories: 2,
      moved_files: 2,
      directory_path: "/archive"
    });
    expect(db.directories.find((item) => item.id === "dir-docs")?.path).toBe("/archive/docs");
    expect(db.directories.find((item) => item.id === "dir-docs-child")?.path).toBe("/archive/docs/drafts");
    expect(db.files.find((item) => item.id === "file-root")?.directory_path).toBe("/archive");
    expect(db.files.find((item) => item.id === "file-draft")?.directory_path).toBe("/archive/docs/drafts");

    const deleteResponse = await worker.fetch(
      new Request("https://files.example.com/api/admin/entries/delete", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_ids: ["file-root"],
          directory_ids: ["dir-docs"]
        })
      }),
      adminEnv
    );
    const deleteBody = await deleteResponse.json() as {
      deleted_directories: number;
      deleted_files: number;
    };

    expect(deleteResponse.status).toBe(200);
    expect(deleteBody).toMatchObject({
      deleted_directories: 2,
      deleted_files: 2
    });
    expect(db.files.find((item) => item.id === "file-root")).toBeUndefined();
    expect(db.files.find((item) => item.id === "file-draft")).toBeUndefined();
    expect(db.directories.find((item) => item.id === "dir-archive")?.deleted_at).toBeNull();
    expect(db.directories.find((item) => item.id === "dir-docs")).toBeUndefined();
    expect(db.directories.find((item) => item.id === "dir-docs-child")).toBeUndefined();
  });

});

async function loginAndGetCookie(envWithAdmin: Env): Promise<string> {
  const response = await worker.fetch(
    new Request("https://files.example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: "secret" })
    }),
    envWithAdmin
  );
  const cookie = response.headers.get("Set-Cookie");

  if (!cookie) {
    throw new Error("Expected admin login cookie");
  }

  return cookie;
}
