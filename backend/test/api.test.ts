import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, runScheduledCleanup } from "../src/index";
import type { AppDatabase, AppEnv, AppPreparedStatement, AppResult, AppResultMeta } from "../src/runtime";
import { createSignedToken, verifySignedToken } from "../src/crypto";
import type {
  ApiKeyRecord,
  ApiKeyStatus,
  DirectoryRecord,
  FileChunkRecord,
  FileRecord,
  HlsAssetRecord,
  HlsSegmentRecord,
  MagnetImportRecord,
  MultipartUploadRecord,
  TelegramChannelRecord
} from "../src/database";

const uploadApiKey = "upload-secret";
const AppEnv: AppEnv = {
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_STORAGE_CHAT_ID: "-1001234567890",
  LINK_SIGNING_SECRET: "link-secret",
  MAX_FILE_BYTES: "20971520"
};
const formerDirectAccessMaxChunks = 20;
const telegramChunkSizeBytes = 10 * 1024 * 1024;
const maxMultipartFileBytes = 20 * 1024 * 1024 * 1024;
const directAccessMaxChunks = Math.ceil(maxMultipartFileBytes / telegramChunkSizeBytes);

class FakeDatabase {
  readonly directories: DirectoryRecord[] = [];
  readonly files: FileRecord[] = [];
  readonly apiKeys: ApiKeyRecord[] = [];
  readonly telegramChannels: TelegramChannelRecord[] = [];
  readonly multipartUploads: MultipartUploadRecord[] = [];
  readonly fileChunks: FileChunkRecord[] = [];
  readonly hlsAssets: HlsAssetRecord[] = [];
  readonly hlsSegments: HlsSegmentRecord[] = [];
  readonly magnetImports: MagnetImportRecord[] = [];
  readonly appSettings = new Map<string, string>();
  batchCalls = 0;

  prepare(sql: string): AppPreparedStatement {
    return new FakeDatabaseStatement(this, sql) as unknown as AppPreparedStatement;
  }

  async batch<T = unknown>(statements: AppPreparedStatement[]): Promise<AppResult<T>[]> {
    this.batchCalls += 1;
    const snapshots = {
      directories: this.directories.map((item) => ({ ...item })),
      files: this.files.map((item) => ({ ...item })),
      apiKeys: this.apiKeys.map((item) => ({ ...item })),
      telegramChannels: this.telegramChannels.map((item) => ({ ...item })),
      multipartUploads: this.multipartUploads.map((item) => ({ ...item })),
      fileChunks: this.fileChunks.map((item) => ({ ...item })),
      hlsAssets: this.hlsAssets.map((item) => ({ ...item })),
      hlsSegments: this.hlsSegments.map((item) => ({ ...item })),
      magnetImports: this.magnetImports.map((item) => ({ ...item })),
      appSettings: new Map(this.appSettings)
    };
    const results: AppResult<T>[] = [];

    try {
      for (const statement of statements) {
        const result = await (statement as unknown as { run: () => Promise<AppResult<T>> }).run();
        results.push(result);
      }
    } catch (error) {
      this.directories.splice(0, this.directories.length, ...snapshots.directories);
      this.files.splice(0, this.files.length, ...snapshots.files);
      this.apiKeys.splice(0, this.apiKeys.length, ...snapshots.apiKeys);
      this.telegramChannels.splice(0, this.telegramChannels.length, ...snapshots.telegramChannels);
      this.multipartUploads.splice(0, this.multipartUploads.length, ...snapshots.multipartUploads);
      this.fileChunks.splice(0, this.fileChunks.length, ...snapshots.fileChunks);
      this.hlsAssets.splice(0, this.hlsAssets.length, ...snapshots.hlsAssets);
      this.hlsSegments.splice(0, this.hlsSegments.length, ...snapshots.hlsSegments);
      this.magnetImports.splice(0, this.magnetImports.length, ...snapshots.magnetImports);
      this.appSettings.clear();
      for (const [key, value] of snapshots.appSettings) this.appSettings.set(key, value);
      throw error;
    }

    return results;
  }
}

class FakeDatabaseStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FakeDatabase,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): FakeDatabaseStatement {
    this.bindings = values;
    return this;
  }

  async run(): Promise<AppResult> {
    const normalizedSql = this.sql.trim().toUpperCase();
    let changes = 0;

    if (normalizedSql.startsWith("INSERT INTO FILES")) {
      const [
        id,
        fileName,
        mimeType,
        size,
        md5,
        telegramFileId,
        telegramFileUniqueId,
        telegramChannelId,
        filePath,
        remark,
        uploadedBy,
        createdAt,
        directoryId,
        directoryPath
      ] = this.bindings;
      const storageBackend = this.bindings[14] === "telegram_multipart"
        ? "telegram_multipart"
        : this.bindings[14] === "hls_package"
          ? "hls_package"
          : "telegram_single";

      this.db.files.push({
        id: String(id),
        file_name: String(fileName),
        mime_type: String(mimeType),
        size: Number(size),
        md5: String(md5),
        telegram_file_id: String(telegramFileId),
        telegram_file_unique_id: telegramFileUniqueId === null ? null : String(telegramFileUniqueId),
        telegram_channel_id: String(telegramChannelId || "default"),
        file_path: String(filePath),
        remark: remark === null ? null : String(remark),
        uploaded_by: uploadedBy === null ? null : String(uploadedBy),
        created_at: String(createdAt),
        deleted_at: null,
        directory_id: directoryId === null ? null : String(directoryId),
        directory_path: String(directoryPath || "/"),
        storage_backend: storageBackend,
        chunk_size: this.bindings[15] === null ? null : Number(this.bindings[15]),
        chunk_count: this.bindings[16] === null ? null : Number(this.bindings[16]),
        thumbnail_file_id: this.bindings[17] === null ? null : String(this.bindings[17]),
        thumbnail_file_unique_id: this.bindings[18] === null ? null : String(this.bindings[18]),
        thumbnail_file_path: this.bindings[19] === null ? null : String(this.bindings[19]),
        thumbnail_mime_type: this.bindings[20] === null ? null : String(this.bindings[20]),
        thumbnail_size: this.bindings[21] === null ? null : Number(this.bindings[21]),
        thumbnail_width: this.bindings[22] === null ? null : Number(this.bindings[22]),
        thumbnail_height: this.bindings[23] === null ? null : Number(this.bindings[23]),
        thumbnail_status: this.bindings[24] === "ready" || this.bindings[24] === "failed" ? this.bindings[24] : "none"
      });
      changes = 1;
    }

    if (normalizedSql.startsWith("INSERT INTO MULTIPART_UPLOADS")) {
      const [
        id,
        sourceKind,
        sourceUrl,
        sourceHeadersJson,
        sourceRangeStart,
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
        source_headers_json: sourceHeadersJson === null ? null : String(sourceHeadersJson),
        source_range_start: sourceRangeStart === null ? null : Number(sourceRangeStart),
        file_name: String(fileName),
        mime_type: String(mimeType),
        size: Number(size),
        chunk_size: Number(chunkSize),
        chunk_count: Number(chunkCount),
        remark: remark === null ? null : String(remark),
        uploaded_by: uploadedBy === null ? null : String(uploadedBy),
        created_at: String(createdAt),
        directory_id: this.bindings[13] === null ? null : String(this.bindings[13]),
        directory_path: String(this.bindings[14] || "/"),
        telegram_channel_group: String(this.bindings[15] || "default"),
        completed_at: null
      });
      changes = 1;
    }

    if (normalizedSql.startsWith("INSERT INTO HLS_ASSETS")) {
      const [
        id,
        sourceUrl,
        sourceHeadersJson,
        mediaPlaylistUrl,
        fileName,
        mimeType,
        directoryId,
        directoryPath,
        status,
        selectedVariantId,
        targetDurationSeconds,
        durationSeconds,
        segmentCount,
        estimatedSize,
        playlistText,
        initSourceUrl,
        initByteRangeStart,
        initByteRangeLength,
        initMimeType,
        initStatus,
        remark,
        uploadedBy,
        createdAt,
        updatedAt
      ] = this.bindings;

      this.db.hlsAssets.push({
        id: String(id),
        source_url: String(sourceUrl),
        source_headers_json: sourceHeadersJson === null ? null : String(sourceHeadersJson),
        media_playlist_url: String(mediaPlaylistUrl),
        file_name: String(fileName),
        mime_type: String(mimeType),
        directory_id: directoryId === null ? null : String(directoryId),
        directory_path: String(directoryPath || "/"),
        status: status as HlsAssetRecord["status"],
        selected_variant_id: selectedVariantId === null ? null : String(selectedVariantId),
        target_duration_seconds: Number(targetDurationSeconds),
        duration_seconds: Number(durationSeconds),
        segment_count: Number(segmentCount),
        estimated_size: estimatedSize === null ? null : Number(estimatedSize),
        playlist_text: String(playlistText),
        playlist_file_id: null,
        final_file_id: null,
        init_source_url: initSourceUrl === null ? null : String(initSourceUrl),
        init_byte_range_start: initByteRangeStart === null ? null : Number(initByteRangeStart),
        init_byte_range_length: initByteRangeLength === null ? null : Number(initByteRangeLength),
        init_mime_type: initMimeType === null ? null : String(initMimeType),
        init_size: null,
        init_storage_backend: null,
        init_telegram_file_id: null,
        init_telegram_file_unique_id: null,
        init_telegram_channel_id: "default",
        init_status: initStatus as HlsAssetRecord["init_status"],
        init_error_message: null,
        init_completed_at: null,
        thumbnail_status: "none",
        remark: remark === null ? null : String(remark),
        uploaded_by: uploadedBy === null ? null : String(uploadedBy),
        created_at: String(createdAt),
        updated_at: String(updatedAt),
        completed_at: null,
        deleted_at: null
      });
      changes = 1;
    }

    if (normalizedSql.startsWith("INSERT INTO HLS_SEGMENTS")) {
      const [
        id,
        assetId,
        variantId,
        segmentIndex,
        sourceUrl,
        byteRangeStart,
        byteRangeLength,
        durationSeconds,
        mimeType,
        size,
        status,
        createdAt,
        updatedAt
      ] = this.bindings;

      this.db.hlsSegments.push({
        id: String(id),
        asset_id: String(assetId),
        variant_id: String(variantId),
        segment_index: Number(segmentIndex),
        source_url: String(sourceUrl),
        byte_range_start: byteRangeStart === null ? null : Number(byteRangeStart),
        byte_range_length: byteRangeLength === null ? null : Number(byteRangeLength),
        duration_seconds: Number(durationSeconds),
        mime_type: String(mimeType),
        size: size === null ? null : Number(size),
        storage_backend: null,
        telegram_file_id: null,
        telegram_file_unique_id: null,
        telegram_channel_id: "default",
        multipart_upload_id: null,
        chunk_size: null,
        chunk_count: null,
        status: status as HlsSegmentRecord["status"],
        attempts: 0,
        error_message: null,
        created_at: String(createdAt),
        updated_at: String(updatedAt),
        completed_at: null
      });
      changes = 1;
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
      changes = 1;
    }

    if (normalizedSql.startsWith("INSERT OR REPLACE INTO FILE_CHUNKS")) {
      const [fileId, chunkIndex, size, md5, telegramFileId, telegramFileUniqueId, telegramChannelId, createdAt] = this.bindings;
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
        telegram_channel_id: String(telegramChannelId || "default"),
        created_at: String(createdAt)
      };

      if (existingIndex >= 0) {
        this.db.fileChunks[existingIndex] = chunk;
      } else {
        this.db.fileChunks.push(chunk);
      }
      changes = 1;
    }

    if (normalizedSql.startsWith("INSERT INTO TELEGRAM_CHANNELS")) {
      const [id, name, botTokenEncrypted, botTokenHash, chatId, status, isDefault, createdAt, updatedAt] = this.bindings;

      this.db.telegramChannels.push({
        id: String(id),
        name: String(name),
        bot_token_encrypted: String(botTokenEncrypted),
        bot_token_hash: String(botTokenHash),
        chat_id: String(chatId),
        status: status === "disabled" ? "disabled" : "active",
        is_default: Number(isDefault),
        created_at: String(createdAt),
        updated_at: String(updatedAt)
      });
      changes = 1;
    }

    if (normalizedSql.startsWith("UPDATE TELEGRAM_CHANNELS")) {
      const [name, botTokenEncrypted, botTokenHash, chatId, status, updatedAt, id] = this.bindings;
      const channel = this.db.telegramChannels.find((item) => item.id === id);
      if (channel) {
        channel.name = String(name);
        channel.bot_token_encrypted = String(botTokenEncrypted);
        channel.bot_token_hash = String(botTokenHash);
        channel.chat_id = String(chatId);
        channel.status = status === "disabled" ? "disabled" : "active";
        channel.updated_at = String(updatedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("DELETE FROM TELEGRAM_CHANNELS")) {
      const id = String(this.bindings[0]);
      const before = this.db.telegramChannels.length;
      this.deleteWhere(this.db.telegramChannels, (channel) => channel.id === id && channel.is_default !== 1);
      changes = before - this.db.telegramChannels.length;
    }

    if (normalizedSql.startsWith("INSERT INTO APP_SETTINGS")) {
      const [key, value] = this.bindings;
      this.db.appSettings.set(String(key), String(value));
      changes = 1;
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
      changes = 1;
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

    if (normalizedSql.startsWith("UPDATE FILES") && normalizedSql.includes("SET") && normalizedSql.includes("THUMBNAIL_FILE_ID")) {
      const [
        thumbnailFileId,
        thumbnailFileUniqueId,
        thumbnailFilePath,
        thumbnailMimeType,
        thumbnailSize,
        thumbnailWidth,
        thumbnailHeight,
        thumbnailStatus,
        id
      ] = this.bindings;
      const file = this.db.files.find((item) => item.id === id && item.deleted_at === null);
      if (file) {
        file.thumbnail_file_id = thumbnailFileId === null ? null : String(thumbnailFileId);
        file.thumbnail_file_unique_id = thumbnailFileUniqueId === null ? null : String(thumbnailFileUniqueId);
        file.thumbnail_file_path = thumbnailFilePath === null ? null : String(thumbnailFilePath);
        file.thumbnail_mime_type = thumbnailMimeType === null ? null : String(thumbnailMimeType);
        file.thumbnail_size = thumbnailSize === null ? null : Number(thumbnailSize);
        file.thumbnail_width = thumbnailWidth === null ? null : Number(thumbnailWidth);
        file.thumbnail_height = thumbnailHeight === null ? null : Number(thumbnailHeight);
        file.thumbnail_status = thumbnailStatus === "ready" || thumbnailStatus === "failed" ? thumbnailStatus : "none";
        changes = 1;
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

    if (normalizedSql.startsWith("UPDATE HLS_ASSETS") && normalizedSql.includes("SET STATUS = ?")) {
      const status = String(this.bindings[0]);
      const updatedAt = String(this.bindings[1]);
      const id = String(this.bindings[2]);
      const asset = this.db.hlsAssets.find((item) => item.id === id && item.deleted_at === null);
      if (asset) {
        asset.status = status as HlsAssetRecord["status"];
        asset.updated_at = updatedAt;
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_ASSETS") && normalizedSql.includes("SET STATUS = 'DONE'")) {
      const [finalFileId, updatedAt, completedAt, id] = this.bindings;
      const asset = this.db.hlsAssets.find((item) => item.id === id && item.deleted_at === null);
      if (asset) {
        asset.status = "done";
        asset.final_file_id = String(finalFileId);
        asset.source_headers_json = null;
        asset.updated_at = String(updatedAt);
        asset.completed_at = String(completedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_ASSETS") && normalizedSql.includes("SET INIT_STATUS = 'IMPORTING'")) {
      const [updatedAt, id] = this.bindings;
      const asset = this.db.hlsAssets.find((item) => item.id === id && item.deleted_at === null);
      if (asset) {
        asset.init_status = "importing";
        asset.init_error_message = null;
        asset.updated_at = String(updatedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_ASSETS") && normalizedSql.includes("SET INIT_STATUS = 'DONE'")) {
      const [mimeType, size, telegramFileId, telegramFileUniqueId, telegramChannelId, updatedAt, completedAt, id] = this.bindings;
      const asset = this.db.hlsAssets.find((item) => item.id === id && item.deleted_at === null);
      if (asset) {
        asset.init_status = "done";
        asset.init_mime_type = String(mimeType);
        asset.init_size = Number(size);
        asset.init_storage_backend = "telegram_single";
        asset.init_telegram_file_id = String(telegramFileId);
        asset.init_telegram_file_unique_id = telegramFileUniqueId === null ? null : String(telegramFileUniqueId);
        asset.init_telegram_channel_id = String(telegramChannelId || "default");
        asset.init_error_message = null;
        asset.updated_at = String(updatedAt);
        asset.init_completed_at = String(completedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_ASSETS") && normalizedSql.includes("SET INIT_STATUS = 'FAILED'")) {
      const [message, updatedAt, id] = this.bindings;
      const asset = this.db.hlsAssets.find((item) => item.id === id && item.deleted_at === null);
      if (asset) {
        asset.init_status = "failed";
        asset.init_error_message = String(message);
        asset.updated_at = String(updatedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_SEGMENTS") && normalizedSql.includes("SET STATUS = 'IMPORTING'")) {
      const [updatedAt, id] = this.bindings;
      const segment = this.db.hlsSegments.find((item) => item.id === id);
      if (segment) {
        segment.status = "importing";
        segment.attempts += 1;
        segment.error_message = null;
        segment.updated_at = String(updatedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_SEGMENTS") && normalizedSql.includes("STORAGE_BACKEND = 'TELEGRAM_SINGLE'")) {
      const [
        mimeType,
        size,
        telegramFileId,
        telegramFileUniqueId,
        telegramChannelId,
        updatedAt,
        completedAt,
        id
      ] = this.bindings;
      const segment = this.db.hlsSegments.find((item) => item.id === id);
      if (segment) {
        segment.status = "done";
        segment.mime_type = String(mimeType);
        segment.size = Number(size);
        segment.storage_backend = "telegram_single";
        segment.telegram_file_id = String(telegramFileId);
        segment.telegram_file_unique_id = telegramFileUniqueId === null ? null : String(telegramFileUniqueId);
        segment.telegram_channel_id = String(telegramChannelId || "default");
        segment.multipart_upload_id = null;
        segment.chunk_size = null;
        segment.chunk_count = null;
        segment.error_message = null;
        segment.updated_at = String(updatedAt);
        segment.completed_at = String(completedAt);
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_SEGMENTS") && normalizedSql.includes("STORAGE_BACKEND = 'TELEGRAM_MULTIPART'")) {
      if (normalizedSql.includes("SET STATUS = 'DONE'")) {
        const [multipartUploadId, chunkSize, chunkCount, updatedAt, completedAt, id] = this.bindings;
        const segment = this.db.hlsSegments.find((item) => item.id === id);
        if (segment) {
          segment.status = "done";
          segment.storage_backend = "telegram_multipart";
          segment.multipart_upload_id = String(multipartUploadId);
          segment.chunk_size = Number(chunkSize);
          segment.chunk_count = Number(chunkCount);
          segment.error_message = null;
          segment.updated_at = String(updatedAt);
          segment.completed_at = String(completedAt);
          changes = 1;
        }
      } else {
        const [mimeType, multipartUploadId, size, chunkSize, chunkCount, updatedAt, id] = this.bindings;
        const segment = this.db.hlsSegments.find((item) => item.id === id);
        if (segment) {
          segment.storage_backend = "telegram_multipart";
          segment.mime_type = String(mimeType);
          segment.multipart_upload_id = String(multipartUploadId);
          segment.size = Number(size);
          segment.chunk_size = Number(chunkSize);
          segment.chunk_count = Number(chunkCount);
          segment.updated_at = String(updatedAt);
          changes = 1;
        }
      }
    }

    if (normalizedSql.startsWith("UPDATE HLS_SEGMENTS") && normalizedSql.includes("SET STATUS = 'FAILED'")) {
      const [message, updatedAt, id] = this.bindings;
      const segment = this.db.hlsSegments.find((item) => item.id === id);
      if (segment) {
        segment.status = "failed";
        segment.error_message = String(message);
        segment.updated_at = String(updatedAt);
        changes = 1;
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
      const fileIds = normalizedSql.includes("FILE_NAME = ?")
        ? new Set(this.matchingActiveFileNameRecords().map((file) => file.id))
        : normalizedSql.includes("WHERE FILE_ID = ?")
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
      } else if (normalizedSql.includes("FILE_NAME = ?")) {
        const matches = new Set(this.matchingActiveFileNameRecords().map((file) => file.id));
        this.deleteWhere(this.db.files, (file) => matches.has(file.id));
      } else {
        this.deleteWhere(this.db.files, (file) => this.fileMatchesDirectorySelection(file, this.bindings));
      }
    }

    if (normalizedSql.startsWith("DELETE FROM MULTIPART_UPLOADS")) {
      if (normalizedSql.includes("WHERE ID = ?")) {
        const id = String(this.bindings[0]);
        this.deleteWhere(this.db.multipartUploads, (upload) => upload.id === id);
      } else if (normalizedSql.includes("FILE_NAME = ?")) {
        const matches = new Set(this.matchingActiveFileNameRecords().map((file) => file.id));
        this.deleteWhere(this.db.multipartUploads, (upload) => matches.has(upload.id));
      } else {
        this.deleteWhere(this.db.multipartUploads, (upload) => this.uploadMatchesDirectorySelection(upload, this.bindings));
      }
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
        upload.source_headers_json = null;
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("UPDATE MULTIPART_UPLOADS SET DIRECTORY_ID")) {
      const [directoryId, directoryPath, id] = this.bindings;
      const upload = this.db.multipartUploads.find((item) => item.id === id && item.completed_at === null);
      if (upload) {
        upload.directory_id = directoryId === null ? null : String(directoryId);
        upload.directory_path = String(directoryPath || "/");
        changes = 1;
      }
    }

    if (normalizedSql.startsWith("DELETE FROM FILE_CHUNKS") && normalizedSql.includes("MULTIPART_UPLOADS.CREATED_AT < ?")) {
      const expiredBefore = String(this.bindings[0]);
      const staleUploadIds = new Set(
        this.db.multipartUploads
          .filter((item) =>
            item.completed_at === null &&
            item.created_at < expiredBefore &&
            !this.db.files.some((file) => file.id === item.id)
          )
          .map((item) => item.id)
      );
      const remaining = this.db.fileChunks.filter((item) => !staleUploadIds.has(item.file_id));
      changes = this.db.fileChunks.length - remaining.length;
      this.db.fileChunks.splice(0, this.db.fileChunks.length, ...remaining);
    }

    if (normalizedSql.startsWith("DELETE FROM MULTIPART_UPLOADS") && normalizedSql.includes("CREATED_AT < ?")) {
      const expiredBefore = String(this.bindings[0]);
      const remaining = this.db.multipartUploads.filter(
        (item) =>
          item.completed_at !== null ||
          item.created_at >= expiredBefore ||
          this.db.files.some((file) => file.id === item.id)
      );
      changes = this.db.multipartUploads.length - remaining.length;
      this.db.multipartUploads.splice(0, this.db.multipartUploads.length, ...remaining);
    }

    return { success: true, meta: { ...fakeDatabaseMeta(), changes }, results: [] };
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

      if (normalizedSql.includes("FROM FILE_CHUNKS") && normalizedSql.includes("TELEGRAM_CHANNEL_ID")) {
        const channelId = this.bindings[0];
        return {
          total: this.db.fileChunks.filter((item) => (item.telegram_channel_id ?? "default") === channelId).length
        } as T;
      }

      if (normalizedSql.includes("FROM FILES") && normalizedSql.includes("TELEGRAM_CHANNEL_ID")) {
        const channelId = this.bindings[0];
        return {
          total: this.db.files.filter((item) => (item.telegram_channel_id ?? "default") === channelId).length
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

    if (normalizedSql.includes("FROM HLS_ASSETS")) {
      const lookupValue = this.bindings[0];
      const asset = normalizedSql.includes("WHERE FINAL_FILE_ID =")
        ? this.db.hlsAssets.find((item) => item.final_file_id === lookupValue && item.deleted_at === null)
        : this.db.hlsAssets.find((item) => item.id === lookupValue && item.deleted_at === null);
      return (asset ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM HLS_SEGMENTS")) {
      const [assetId, segmentIndex] = this.bindings;
      const segment = this.db.hlsSegments.find((item) =>
        item.asset_id === assetId &&
        (!normalizedSql.includes("SEGMENT_INDEX = ?") || item.segment_index === Number(segmentIndex))
      );
      return (segment ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM FILES") && normalizedSql.includes("FILE_NAME = ?")) {
      const file = this.matchingFileNameConflict();
      return (file ? { id: file.id } : null) as T | null;
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

    if (normalizedSql.includes("FROM MULTIPART_UPLOADS") && normalizedSql.includes("FILE_NAME = ?")) {
      const upload = this.matchingMultipartFileNameConflict();
      return (upload ? { id: upload.id } : null) as T | null;
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

    if (normalizedSql.includes("FROM TELEGRAM_CHANNELS")) {
      const id = this.bindings[0];
      const channel = this.db.telegramChannels.find((item) => item.id === id);
      return (channel ?? null) as T | null;
    }

    if (normalizedSql.includes("FROM APP_SETTINGS")) {
      const value = this.db.appSettings.get(String(this.bindings[0]));
      return (value === undefined ? null : { value }) as T | null;
    }

    if (normalizedSql.includes("FROM API_KEYS")) {
      const apiKey = this.matchingApiKey(normalizedSql);
      return (apiKey ?? null) as T | null;
    }

    return null;
  }

  async all<T = unknown>(): Promise<AppResult<T>> {
    const normalizedSql = this.sql.trim().toUpperCase();
    if (normalizedSql.includes("FROM TELEGRAM_CHANNELS")) {
      const results = normalizedSql.includes("WHERE STATUS = 'ACTIVE'")
        ? this.db.telegramChannels.filter((item) => item.status === "active")
        : this.db.telegramChannels;
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: results.slice().sort((left, right) => right.is_default - left.is_default || left.created_at.localeCompare(right.created_at)) as T[]
      };
    }

    if (normalizedSql.includes("FROM API_KEYS")) {
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: this.db.apiKeys.filter((item) => item.deleted_at === null) as T[]
      };
    }

    if (normalizedSql.includes("FROM FILE_CHUNKS")) {
      const fileId = this.bindings[0];
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: this.db.fileChunks
          .filter((item) => item.file_id === fileId)
          .sort((left, right) => left.chunk_index - right.chunk_index) as T[]
      };
    }

    if (normalizedSql.includes("FROM HLS_SEGMENTS")) {
      const assetId = this.bindings[0];
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: this.db.hlsSegments
          .filter((item) => item.asset_id === assetId)
          .sort((left, right) => left.segment_index - right.segment_index) as T[]
      };
    }

    if (normalizedSql.includes("FROM MULTIPART_UPLOADS")) {
      const limit = Number(this.bindings[0]);
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: this.db.multipartUploads
          .filter((item) => item.completed_at === null)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, Number.isFinite(limit) ? limit : undefined) as T[]
      };
    }

    if (normalizedSql.includes("FROM HLS_ASSETS")) {
      const limit = Number(this.bindings[0]);
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: this.db.hlsAssets
          .filter((item) =>
            item.deleted_at === null &&
            item.final_file_id === null &&
            (item.status === "pending" || item.status === "importing" || item.status === "failed")
          )
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
          .slice(0, Number.isFinite(limit) ? limit : undefined) as T[]
      };
    }

    if (normalizedSql.includes("FROM MAGNET_IMPORTS")) {
      const limit = Number(this.bindings[0]);
      return {
        success: true,
        meta: fakeDatabaseMeta(),
        results: this.db.magnetImports
          .filter((item) =>
            item.completed_at === null &&
            (
              item.status === "probing" ||
              item.status === "ready" ||
              item.status === "downloading" ||
              item.status === "downloaded" ||
              item.status === "importing" ||
              item.status === "failed"
            )
          )
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
          .slice(0, Number.isFinite(limit) ? limit : undefined) as T[]
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
        meta: fakeDatabaseMeta(),
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
        meta: fakeDatabaseMeta(),
        results: Array.from(rows.values()) as T[]
      };
    }

    const files = this.visibleFiles();
    const hasPagination = this.sql.toUpperCase().includes("LIMIT ? OFFSET ?");
    const limit = hasPagination ? Number(this.bindings.at(-2)) : Number.NaN;
    const offset = hasPagination ? Number(this.bindings.at(-1)) : 0;

    return {
      success: true,
      meta: fakeDatabaseMeta(),
      results: hasPagination
        ? files.slice(offset || 0, Number.isFinite(limit) ? (offset || 0) + limit : undefined) as T[]
        : files as T[]
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
      const isVideo = mime.startsWith("video/") || /\.(mp4|m4v|mov|webm|ogv)$/i.test(name);
      const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
      const isArchive = /\.(zip|rar|7z|tar|gz)$/i.test(name);
      const isText = mime.startsWith("text/") || /\.(json|xml|ya?ml|md|markdown|log)$/i.test(name);

      if (normalizedSql.includes("NOT (LOWER(MIME_TYPE) LIKE 'IMAGE/%'")) {
        return !(isImage || isVideo || isText || isPdf || isArchive);
      }

      if (normalizedSql.includes("LOWER(MIME_TYPE) LIKE 'IMAGE/%'")) {
        return isImage;
      }

      if (normalizedSql.includes("LOWER(MIME_TYPE) LIKE 'VIDEO/%'")) {
        return isVideo;
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

  private matchingFileNameConflict(): FileRecord | undefined {
    return this.matchingActiveFileNameRecords()[0];
  }

  private matchingActiveFileNameRecords(): FileRecord[] {
    const [directoryPath, fileName, excludeId] = this.bindings;

    return this.db.files.filter((item) =>
      item.deleted_at === null &&
      (item.directory_path ?? "/") === directoryPath &&
      item.file_name === fileName &&
      (excludeId === undefined || item.id !== String(excludeId))
    );
  }

  private matchingMultipartFileNameConflict(): MultipartUploadRecord | undefined {
    const [directoryPath, fileName, excludeId] = this.bindings;

    return this.db.multipartUploads.find((item) =>
      item.completed_at === null &&
      (item.directory_path ?? "/") === directoryPath &&
      item.file_name === fileName &&
      (excludeId === undefined || item.id !== String(excludeId))
    );
  }
}

function envWithDb(db: FakeDatabase): AppEnv {
  return {
    ...AppEnv,
    DATABASE: db as unknown as AppDatabase
  };
}

function addApiKey(db: FakeDatabase, options?: { key?: string; status?: ApiKeyStatus }): ApiKeyRecord {
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

function fileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "file-existing",
    file_name: "hello.txt",
    mime_type: "text/plain",
    size: 5,
    md5: "md5-existing",
    telegram_file_id: "tg-existing",
    telegram_file_unique_id: null,
    telegram_channel_id: "default",
    file_path: "/f/token/hello.txt",
    remark: null,
    uploaded_by: "admin",
    created_at: "2026-06-01T00:00:00.000Z",
    deleted_at: null,
    directory_id: null,
    directory_path: "/",
    storage_backend: "telegram_single",
    chunk_size: null,
    chunk_count: null,
    thumbnail_file_id: null,
    thumbnail_file_unique_id: null,
    thumbnail_file_path: null,
    thumbnail_mime_type: null,
    thumbnail_size: null,
    thumbnail_width: null,
    thumbnail_height: null,
    thumbnail_status: "none",
    ...overrides
  };
}

function hlsAssetRecord(overrides: Partial<HlsAssetRecord> = {}): HlsAssetRecord {
  return {
    id: "hls-asset",
    source_url: "https://media.example.com/master.m3u8",
    source_headers_json: null,
    media_playlist_url: "https://media.example.com/playlist.m3u8",
    file_name: "movie.m3u8",
    mime_type: "application/vnd.apple.mpegurl",
    directory_id: null,
    directory_path: "/",
    status: "done",
    selected_variant_id: "variant-0",
    target_duration_seconds: 6,
    duration_seconds: 12,
    segment_count: 2,
    estimated_size: 6,
    playlist_text: "#EXTM3U\n#EXTINF:6,\nseg-0.ts\n#EXTINF:6,\nseg-1.ts\n#EXT-X-ENDLIST\n",
    playlist_file_id: "tg-playlist",
    final_file_id: "file-hls",
    init_source_url: null,
    init_byte_range_start: null,
    init_byte_range_length: null,
    init_mime_type: null,
    init_size: null,
    init_storage_backend: null,
    init_telegram_file_id: null,
    init_telegram_file_unique_id: null,
    init_telegram_channel_id: "default",
    init_status: "none",
    init_error_message: null,
    init_completed_at: null,
    thumbnail_status: "none",
    remark: null,
    uploaded_by: "admin",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    completed_at: "2026-06-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides
  };
}

function hlsSegmentRecord(segmentIndex: number, overrides: Partial<HlsSegmentRecord> = {}): HlsSegmentRecord {
  return {
    id: `hls-segment-${segmentIndex}`,
    asset_id: "hls-asset",
    variant_id: "variant-0",
    segment_index: segmentIndex,
    source_url: `https://media.example.com/seg-${segmentIndex}.ts`,
    byte_range_start: null,
    byte_range_length: null,
    duration_seconds: 6,
    mime_type: "video/mp2t",
    size: 3,
    storage_backend: "telegram_single",
    telegram_file_id: `tg-hls-segment-${segmentIndex}`,
    telegram_file_unique_id: null,
    telegram_channel_id: "default",
    multipart_upload_id: null,
    chunk_size: null,
    chunk_count: null,
    status: "done",
    attempts: 1,
    error_message: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    completed_at: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

function magnetImportRecord(overrides: Partial<MagnetImportRecord> = {}): MagnetImportRecord {
  return {
    id: "magnet-import",
    magnet_uri: "magnet:?xt=urn:btih:example",
    info_hash: "example",
    name: "movie-pack",
    status: "downloading",
    aria2_metadata_gid: null,
    aria2_download_gid: "aria2-download",
    download_dir: "/tmp/tgbot-files",
    selected_indexes_json: "[0]",
    file_count: 1,
    total_size: 2048,
    error_message: null,
    uploaded_by: "admin",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    metadata_completed_at: null,
    download_started_at: "2026-06-01T00:00:00.000Z",
    download_completed_at: null,
    completed_at: null,
    cancelled_at: null,
    ...overrides
  };
}

function fakeDatabaseMeta(): AppResultMeta & Record<string, unknown> {
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

async function aesCbcEncrypt(plainBytes: Uint8Array, keyBytes: Uint8Array, ivBytes: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toExactArrayBuffer(keyBytes),
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: toExactArrayBuffer(ivBytes) },
    cryptoKey,
    toExactArrayBuffer(plainBytes)
  );
  return encrypted;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe("worker upload endpoint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects missing bearer auth", async () => {
    const response = await handleRequest(uploadRequest({ token: null }), envWithDb(new FakeDatabase()));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects invalid bearer auth", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const response = await handleRequest(uploadRequest({ token: "wrong" }), envWithDb(db));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects disabled upload API keys", async () => {
    const db = new FakeDatabase();
    addApiKey(db, { status: "disabled" });
    const response = await handleRequest(uploadRequest(), envWithDb(db));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects missing file", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const response = await handleRequest(uploadRequest({ file: null }), envWithDb(db));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("MissingFile");
  });

  it("rejects empty file", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const response = await handleRequest(
      uploadRequest({ file: new File([""], "empty.txt", { type: "text/plain" }) }),
      envWithDb(db)
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("EmptyFile");
  });

  it("rejects files over configured limit", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const smallLimitEnv = { ...envWithDb(db), MAX_FILE_BYTES: "5" };
    const response = await handleRequest(
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
    const db = new FakeDatabase();
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

    const response = await handleRequest(uploadRequest(), envWithDb(db));
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
    const db = new FakeDatabase();
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

    const response = await handleRequest(
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

  it("rejects duplicate file names only within the same upload API directory", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    db.files.push(fileRecord({
      id: "existing-hello",
      file_name: "hello.txt",
      directory_path: "/docs"
    }));
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "tg-new-hello",
            file_name: "hello.txt",
            mime_type: "text/plain",
            file_size: 5
          }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const conflictResponse = await handleRequest(
      uploadRequest({ directoryPath: "/docs" }),
      envWithDb(db)
    );
    const conflictBody = await conflictResponse.json() as {
      error: string;
      details: { directory_path: string; file_name: string; suggested_name: string; source: string };
    };

    expect(conflictResponse.status).toBe(409);
    expect(conflictBody.error).toBe("FileNameConflict");
    expect(conflictBody.details).toMatchObject({
      directory_path: "/docs",
      file_name: "hello.txt",
      suggested_name: "hello (1).txt",
      source: "file"
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const otherDirectoryResponse = await handleRequest(
      uploadRequest({ directoryPath: "/archive" }),
      envWithDb(db)
    );
    const otherDirectoryBody = await otherDirectoryResponse.json() as { ok: boolean; name: string };

    expect(otherDirectoryResponse.status).toBe(200);
    expect(otherDirectoryBody).toMatchObject({ ok: true, name: "hello.txt" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.files).toHaveLength(2);
    expect(db.files[1]?.directory_path).toBe("/archive");
  });

  it("accepts small webp files when Telegram returns them as stickers", async () => {
    const db = new FakeDatabase();
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

    const response = await handleRequest(
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
    const db = new FakeDatabase();
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

    const response = await handleRequest(
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
    const db = new FakeDatabase();
    addApiKey(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, description: "chat not found", error_code: 400 }, { status: 400 }))
    );

    const response = await handleRequest(uploadRequest(), envWithDb(db));
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
    const db = new FakeDatabase();
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

    const initResponse = await handleRequest(
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
    const chunkResponse = await handleRequest(
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

    const completeResponse = await handleRequest(
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

    const infoResponse = await handleRequest(
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

    const downloadResponse = await handleRequest(
      new Request(`https://files.example.com/api/v1/files/${completeBody.file.id}/chunks/0`, {
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );

    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe("hello");
    expect(downloadResponse.headers.get("X-Chunk-Count")).toBe("1");
    expect(downloadResponse.headers.get("Content-Disposition")).toContain("small.txt.part-1-of-1");

    const directResponse = await handleRequest(new Request(completeBody.file.url), apiEnv);
    expect(directResponse.status).toBe(200);
    expect(directResponse.headers.get("X-Frame-Options")).toBeNull();
    expect(directResponse.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(await directResponse.text()).toBe("hello");

    const publicPathParts = new URL(completeBody.file.url).pathname.split("/");
    const token = publicPathParts[2] ?? "";
    const rangeResponse = await handleRequest(
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

    const unsatisfiableResponse = await handleRequest(
      new Request(`https://files.example.com/f/${token}/chunks/0`, {
        headers: { Range: "bytes=5-6" }
      }),
      apiEnv
    );

    expect(unsatisfiableResponse.status).toBe(416);
    expect(unsatisfiableResponse.headers.get("Content-Range")).toBe("bytes */5");
  });

  it("stores an optional thumbnail when completing an API multipart upload", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const apiEnv = envWithDb(db);
    let sendDocumentCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const inputUrl = String(input);

      if (inputUrl.endsWith("/sendDocument")) {
        sendDocumentCalls += 1;
        return jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: sendDocumentCalls === 1 ? "tg-main-chunk" : "tg-thumbnail",
              file_unique_id: sendDocumentCalls === 1 ? "unique-main-chunk" : "unique-thumbnail",
              file_name: sendDocumentCalls === 1 ? "photo.jpg.part-1-of-1" : "photo.thumbnail.jpg",
              mime_type: sendDocumentCalls === 1 ? "application/octet-stream" : "image/jpeg",
              file_size: sendDocumentCalls === 1 ? 5 : 4
            }
          }
        });
      }

      throw new Error(`Unexpected fetch ${inputUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const initResponse = await handleRequest(
      new Request("https://files.example.com/api/v1/uploads/init", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_name: "photo.jpg",
          mime_type: "image/jpeg",
          size: 5
        })
      }),
      apiEnv
    );
    const initBody = await initResponse.json() as { upload: { id: string } };
    const chunkForm = new FormData();
    chunkForm.set("chunk", new File(["hello"], "photo.jpg.part-1", { type: "application/octet-stream" }));
    await handleRequest(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/chunks/0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` },
        body: chunkForm
      }),
      apiEnv
    );

    const completeForm = new FormData();
    completeForm.set("thumbnail", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "thumb.jpg", { type: "image/jpeg" }));
    completeForm.set("thumbnail_width", "320");
    completeForm.set("thumbnail_height", "180");
    const completeResponse = await handleRequest(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` },
        body: completeForm
      }),
      apiEnv
    );
    const completeBody = await completeResponse.json() as {
      file: {
        thumbnail_status: string;
        thumbnail_url: string | null;
        thumbnail_file_id: string | null;
        thumbnail_width: number | null;
        thumbnail_height: number | null;
      };
    };

    expect(completeResponse.status).toBe(200);
    expect(sendDocumentCalls).toBe(2);
    expect(completeBody.file.thumbnail_status).toBe("ready");
    expect(completeBody.file.thumbnail_file_id).toBe("tg-thumbnail");
    expect(completeBody.file.thumbnail_url).toMatch(/^https:\/\/files\.example\.com\/f\//);
    expect(completeBody.file.thumbnail_width).toBe(320);
    expect(completeBody.file.thumbnail_height).toBe(180);
    expect(db.files[0]).toMatchObject({
      thumbnail_file_id: "tg-thumbnail",
      thumbnail_file_unique_id: "unique-thumbnail",
      thumbnail_status: "ready",
      thumbnail_mime_type: "image/jpeg",
      thumbnail_width: 320,
      thumbnail_height: 180
    });
  });

  it("imports a small URL through the API key multipart URL flow", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const apiEnv = envWithDb(db);
    const sourceUrl = "https://source.example.com/small.txt";
    const sourceHeaders = {
      Referer: "https://app.example.com/watch/42",
      Cookie: "sid=source-cookie",
      Authorization: "Bearer upstream-token",
      "X-Source-Token": "custom-token"
    };
    const fetchCalls: Array<{
      input: string;
      method: string | undefined;
      range: string | null;
      referer: string | null;
      cookie: string | null;
      authorization: string | null;
      sourceToken: string | null;
    }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = String(input);
      const headers = new Headers(init?.headers);
      fetchCalls.push({
        input: inputUrl,
        method: init?.method,
        range: headers.get("Range"),
        referer: headers.get("Referer"),
        cookie: headers.get("Cookie"),
        authorization: headers.get("Authorization"),
        sourceToken: headers.get("X-Source-Token")
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

    const initResponse = await handleRequest(
      new Request("https://files.example.com/api/v1/uploads/url/init", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl, remark: "URL 小文件分片", headers: sourceHeaders })
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
    expect(JSON.parse(db.multipartUploads[0]?.source_headers_json || "{}")).toMatchObject(sourceHeaders);

    const chunkResponse = await handleRequest(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/url-chunks/0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );
    expect(chunkResponse.status).toBe(200);

    const completeResponse = await handleRequest(
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
    expect(db.multipartUploads[0]?.source_headers_json).toBeNull();
    expect(fetchCalls.some((call) => call.range === "bytes=0-4")).toBe(true);
    expect(fetchCalls.filter((call) => call.input === sourceUrl)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "HEAD",
          referer: sourceHeaders.Referer,
          cookie: sourceHeaders.Cookie,
          authorization: sourceHeaders.Authorization,
          sourceToken: sourceHeaders["X-Source-Token"]
        }),
        expect.objectContaining({
          range: "bytes=0-0",
          referer: sourceHeaders.Referer,
          cookie: sourceHeaders.Cookie,
          authorization: sourceHeaders.Authorization,
          sourceToken: sourceHeaders["X-Source-Token"]
        }),
        expect.objectContaining({
          range: "bytes=0-4",
          referer: sourceHeaders.Referer,
          cookie: sourceHeaders.Cookie,
          authorization: sourceHeaders.Authorization,
          sourceToken: sourceHeaders["X-Source-Token"]
        })
      ])
    );
  });

  it("rejects URL multipart chunks that return a mismatched Content-Range before uploading to Telegram", async () => {
    const db = new FakeDatabase();
    addApiKey(db);
    const apiEnv = envWithDb(db);
    const sourceUrl = "https://source.example.com/small.txt";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = String(input);
      const headers = new Headers(init?.headers);

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
            "Content-Range": "bytes 1-4/5"
          }
        });
      }

      if (inputUrl.endsWith("/sendDocument")) {
        throw new Error("Telegram upload should not be called for mismatched source ranges");
      }

      throw new Error(`Unexpected fetch ${inputUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const initResponse = await handleRequest(
      new Request("https://files.example.com/api/v1/uploads/url/init", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl })
      }),
      apiEnv
    );
    const initBody = await initResponse.json() as {
      upload: { id: string };
    };

    const chunkResponse = await handleRequest(
      new Request(`https://files.example.com/api/v1/uploads/${initBody.upload.id}/url-chunks/0`, {
        method: "POST",
        headers: { Authorization: `Bearer ${uploadApiKey}` }
      }),
      apiEnv
    );
    const body = await chunkResponse.json() as {
      error: string;
      details: { expected_start: number; actual_start: number };
    };

    expect(chunkResponse.status).toBe(400);
    expect(body.error).toBe("InvalidChunkRange");
    expect(body.details.expected_start).toBe(0);
    expect(body.details.actual_start).toBe(1);
  });

  it("rejects API key chunk downloads for non-multipart files", async () => {
    const db = new FakeDatabase();
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

    const response = await handleRequest(
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
        name: "hello.pdf",
        mime_type: "application/pdf",
        size: 5,
        iat: 1_768_566_400
      },
      AppEnv.LINK_SIGNING_SECRET
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

    const response = await handleRequest(new Request(`https://files.example.com/f/${token}/hello.pdf`), AppEnv);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("hello.pdf");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
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
      AppEnv.LINK_SIGNING_SECRET
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
    const firstResponse = await handleRequest(new Request(fileUrl), AppEnv);
    expect(await firstResponse.text()).toBe("hello");

    const secondResponse = await handleRequest(new Request(fileUrl), AppEnv);
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
      AppEnv.LINK_SIGNING_SECRET
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

    const response = await handleRequest(
      new Request(`https://files.example.com/f/${token}/hello.txt`, {
        headers: { Range: "bytes=0-1" }
      }),
      AppEnv
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
      AppEnv.LINK_SIGNING_SECRET
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

    const response = await handleRequest(new Request(`https://files.example.com/f/${token}/hello.txt?download=1`), AppEnv);

    expect(response.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("streams range requests across multipart Telegram chunks", async () => {
    const db = new FakeDatabase();
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
      AppEnv.LINK_SIGNING_SECRET
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

    const response = await handleRequest(
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

  it("allows direct multipart file access when the chunk count exceeds the former direct-link budget", async () => {
    const db = new FakeDatabase();
    const chunkCount = formerDirectAccessMaxChunks + 1;
    const token = await createSignedToken(
      {
        v: 2,
        file_record_id: "file-large-multipart",
        name: "large.bin",
        mime_type: "application/octet-stream",
        size: chunkCount * 3,
        chunk_size: 3,
        chunk_count: chunkCount,
        iat: 1_768_566_400
      },
      AppEnv.LINK_SIGNING_SECRET
    );
    db.fileChunks.push(
      ...Array.from({ length: chunkCount }, (_, index) => ({
        file_id: "file-large-multipart",
        chunk_index: index,
        size: 3,
        md5: `chunk-${index}`,
        telegram_file_id: `tg-chunk-${index}`,
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:00.000Z"
      }))
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request(`https://files.example.com/f/${token}/large.bin`),
      envWithDb(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(chunkCount * 3));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows direct HLS package downloads when the part count exceeds the former direct-link budget", async () => {
    const db = new FakeDatabase();
    const partCount = formerDirectAccessMaxChunks + 1;
    db.hlsAssets.push(hlsAssetRecord({
      segment_count: partCount,
      duration_seconds: partCount,
      estimated_size: partCount
    }));
    db.hlsSegments.push(
      ...Array.from({ length: partCount }, (_, index) =>
        hlsSegmentRecord(index, {
          size: 1,
          duration_seconds: 1
        })
      )
    );
    const token = await createSignedToken(
      {
        v: 4,
        hls_asset_id: "hls-asset",
        file_record_id: "file-hls",
        name: "movie.m3u8",
        mime_type: "application/vnd.apple.mpegurl",
        size: 123,
        iat: 1_768_566_400
      },
      AppEnv.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request(`https://files.example.com/api/hls/${token}/movie.m3u8?download=1`),
      envWithDb(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(partCount));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads a single HLS multipart segment chunk without fetching sibling chunks", async () => {
    const db = new FakeDatabase();
    db.hlsAssets.push(hlsAssetRecord({
      segment_count: 1,
      estimated_size: 5
    }));
    db.hlsSegments.push(hlsSegmentRecord(0, {
      size: 5,
      storage_backend: "telegram_multipart",
      telegram_file_id: null,
      telegram_file_unique_id: null,
      multipart_upload_id: "hls-segment-upload",
      chunk_size: 3,
      chunk_count: 2
    }));
    db.fileChunks.push(
      {
        file_id: "hls-segment-upload",
        chunk_index: 0,
        size: 3,
        md5: "chunk-a",
        telegram_file_id: "tg-hls-chunk-0",
        telegram_file_unique_id: null,
        created_at: "2026-05-31T00:00:00.000Z"
      },
      {
        file_id: "hls-segment-upload",
        chunk_index: 1,
        size: 2,
        md5: "chunk-b",
        telegram_file_id: "tg-hls-chunk-1",
        telegram_file_unique_id: null,
        created_at: "2026-05-31T00:00:01.000Z"
      }
    );
    const token = await createSignedToken(
      {
        v: 4,
        hls_asset_id: "hls-asset",
        file_record_id: "file-hls",
        name: "movie.m3u8",
        mime_type: "application/vnd.apple.mpegurl",
        size: 123,
        iat: 1_768_566_400
      },
      AppEnv.LINK_SIGNING_SECRET
    );
    const fetchCalls: Array<{ input: string; range: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = String(input);
        const range = new Headers(init?.headers).get("Range");
        fetchCalls.push({ input: inputUrl, range });

        if (inputUrl.includes("file_id=tg-hls-chunk-1")) {
          return jsonResponse({ ok: true, result: { file_id: "tg-hls-chunk-1", file_path: "documents/hls-chunk1" } });
        }
        if (inputUrl.endsWith("/documents/hls-chunk1")) {
          expect(range).toBe("bytes=0-0");
          return new Response("d", {
            status: 206,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": "1"
            }
          });
        }

        throw new Error(`Unexpected fetch ${inputUrl}`);
      })
    );

    const response = await handleRequest(
      new Request(`https://files.example.com/api/hls/${token}/segments/0/chunks/1`, {
        headers: { Range: "bytes=0-0" }
      }),
      envWithDb(db)
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("d");
    expect(response.headers.get("Content-Length")).toBe("1");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-0/2");
    expect(response.headers.get("X-HLS-Segment-Index")).toBe("0");
    expect(response.headers.get("X-Chunk-Index")).toBe("1");
    expect(response.headers.get("X-Chunk-Count")).toBe("2");
    expect(response.headers.get("X-Chunk-Offset")).toBe("3");
    expect(fetchCalls).toEqual([
      {
        input: "https://api.telegram.org/bot123456:test-token/getFile?file_id=tg-hls-chunk-1",
        range: null
      },
      {
        input: "https://api.telegram.org/file/bot123456:test-token/documents/hls-chunk1",
        range: "bytes=0-0"
      }
    ]);
  });

  it("downloads an existing multipart chunk without issuing Telegram range requests", async () => {
    const db = new FakeDatabase();
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
      AppEnv.LINK_SIGNING_SECRET
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

    const response = await handleRequest(
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
    const db = new FakeDatabase();
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
      AppEnv.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
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
      AppEnv.LINK_SIGNING_SECRET
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(new Request(`https://files.example.com/f/${token}/chunks/0`), AppEnv);
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
      AppEnv.LINK_SIGNING_SECRET
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    const response = await handleRequest(new Request(`https://files.example.com/f/${tampered}/hello.txt`), AppEnv);
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
      AppEnv.LINK_SIGNING_SECRET
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, description: "file is too big", error_code: 400 }, { status: 400 }))
    );

    const response = await handleRequest(new Request(`https://files.example.com/f/${token}/hello.txt`), AppEnv);
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const form = new URLSearchParams({ username: "admin", password: "secret" });

    const response = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };

    const response = await handleRequest(
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

    const sessionResponse = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(Date.parse("2026-01-01T00:00:00.000Z"));
      const cookie = await loginAndGetCookie(adminEnv);

      now.mockReturnValue(Date.parse("2026-01-02T00:00:00.000Z"));
      const response = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
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

    const sessionResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/session", {
        headers: { Cookie: expiredCookie || "" }
      }),
      adminEnv
    );
    expect(sessionResponse.status).toBe(401);
  });

  it("updates upload concurrency settings", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);

    const initialSession = await handleRequest(
      new Request("https://files.example.com/api/admin/session", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const initialBody = await initialSession.json() as { upload_concurrency: number; upload_concurrency_min: number; upload_concurrency_max: number };

    expect(initialSession.status).toBe(200);
    expect(initialBody.upload_concurrency).toBe(5);
    expect(initialBody.upload_concurrency_min).toBe(1);
    expect(initialBody.upload_concurrency_max).toBe(32);

    const updateResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/settings", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ upload_concurrency: 99 })
      }),
      adminEnv
    );
    const updateBody = await updateResponse.json() as { settings: { upload_concurrency: number } };

    expect(updateResponse.status).toBe(200);
    expect(updateBody.settings.upload_concurrency).toBe(32);

    const sessionResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/session", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const sessionBody = await sessionResponse.json() as { upload_concurrency: number };

    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.upload_concurrency).toBe(32);
  });

  it("uses configured Telegram chunk size for new multipart upload sessions", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const configuredChunkSize = 5 * 1024 * 1024;

    const updateResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/settings", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ telegram_chunk_size_bytes: configuredChunkSize })
      }),
      adminEnv
    );
    const updateBody = await updateResponse.json() as { settings: { telegram_chunk_size_bytes: number } };

    expect(updateResponse.status).toBe(200);
    expect(updateBody.settings.telegram_chunk_size_bytes).toBe(configuredChunkSize);

    const initResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/init", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_name: "movie.bin",
          mime_type: "application/octet-stream",
          size: 12 * 1024 * 1024
        })
      }),
      adminEnv
    );
    const initBody = await initResponse.json() as {
      upload: {
        chunk_size: number;
        chunk_count: number;
        direct_access_max_chunks: number;
      };
    };

    expect(initResponse.status).toBe(201);
    expect(initBody.upload.chunk_size).toBe(configuredChunkSize);
    expect(initBody.upload.chunk_count).toBe(3);
    expect(initBody.upload.direct_access_max_chunks).toBe(Math.ceil(maxMultipartFileBytes / configuredChunkSize));
    expect(db.multipartUploads[0]?.chunk_size).toBe(configuredChunkSize);
    expect(db.multipartUploads[0]?.chunk_count).toBe(3);

    const listResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const listBody = await listResponse.json() as {
      multipart_chunk_bytes: number;
      direct_access_max_chunks: number;
    };

    expect(listResponse.status).toBe(200);
    expect(listBody.multipart_chunk_bytes).toBe(configuredChunkSize);
    expect(listBody.direct_access_max_chunks).toBe(Math.ceil(maxMultipartFileBytes / configuredChunkSize));
  });

  it("lists resumable admin upload tasks across multipart, HLS, and magnet imports", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);

    db.multipartUploads.push(
      {
        id: "multipart-active",
        source_kind: "url",
        source_url: "https://files.example.com/movie.bin",
        source_headers_json: null,
        source_range_start: null,
        file_name: "movie.bin",
        mime_type: "application/octet-stream",
        size: 1024,
        chunk_size: 512,
        chunk_count: 2,
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:00:03.000Z",
        completed_at: null,
        directory_id: null,
        directory_path: "/uploads",
        telegram_channel_group: "default"
      },
      {
        id: "multipart-done",
        source_kind: "local",
        source_url: null,
        source_headers_json: null,
        source_range_start: null,
        file_name: "done.bin",
        mime_type: "application/octet-stream",
        size: 1,
        chunk_size: 1,
        chunk_count: 1,
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T00:00:04.000Z",
        completed_at: "2026-06-01T00:00:05.000Z",
        directory_id: null,
        directory_path: "/",
        telegram_channel_group: "default"
      }
    );
    db.hlsAssets.push(
      hlsAssetRecord({
        id: "hls-active",
        file_name: "stream.m3u8",
        status: "failed",
        final_file_id: null,
        completed_at: null,
        updated_at: "2026-06-01T00:00:02.000Z"
      }),
      hlsAssetRecord({
        id: "hls-cancelled",
        status: "cancelled",
        final_file_id: null,
        completed_at: null,
        updated_at: "2026-06-01T00:00:06.000Z"
      })
    );
    db.magnetImports.push(
      magnetImportRecord({
        id: "magnet-active",
        name: "pack",
        status: "downloading",
        updated_at: "2026-06-01T00:00:01.000Z"
      }),
      magnetImportRecord({
        id: "magnet-cancelled",
        status: "cancelled",
        updated_at: "2026-06-01T00:00:07.000Z"
      })
    );

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/tasks", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      tasks: Array<{ kind: string; id: string; status?: string; source_kind?: string; file_name?: string; name?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.tasks).toEqual([
      expect.objectContaining({
        kind: "multipart",
        id: "multipart-active",
        source_kind: "url",
        file_name: "movie.bin"
      }),
      expect.objectContaining({
        kind: "hls",
        id: "hls-active",
        status: "failed",
        file_name: "stream.m3u8"
      }),
      expect.objectContaining({
        kind: "magnet",
        id: "magnet-active",
        status: "downloading",
        name: "pack"
      })
    ]);
    expect(body.tasks.map((task) => task.id)).not.toContain("multipart-done");
    expect(body.tasks.map((task) => task.id)).not.toContain("hls-cancelled");
    expect(body.tasks.map((task) => task.id)).not.toContain("magnet-cancelled");
  });

  it("uses file-type specific Telegram chunk sizes for new multipart upload sessions", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const defaultChunkSize = 8 * 1024 * 1024;
    const videoChunkSize = 1 * 1024 * 1024;
    const audioChunkSize = 10 * 1024 * 1024;
    const textChunkSize = 12 * 1024 * 1024;
    const imageChunkSize = 3 * 1024 * 1024;

    const updateResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/settings", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          telegram_chunk_size_bytes: defaultChunkSize,
          telegram_video_chunk_size_bytes: videoChunkSize,
          telegram_audio_chunk_size_bytes: audioChunkSize,
          telegram_text_chunk_size_bytes: textChunkSize,
          telegram_image_chunk_size_bytes: imageChunkSize
        })
      }),
      adminEnv
    );
    const updateBody = await updateResponse.json() as {
      settings: {
        telegram_chunk_size_bytes: number;
        telegram_video_chunk_size_bytes: number;
        telegram_audio_chunk_size_bytes: number;
        telegram_text_chunk_size_bytes: number;
        telegram_image_chunk_size_bytes: number;
      };
    };

    expect(updateResponse.status).toBe(200);
    expect(updateBody.settings).toMatchObject({
      telegram_chunk_size_bytes: defaultChunkSize,
      telegram_video_chunk_size_bytes: videoChunkSize,
      telegram_audio_chunk_size_bytes: audioChunkSize,
      telegram_text_chunk_size_bytes: textChunkSize,
      telegram_image_chunk_size_bytes: imageChunkSize
    });

    const videoInit = await initAdminMultipartForTest(adminEnv, cookie, {
      file_name: "clip.mp4",
      mime_type: "video/mp4",
      size: 5 * 1024 * 1024
    });
    const textInit = await initAdminMultipartForTest(adminEnv, cookie, {
      file_name: "notes.md",
      mime_type: "application/octet-stream",
      size: 10 * 1024 * 1024
    });
    const audioInit = await initAdminMultipartForTest(adminEnv, cookie, {
      file_name: "song.mp3",
      mime_type: "application/octet-stream",
      size: 11 * 1024 * 1024
    });
    const imageInit = await initAdminMultipartForTest(adminEnv, cookie, {
      file_name: "photo.webp",
      mime_type: "image/webp",
      size: 7 * 1024 * 1024
    });
    const defaultInit = await initAdminMultipartForTest(adminEnv, cookie, {
      file_name: "archive.bin",
      mime_type: "application/octet-stream",
      size: 17 * 1024 * 1024
    });

    expect(videoInit.upload.chunk_size).toBe(videoChunkSize);
    expect(videoInit.upload.chunk_count).toBe(5);
    expect(textInit.upload.chunk_size).toBe(textChunkSize);
    expect(textInit.upload.chunk_count).toBe(1);
    expect(audioInit.upload.chunk_size).toBe(audioChunkSize);
    expect(audioInit.upload.chunk_count).toBe(2);
    expect(imageInit.upload.chunk_size).toBe(imageChunkSize);
    expect(imageInit.upload.chunk_count).toBe(3);
    expect(defaultInit.upload.chunk_size).toBe(defaultChunkSize);
    expect(defaultInit.upload.chunk_count).toBe(3);
  });

  it("creates, lists, reveals, disables, and deletes upload API keys", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);

    const createResponse = await handleRequest(
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

    const listResponse = await handleRequest(
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

    const detailResponse = await handleRequest(
      new Request(`https://files.example.com/api/admin/api-keys/${createBody.api_key.id}`, {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const detailBody = await detailResponse.json() as { api_key: { key: string } };
    expect(detailBody.api_key.key).toBe(createBody.api_key.key);

    const patchResponse = await handleRequest(
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

    const deleteResponse = await handleRequest(
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

  it("uploads from admin UI and writes database metadata with a path-only file URL", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
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
    const response = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
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

    const response = await handleRequest(
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

  it("rejects duplicate URL upload names and accepts an explicit replacement file name", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "existing-report",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      file_path: "/f/token/report.pdf",
      directory_path: "/imports"
    }));
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/report.pdf";
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const inputUrl = String(input);

      if (inputUrl === sourceUrl) {
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename=\"report.pdf\"",
            "Content-Length": String(pdfBytes.byteLength)
          }
        });
      }

      return jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "tg-report-copy",
            file_unique_id: "tg-report-copy-unique",
            file_name: "report-copy.pdf",
            mime_type: "application/pdf",
            file_size: pdfBytes.byteLength
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const conflictResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: sourceUrl,
          directory_path: "/imports"
        })
      }),
      adminEnv
    );
    const conflictBody = await conflictResponse.json() as {
      error: string;
      details: { directory_path: string; file_name: string; suggested_name: string; source: string };
    };

    expect(conflictResponse.status).toBe(409);
    expect(conflictBody.error).toBe("FileNameConflict");
    expect(conflictBody.details).toMatchObject({
      directory_path: "/imports",
      file_name: "report.pdf",
      suggested_name: "report (1).pdf",
      source: "file"
    });
    expect(db.files).toHaveLength(1);

    const renamedResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: sourceUrl,
          directory_path: "/imports",
          file_name: "report-copy.pdf"
        })
      }),
      adminEnv
    );
    const renamedBody = await renamedResponse.json() as { ok: boolean; file: { file_name: string; directory_path: string } };

    expect(renamedResponse.status).toBe(200);
    expect(renamedBody.ok).toBe(true);
    expect(renamedBody.file).toMatchObject({
      file_name: "report-copy.pdf",
      directory_path: "/imports"
    });
    expect(db.files).toHaveLength(2);
    expect(db.files[1]?.file_name).toBe("report-copy.pdf");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("overwrites an existing admin URL upload when requested", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "existing-report",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      file_path: "/f/old/report.pdf",
      directory_path: "/imports",
      telegram_file_id: "tg-old-report"
    }));
    db.fileChunks.push({
      file_id: "existing-report",
      chunk_index: 0,
      size: 4,
      md5: "old-chunk",
      telegram_file_id: "tg-old-chunk",
      telegram_file_unique_id: null,
      created_at: "2026-06-01T00:00:01.000Z"
    });
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/report.pdf";
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === sourceUrl) {
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename=\"report.pdf\"",
            "Content-Length": String(pdfBytes.byteLength)
          }
        });
      }

      return jsonResponse({
        ok: true,
        result: {
          document: {
            file_id: "tg-new-report",
            file_unique_id: "tg-new-report-unique",
            file_name: "report.pdf",
            mime_type: "application/pdf",
            file_size: pdfBytes.byteLength
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: sourceUrl,
          directory_path: "/imports",
          on_conflict: "overwrite"
        })
      }),
      adminEnv
    );
    const body = await response.json() as { ok: boolean; file: { file_name: string; telegram_file_id: string; directory_path: string } };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file).toMatchObject({
      file_name: "report.pdf",
      telegram_file_id: "tg-new-report",
      directory_path: "/imports"
    });
    expect(db.files).toHaveLength(1);
    expect(db.files[0]?.id).not.toBe("existing-report");
    expect(db.files[0]?.telegram_file_id).toBe("tg-new-report");
    expect(db.fileChunks).toHaveLength(0);
    expect(db.batchCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("initializes a range-based URL multipart upload", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const response = await handleRequest(
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
    expect(body.upload.chunk_count).toBe(13);
    expect(db.multipartUploads[0]?.source_url).toBe(sourceUrl);
    expect(db.multipartUploads[0]?.remark).toBe("大文件 URL");
  });

  it("returns a thumbnail source for URL video uploads up to 20 GiB", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const sourceUrl = "https://source.example.com/max-video.mp4";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      if (String(input) === sourceUrl && init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Content-Length": String(maxMultipartFileBytes),
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes"
          }
        });
      }

      if (String(input) === sourceUrl && headers.get("Range") === "bytes=0-0") {
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-0/${maxMultipartFileBytes}`,
            "Content-Length": "1"
          }
        });
      }

      throw new Error(`Unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
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
      mode: string;
      upload: {
        file_name: string;
        mime_type: string;
        size: number;
        thumbnail_source: {
          available: boolean;
          kind: string;
          mime_type: string;
          url: string;
        } | null;
      };
    };

    expect(response.status).toBe(201);
    expect(body.mode).toBe("multipart");
    expect(body.upload.file_name).toBe("max-video.mp4");
    expect(body.upload.mime_type).toBe("video/mp4");
    expect(body.upload.size).toBe(maxMultipartFileBytes);
    expect(body.upload.thumbnail_source).toMatchObject({
      available: true,
      kind: "video",
      mime_type: "video/mp4"
    });
    expect(body.upload.thumbnail_source?.url).toContain("/api/admin/uploads/url-thumbnail-source?token=");
  });

  it("can force a small admin URL upload into multipart mode", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const response = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const response = await handleRequest(
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

  it("preflights folder uploads and reports existing and queued file name conflicts", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "existing-trip-photo",
      file_name: "a.jpg",
      directory_path: "/photos/trip"
    }));
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/preflight", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          entries: [
            {
              client_id: "local-a",
              directory_path: "/photos/trip",
              file_name: "a.jpg",
              relative_path: "trip/a.jpg",
              size: 10
            },
            {
              client_id: "local-b",
              directory_path: "/photos/trip",
              file_name: "b.jpg",
              relative_path: "trip/b.jpg",
              size: 11
            },
            {
              client_id: "local-b-duplicate",
              directory_path: "/photos/trip",
              file_name: "b.jpg",
              relative_path: "trip/copy/b.jpg",
              size: 12
            }
          ]
        })
      }),
      adminEnv
    );
    const body = await response.json() as {
      summary: { total: number; ready: number; conflicts: number };
      entries: Array<{
        client_id: string;
        status: string;
        source?: string;
        suggested_name?: string;
        directory_path: string;
        file_name: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({ total: 3, ready: 1, conflicts: 2 });
    expect(body.entries).toEqual([
      expect.objectContaining({
        client_id: "local-a",
        status: "conflict",
        source: "file",
        suggested_name: "a (1).jpg",
        directory_path: "/photos/trip",
        file_name: "a.jpg"
      }),
      expect.objectContaining({
        client_id: "local-b",
        status: "ready",
        directory_path: "/photos/trip",
        file_name: "b.jpg"
      }),
      expect.objectContaining({
        client_id: "local-b-duplicate",
        status: "conflict",
        source: "batch",
        suggested_name: "b (1).jpg",
        directory_path: "/photos/trip",
        file_name: "b.jpg"
      })
    ]);
    expect(db.directories).toHaveLength(0);
    expect(db.multipartUploads).toHaveLength(0);
  });

  it("preflights every existing file conflict in a repeated folder upload", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(
      fileRecord({ id: "existing-folder-a", file_name: "a.txt", directory_path: "/uploads/project" }),
      fileRecord({ id: "existing-folder-b", file_name: "b.txt", directory_path: "/uploads/project" }),
      fileRecord({ id: "existing-folder-c", file_name: "c.txt", directory_path: "/uploads/project" })
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/preflight", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          entries: [
            { client_id: "folder-a", directory_path: "/uploads/project", file_name: "a.txt", relative_path: "project/a.txt" },
            { client_id: "folder-b", directory_path: "/uploads/project", file_name: "b.txt", relative_path: "project/b.txt" },
            { client_id: "folder-c", directory_path: "/uploads/project", file_name: "c.txt", relative_path: "project/c.txt" }
          ]
        })
      }),
      adminEnv
    );
    const body = await response.json() as {
      summary: { total: number; ready: number; conflicts: number };
      entries: Array<{ client_id: string; status: string; source?: string; file_name: string; suggested_name?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({ total: 3, ready: 0, conflicts: 3 });
    expect(body.entries).toEqual([
      expect.objectContaining({ client_id: "folder-a", status: "conflict", source: "file", file_name: "a.txt", suggested_name: "a (1).txt" }),
      expect.objectContaining({ client_id: "folder-b", status: "conflict", source: "file", file_name: "b.txt", suggested_name: "b (1).txt" }),
      expect.objectContaining({ client_id: "folder-c", status: "conflict", source: "file", file_name: "c.txt", suggested_name: "c (1).txt" })
    ]);
  });

  it("rejects multipart upload sessions that reuse an active file name", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "existing-big-file",
      file_name: "big.bin",
      directory_path: "/incoming/big"
    }));
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
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
    const body = await response.json() as {
      error: string;
      details: { directory_path: string; file_name: string; suggested_name: string; source: string };
    };

    expect(response.status).toBe(409);
    expect(body.error).toBe("FileNameConflict");
    expect(body.details).toMatchObject({
      directory_path: "/incoming/big",
      file_name: "big.bin",
      suggested_name: "big (1).bin",
      source: "file"
    });
    expect(db.multipartUploads).toHaveLength(0);
  });

  it("allows restarting a multipart upload when an incomplete session has the same file name", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.multipartUploads.push({
      id: "pending-big-upload",
      source_kind: "local",
      source_url: null,
      file_name: "big.bin",
      mime_type: "application/octet-stream",
      size: 25 * 1024 * 1024,
      chunk_size: 10 * 1024 * 1024,
      chunk_count: 3,
      remark: null,
      uploaded_by: "admin",
      created_at: "2026-06-01T00:00:00.000Z",
      completed_at: null,
      directory_id: null,
      directory_path: "/incoming/big"
    });
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
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
    const body = await response.json() as {
      ok: boolean;
      upload: { id: string; file_name: string; directory_path: string };
    };

    expect(response.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.upload.file_name).toBe("big.bin");
    expect(body.upload.directory_path).toBe("/incoming/big");
    expect(body.upload.id).not.toBe("pending-big-upload");
    expect(db.multipartUploads).toHaveLength(2);
    expect(db.multipartUploads[0]?.completed_at).toBeNull();
    expect(db.files).toHaveLength(0);
  });

  it("reports uploaded and missing chunks for an incomplete admin multipart upload", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const upload: MultipartUploadRecord = {
      id: "upload-status",
      source_kind: "url",
      source_url: "https://source.example.com/movie.mp4",
      file_name: "movie.mp4",
      mime_type: "video/mp4",
      size: 40,
      chunk_size: 10,
      chunk_count: 4,
      remark: null,
      uploaded_by: "admin",
      created_at: "2026-06-01T00:00:00.000Z",
      completed_at: null,
      directory_id: null,
      directory_path: "/imports"
    };
    db.multipartUploads.push(upload);
    db.fileChunks.push(
      {
        file_id: upload.id,
        chunk_index: 0,
        size: 10,
        md5: "chunk-0",
        telegram_file_id: "tg-0",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:00.000Z"
      },
      {
        file_id: upload.id,
        chunk_index: 2,
        size: 10,
        md5: "chunk-2",
        telegram_file_id: "tg-2",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:00.000Z"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request(`https://files.example.com/api/admin/uploads/${upload.id}/status`, {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      upload: { id: string; source_kind: string; chunk_count: number; direct_access: boolean; directory_path: string };
      uploaded_chunks: number[];
      missing_chunks: number[];
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.upload).toMatchObject({
      id: upload.id,
      source_kind: "url",
      chunk_count: 4,
      direct_access: true,
      directory_path: "/imports"
    });
    expect(body.uploaded_chunks).toEqual([0, 2]);
    expect(body.missing_chunks).toEqual([1, 3]);
  });

  it("decrypts AES-128 HLS segments before storing them in Telegram", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const playlistText = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000001
#EXTINF:4.000,
seg-0.ts
#EXT-X-ENDLIST
`;
    db.hlsAssets.push(hlsAssetRecord({
      id: "hls-encrypted",
      final_file_id: null,
      status: "pending",
      source_url: "https://media.example.com/index.m3u8",
      source_headers_json: JSON.stringify({
        Referer: "https://app.example.com/hls",
        Cookie: "hls_sid=abc",
        "X-HLS-Token": "hls-token"
      }),
      media_playlist_url: "https://media.example.com/path/index.m3u8",
      playlist_text: playlistText,
      segment_count: 1,
      estimated_size: null
    }));
    db.hlsSegments.push(hlsSegmentRecord(0, {
      id: "hls-encrypted-segment-0",
      asset_id: "hls-encrypted",
      source_url: "https://media.example.com/path/seg-0.ts",
      status: "pending",
      size: null,
      storage_backend: null,
      telegram_file_id: null,
      completed_at: null
    }));
    const keyBytes = new Uint8Array([
      0x00, 0x01, 0x02, 0x03,
      0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b,
      0x0c, 0x0d, 0x0e, 0x0f
    ]);
    const ivBytes = new Uint8Array(16);
    ivBytes[15] = 1;
    const plainBytes = new TextEncoder().encode("decrypted ts payload");
    const encryptedBytes = await aesCbcEncrypt(plainBytes, keyBytes, ivBytes);
    let uploadedBytes: Uint8Array | null = null;
    const fetchCalls: Array<{
      input: string;
      referer: string | null;
      cookie: string | null;
      hlsToken: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = String(input);
        const headers = new Headers(init?.headers);
        fetchCalls.push({
          input: inputUrl,
          referer: headers.get("Referer"),
          cookie: headers.get("Cookie"),
          hlsToken: headers.get("X-HLS-Token")
        });

        if (inputUrl === "https://media.example.com/path/seg-0.ts" && init?.method === "HEAD") {
          return new Response(null, {
            headers: {
              "Content-Length": String(encryptedBytes.byteLength),
              "Content-Type": "video/mp2t"
            }
          });
        }
        if (inputUrl === "https://media.example.com/path/seg-0.ts") {
          return new Response(encryptedBytes, {
            headers: {
              "Content-Length": String(encryptedBytes.byteLength),
              "Content-Type": "video/mp2t"
            }
          });
        }
        if (inputUrl === "https://media.example.com/path/enc.key") {
          return new Response(new Blob([toExactArrayBuffer(keyBytes)]), {
            headers: {
              "Content-Length": String(keyBytes.byteLength),
              "Content-Type": "application/octet-stream"
            }
          });
        }
        if (inputUrl === "https://api.telegram.org/bot123456:test-token/sendDocument") {
          const formData = init?.body as FormData;
          const document = formData.get("document");
          if (!(document instanceof Blob)) {
            throw new Error("Expected Telegram document Blob");
          }
          uploadedBytes = new Uint8Array(await document.arrayBuffer());
          return jsonResponse({
            ok: true,
            result: {
              document: {
                file_id: "tg-decrypted-hls-segment",
                file_unique_id: "tg-decrypted-unique",
                file_name: "seg-0.ts",
                mime_type: "video/mp2t",
                file_size: document.size
              }
            }
          });
        }

        throw new Error(`Unexpected fetch ${inputUrl}`);
      })
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/hls/hls-encrypted/segments/0/import", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      segment: { status: string; storage_backend: string; size: number };
    };

    expect(response.status).toBe(200);
    expect(body.segment).toMatchObject({
      status: "done",
      storage_backend: "telegram_single",
      size: plainBytes.byteLength
    });
    expect(uploadedBytes).toEqual(plainBytes);
    expect(db.hlsSegments[0]).toMatchObject({
      status: "done",
      size: plainBytes.byteLength,
      storage_backend: "telegram_single",
      telegram_file_id: "tg-decrypted-hls-segment"
    });
    expect(fetchCalls).toEqual([
      {
        input: "https://media.example.com/path/seg-0.ts",
        referer: "https://app.example.com/hls",
        cookie: "hls_sid=abc",
        hlsToken: "hls-token"
      },
      {
        input: "https://media.example.com/path/seg-0.ts",
        referer: "https://app.example.com/hls",
        cookie: "hls_sid=abc",
        hlsToken: "hls-token"
      },
      {
        input: "https://media.example.com/path/enc.key",
        referer: "https://app.example.com/hls",
        cookie: "hls_sid=abc",
        hlsToken: "hls-token"
      },
      {
        input: "https://api.telegram.org/bot123456:test-token/sendDocument",
        referer: null,
        cookie: null,
        hlsToken: null
      }
    ]);
  });

  it("imports fMP4 init and byte-range segments, then exposes playable and downloadable URLs", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const mediaUrl = "https://media.example.com/path/video.mp4";
    const playlistText = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="video.mp4",BYTERANGE="4@0"
#EXTINF:4.000,
#EXT-X-BYTERANGE:5@4
video.mp4
#EXT-X-ENDLIST
`;
    db.hlsAssets.push(hlsAssetRecord({
      id: "hls-fmp4",
      final_file_id: null,
      status: "pending",
      source_url: "https://media.example.com/path/index.m3u8",
      media_playlist_url: "https://media.example.com/path/index.m3u8",
      file_name: "movie.m3u8",
      playlist_text: playlistText,
      segment_count: 1,
      target_duration_seconds: 4,
      duration_seconds: 4,
      estimated_size: null,
      init_source_url: mediaUrl,
      init_byte_range_start: 0,
      init_byte_range_length: 4,
      init_mime_type: "video/mp4",
      init_status: "pending"
    }));
    db.hlsSegments.push(hlsSegmentRecord(0, {
      id: "hls-fmp4-segment-0",
      asset_id: "hls-fmp4",
      variant_id: "media",
      source_url: mediaUrl,
      byte_range_start: 4,
      byte_range_length: 5,
      duration_seconds: 4,
      mime_type: "video/mp4",
      status: "pending",
      size: null,
      storage_backend: null,
      telegram_file_id: null,
      completed_at: null
    }));
    const sourceFetchCalls: Array<{ method: string | undefined; range: string | null }> = [];
    const uploadedDocuments: string[] = [];
    let sendDocumentCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = String(input);
        const headers = new Headers(init?.headers);

        if (inputUrl === mediaUrl) {
          sourceFetchCalls.push({ method: init?.method, range: headers.get("Range") });
          if (init?.method === "HEAD") {
            return new Response(null, {
              headers: {
                "Content-Length": "9",
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes"
              }
            });
          }
          if (headers.get("Range") === "bytes=0-3") {
            return new Response("init", {
              status: 206,
              headers: {
                "Content-Length": "4",
                "Content-Range": "bytes 0-3/9",
                "Content-Type": "video/mp4"
              }
            });
          }
          if (headers.get("Range") === "bytes=4-8") {
            return new Response("media", {
              status: 206,
              headers: {
                "Content-Length": "5",
                "Content-Range": "bytes 4-8/9",
                "Content-Type": "video/mp4"
              }
            });
          }
        }

        if (inputUrl === "https://api.telegram.org/bot123456:test-token/sendDocument") {
          sendDocumentCalls += 1;
          const formData = init?.body as FormData;
          const document = formData.get("document");
          if (!(document instanceof Blob)) {
            throw new Error("Expected Telegram document Blob");
          }
          uploadedDocuments.push(await document.text());
          return jsonResponse({
            ok: true,
            result: {
              document: {
                file_id: sendDocumentCalls === 1 ? "tg-fmp4-init" : "tg-fmp4-segment-0",
                file_unique_id: sendDocumentCalls === 1 ? "tg-fmp4-init-unique" : "tg-fmp4-segment-0-unique",
                file_name: sendDocumentCalls === 1 ? "video.mp4" : "video.mp4",
                mime_type: "video/mp4",
                file_size: document.size
              }
            }
          });
        }

        if (inputUrl.includes("file_id=tg-fmp4-init")) {
          return jsonResponse({ ok: true, result: { file_id: "tg-fmp4-init", file_path: "documents/fmp4-init" } });
        }
        if (inputUrl.includes("file_id=tg-fmp4-segment-0")) {
          return jsonResponse({ ok: true, result: { file_id: "tg-fmp4-segment-0", file_path: "documents/fmp4-segment-0" } });
        }
        if (inputUrl.endsWith("/documents/fmp4-init")) {
          return new Response("init", {
            headers: { "Content-Type": "video/mp4", "Content-Length": "4" }
          });
        }
        if (inputUrl.endsWith("/documents/fmp4-segment-0")) {
          return new Response("media", {
            headers: { "Content-Type": "video/mp4", "Content-Length": "5" }
          });
        }

        throw new Error(`Unexpected fetch ${inputUrl}`);
      })
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const importResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/hls/hls-fmp4/segments/0/import", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const importBody = await importResponse.json() as { segment: { status: string; storage_backend: string; size: number } };

    expect(importResponse.status).toBe(200);
    expect(importBody.segment).toMatchObject({ status: "done", storage_backend: "telegram_single", size: 5 });
    expect(uploadedDocuments).toEqual(["init", "media"]);
    expect(sourceFetchCalls.map((call) => call.range).filter(Boolean)).toEqual(["bytes=0-3", "bytes=4-8"]);
    expect(db.hlsAssets[0]).toMatchObject({
      init_status: "done",
      init_size: 4,
      init_storage_backend: "telegram_single",
      init_telegram_file_id: "tg-fmp4-init"
    });
    expect(db.hlsSegments[0]).toMatchObject({
      status: "done",
      size: 5,
      storage_backend: "telegram_single",
      telegram_file_id: "tg-fmp4-segment-0"
    });

    const previewResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/hls/hls-fmp4/preview.m3u8", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const previewPlaylist = await previewResponse.text();
    expect(previewResponse.status).toBe(200);
    expect(previewPlaylist).toContain('#EXT-X-MAP:URI="https://files.example.com/api/admin/uploads/hls/hls-fmp4/preview-init/video.mp4"');
    expect(previewPlaylist).not.toContain("#EXT-X-BYTERANGE");
    expect(previewPlaylist).toContain("/preview-segments/0");

    const completeResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/hls/hls-fmp4/complete", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const completeBody = await completeResponse.json() as {
      file: { id: string; url: string; size: number; storage_backend: string };
    };

    expect(completeResponse.status).toBe(200);
    expect(completeBody.file).toMatchObject({
      id: "hls-fmp4",
      size: 9,
      storage_backend: "hls_package"
    });

    const publicPlaylistResponse = await handleRequest(new Request(completeBody.file.url), adminEnv);
    const publicPlaylist = await publicPlaylistResponse.text();
    expect(publicPlaylistResponse.status).toBe(200);
    expect(publicPlaylist).toMatch(/#EXT-X-MAP:URI="https:\/\/files\.example\.com\/api\/hls\/[^/]+\/init\/video\.mp4"/);
    expect(publicPlaylist).not.toContain("#EXT-X-BYTERANGE");
    expect(publicPlaylist).toMatch(/https:\/\/files\.example\.com\/api\/hls\/[^/]+\/segments\/0\/video\.mp4/);

    const downloadPlanResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files/hls-fmp4/hls-download", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const downloadPlanBody = await downloadPlanResponse.json() as {
      hls_download: {
        file_name: string;
        kind: string;
        total_size: number;
        part_count: number;
        parts: Array<{ kind: string; segment_index: number | null; chunk_index: number | null; offset: number; size: number; url: string }>;
      };
    };
    expect(downloadPlanResponse.status).toBe(200);
    expect(downloadPlanBody.hls_download).toMatchObject({
      file_name: "movie.mp4",
      kind: "fmp4",
      total_size: 9,
      part_count: 2
    });
    expect(downloadPlanBody.hls_download.parts.map(({ kind, segment_index, chunk_index, offset, size }) => ({
      kind,
      segment_index,
      chunk_index,
      offset,
      size
    }))).toEqual([
      { kind: "init", segment_index: null, chunk_index: null, offset: 0, size: 4 },
      { kind: "segment", segment_index: 0, chunk_index: null, offset: 4, size: 5 }
    ]);
    expect(new URL(downloadPlanBody.hls_download.parts[0]?.url || "").pathname).toMatch(/^\/api\/hls\/[^/]+\/init\/video\.mp4$/);

    const directDownloadResponse = await handleRequest(new Request(`${completeBody.file.url}?download=1`), adminEnv);
    expect(directDownloadResponse.status).toBe(200);
    expect(directDownloadResponse.headers.get("Content-Type")).toBe("video/mp4");
    expect(directDownloadResponse.headers.get("Content-Disposition")).toContain("movie.mp4");
    expect(await directDownloadResponse.text()).toBe("initmedia");
  });

  it("uses stored source headers for HLS multipart segment chunk imports", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const sourceHeaders = {
      Referer: "https://app.example.com/hls-large",
      Cookie: "large_hls_sid=abc",
      "X-HLS-Token": "large-hls-token"
    };
    const segmentSize = telegramChunkSizeBytes + 4;
    const segmentUrl = "https://media.example.com/path/large-0.ts";
    db.hlsAssets.push(hlsAssetRecord({
      id: "hls-large",
      final_file_id: null,
      status: "pending",
      source_url: "https://media.example.com/index.m3u8",
      source_headers_json: JSON.stringify(sourceHeaders),
      media_playlist_url: "https://media.example.com/path/index.m3u8",
      playlist_text: "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\nlarge-0.ts\n#EXT-X-ENDLIST\n",
      segment_count: 1,
      estimated_size: null
    }));
    db.hlsSegments.push(hlsSegmentRecord(0, {
      id: "hls-large-segment-0",
      asset_id: "hls-large",
      source_url: segmentUrl,
      status: "pending",
      size: null,
      storage_backend: null,
      telegram_file_id: null,
      completed_at: null
    }));
    const sourceFetchCalls: Array<{
      range: string | null;
      referer: string | null;
      cookie: string | null;
      hlsToken: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = String(input);
        const headers = new Headers(init?.headers);

        if (inputUrl === segmentUrl) {
          sourceFetchCalls.push({
            range: headers.get("Range"),
            referer: headers.get("Referer"),
            cookie: headers.get("Cookie"),
            hlsToken: headers.get("X-HLS-Token")
          });

          if (init?.method === "HEAD") {
            return new Response(null, {
              headers: {
                "Content-Length": String(segmentSize),
                "Content-Type": "video/mp2t",
                "Accept-Ranges": "bytes"
              }
            });
          }

          if (headers.get("Range") === "bytes=0-0") {
            return new Response("x", {
              status: 206,
              headers: {
                "Content-Length": "1",
                "Content-Range": `bytes 0-0/${segmentSize}`,
                "Content-Type": "video/mp2t"
              }
            });
          }

          if (headers.get("Range") === `bytes=${telegramChunkSizeBytes}-${segmentSize - 1}`) {
            return new Response("tail", {
              status: 206,
              headers: {
                "Content-Length": "4",
                "Content-Range": `bytes ${telegramChunkSizeBytes}-${segmentSize - 1}/${segmentSize}`,
                "Content-Type": "video/mp2t"
              }
            });
          }
        }

        if (inputUrl === "https://api.telegram.org/bot123456:test-token/sendDocument") {
          const formData = init?.body as FormData;
          const document = formData.get("document");
          if (!(document instanceof Blob)) {
            throw new Error("Expected Telegram document Blob");
          }
          expect(document.size).toBe(4);
          return jsonResponse({
            ok: true,
            result: {
              document: {
                file_id: "tg-hls-large-chunk-1",
                file_unique_id: "tg-hls-large-chunk-1-unique",
                file_name: "large-0.ts.part-2-of-2",
                mime_type: "video/mp2t",
                file_size: document.size
              }
            }
          });
        }

        throw new Error(`Unexpected fetch ${inputUrl}`);
      })
    );
    const cookie = await loginAndGetCookie(adminEnv);
    const settingsResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/settings", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ telegram_video_chunk_size_bytes: telegramChunkSizeBytes })
      }),
      adminEnv
    );
    expect(settingsResponse.status).toBe(200);

    const initResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/hls/hls-large/segments/0/import", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const initBody = await initResponse.json() as {
      segment: { storage_backend: string; chunk_count: number };
      missing_chunks: number[];
    };

    expect(initResponse.status).toBe(200);
    expect(initBody.segment).toMatchObject({
      storage_backend: "telegram_multipart",
      chunk_count: 2
    });
    expect(initBody.missing_chunks).toEqual([0, 1]);
    expect(JSON.parse(db.multipartUploads[0]?.source_headers_json || "{}")).toMatchObject(sourceHeaders);

    const chunkResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/hls/hls-large/segments/0/chunks/1/import", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );

    expect(chunkResponse.status).toBe(200);
    expect(db.fileChunks[0]).toMatchObject({
      file_id: db.multipartUploads[0]?.id,
      chunk_index: 1,
      size: 4,
      telegram_file_id: "tg-hls-large-chunk-1"
    });
    expect(sourceFetchCalls).toEqual([
      {
        range: null,
        referer: sourceHeaders.Referer,
        cookie: sourceHeaders.Cookie,
        hlsToken: sourceHeaders["X-HLS-Token"]
      },
      {
        range: "bytes=0-0",
        referer: sourceHeaders.Referer,
        cookie: sourceHeaders.Cookie,
        hlsToken: sourceHeaders["X-HLS-Token"]
      },
      {
        range: `bytes=${telegramChunkSizeBytes}-${segmentSize - 1}`,
        referer: sourceHeaders.Referer,
        cookie: sourceHeaders.Cookie,
        hlsToken: sourceHeaders["X-HLS-Token"]
      }
    ]);
  });

  it("completes multipart uploads above the former direct-link budget with a full file link", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const chunkCount = formerDirectAccessMaxChunks + 1;
    const upload: MultipartUploadRecord = {
      id: "upload-large",
      source_kind: "local",
      source_url: null,
      file_name: "large.bin",
      mime_type: "application/octet-stream",
      size: chunkCount * 3,
      chunk_size: 3,
      chunk_count: chunkCount,
      remark: "超过旧直链预算",
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

    const response = await handleRequest(
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
    expect(body.file.url).toMatch(/^https:\/\/cdn\.example\.com\/f\//);
    expect(body.file.download_url).toBe(`${body.file.url}?download=1`);
    expect(body.file.direct_access).toBe(true);
    expect(body.file.download_strategy).toBe("direct_or_accelerated");
    expect(body.file.storage_backend).toBe("telegram_multipart");
    expect(body.file.chunk_count).toBe(chunkCount);
    expect(db.files[0]?.file_path).toBe(body.file.file_path);
    expect(db.multipartUploads[0]?.completed_at).not.toBeNull();
    expect(db.batchCalls).toBe(1);
  });

  it("rejects multipart completion if the target file name was claimed during upload", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "existing-race-file",
      file_name: "race.bin",
      directory_path: "/race"
    }));
    db.multipartUploads.push({
      id: "upload-race",
      source_kind: "local",
      source_url: null,
      file_name: "race.bin",
      mime_type: "application/octet-stream",
      size: 6,
      chunk_size: 3,
      chunk_count: 2,
      remark: null,
      uploaded_by: "admin",
      created_at: "2026-06-01T00:00:00.000Z",
      completed_at: null,
      directory_id: null,
      directory_path: "/race"
    });
    db.fileChunks.push(
      {
        file_id: "upload-race",
        chunk_index: 0,
        size: 3,
        md5: "chunk-0",
        telegram_file_id: "tg-chunk-0",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:01.000Z"
      },
      {
        file_id: "upload-race",
        chunk_index: 1,
        size: 3,
        md5: "chunk-1",
        telegram_file_id: "tg-chunk-1",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:02.000Z"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/upload-race/complete", {
        method: "POST",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      error: string;
      details: { directory_path: string; file_name: string; source: string };
    };

    expect(response.status).toBe(409);
    expect(body.error).toBe("FileNameConflict");
    expect(body.details).toMatchObject({
      directory_path: "/race",
      file_name: "race.bin",
      source: "file"
    });
    expect(db.files).toHaveLength(1);
    expect(db.multipartUploads[0]?.completed_at).toBeNull();
    expect(db.batchCalls).toBe(0);
  });

  it("overwrites a file claimed during multipart upload when requested", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "existing-race-file",
      file_name: "race.bin",
      directory_path: "/race",
      telegram_file_id: "tg-old-race"
    }));
    db.multipartUploads.push({
      id: "upload-race",
      source_kind: "local",
      source_url: null,
      file_name: "race.bin",
      mime_type: "application/octet-stream",
      size: 6,
      chunk_size: 3,
      chunk_count: 2,
      remark: null,
      uploaded_by: "admin",
      created_at: "2026-06-01T00:00:00.000Z",
      completed_at: null,
      directory_id: null,
      directory_path: "/race"
    });
    db.fileChunks.push(
      {
        file_id: "upload-race",
        chunk_index: 0,
        size: 3,
        md5: "chunk-0",
        telegram_file_id: "tg-chunk-0",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:01.000Z"
      },
      {
        file_id: "upload-race",
        chunk_index: 1,
        size: 3,
        md5: "chunk-1",
        telegram_file_id: "tg-chunk-1",
        telegram_file_unique_id: null,
        created_at: "2026-06-01T00:00:02.000Z"
      }
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/uploads/upload-race/complete", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ on_conflict: "overwrite" })
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: { id: string; file_name: string; storage_backend: string; directory_path: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file).toMatchObject({
      id: "upload-race",
      file_name: "race.bin",
      storage_backend: "telegram_multipart",
      directory_path: "/race"
    });
    expect(db.files).toHaveLength(1);
    expect(db.files[0]?.id).toBe("upload-race");
    expect(db.files[0]?.telegram_file_id).toBe("multipart:upload-race");
    expect(db.multipartUploads.find((item) => item.id === "upload-race")?.completed_at).not.toBeNull();
    expect(db.batchCalls).toBe(1);
  });

  it("cleans stale incomplete multipart uploads on the scheduled trigger", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      STALE_MULTIPART_UPLOAD_TTL_HOURS: "24"
    };
    const uploads: MultipartUploadRecord[] = [
      {
        id: "stale-upload",
        source_kind: "local",
        source_url: null,
        file_name: "stale.bin",
        mime_type: "application/octet-stream",
        size: 6,
        chunk_size: 3,
        chunk_count: 2,
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-05-31T23:59:59.000Z",
        completed_at: null,
        directory_id: null,
        directory_path: "/"
      },
      {
        id: "recent-upload",
        source_kind: "local",
        source_url: null,
        file_name: "recent.bin",
        mime_type: "application/octet-stream",
        size: 3,
        chunk_size: 3,
        chunk_count: 1,
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-06-01T01:00:00.000Z",
        completed_at: null,
        directory_id: null,
        directory_path: "/"
      },
      {
        id: "completed-upload",
        source_kind: "local",
        source_url: null,
        file_name: "done.bin",
        mime_type: "application/octet-stream",
        size: 3,
        chunk_size: 3,
        chunk_count: 1,
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-05-31T00:00:00.000Z",
        completed_at: "2026-05-31T00:05:00.000Z",
        directory_id: null,
        directory_path: "/"
      },
      {
        id: "indexed-upload",
        source_kind: "local",
        source_url: null,
        file_name: "indexed.bin",
        mime_type: "application/octet-stream",
        size: 3,
        chunk_size: 3,
        chunk_count: 1,
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-05-31T00:00:00.000Z",
        completed_at: null,
        directory_id: null,
        directory_path: "/"
      }
    ];
    db.multipartUploads.push(...uploads);
    db.files.push({
      id: "indexed-upload",
      file_name: "indexed.bin",
      mime_type: "application/octet-stream",
      size: 3,
      md5: "multipart:chunk-indexed-upload",
      telegram_file_id: "multipart:indexed-upload",
      telegram_file_unique_id: null,
      file_path: "/f/token/indexed.bin",
      remark: null,
      uploaded_by: "admin",
      created_at: "2026-05-31T00:05:00.000Z",
      deleted_at: null,
      directory_id: null,
      directory_path: "/",
      storage_backend: "telegram_multipart",
      chunk_size: 3,
      chunk_count: 1
    });
    for (const upload of uploads) {
      db.fileChunks.push({
        file_id: upload.id,
        chunk_index: 0,
        size: 3,
        md5: `chunk-${upload.id}`,
        telegram_file_id: `tg-${upload.id}`,
        telegram_file_unique_id: null,
        created_at: upload.created_at
      });
    }

    await runScheduledCleanup(adminEnv, Date.parse("2026-06-02T00:00:00.000Z"), "0 */6 * * *");

    expect(db.batchCalls).toBe(2);
    expect(db.multipartUploads.map((item) => item.id)).toEqual([
      "recent-upload",
      "completed-upload",
      "indexed-upload"
    ]);
    expect(db.fileChunks.map((item) => item.file_id)).toEqual([
      "recent-upload",
      "completed-upload",
      "indexed-upload"
    ]);
  });

  it("rejects multipart upload sessions over the limit with human-readable sizes", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const actualFileBytes = maxMultipartFileBytes + 1;
    const response = await handleRequest(
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
    expect(body.message).toContain("20G");
    expect(body.message).toContain("20G1B");
    expect(body.details.max_file_bytes).toBe(maxMultipartFileBytes);
    expect(body.details.actual_file_bytes).toBe(actualFileBytes);
    expect(body.details.max_file_size).toBe("20G");
    expect(body.details.actual_file_size).toBe("20G1B");
    expect(body.details.chunk_size).toBe("10MB");
  });

  it("rejects oversized URL multipart sources with compact human-readable sizes", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const response = await handleRequest(
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
    expect(body.message).toContain("20G");
    expect(body.message).toContain("1T20G");
    expect(body.details.max_file_bytes).toBe(maxMultipartFileBytes);
    expect(body.details.actual_file_bytes).toBe(actualFileBytes);
    expect(body.details.max_file_size).toBe("20G");
    expect(body.details.actual_file_size).toBe("1T20G");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads an existing signed file URL without fetching the public source URL", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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
      AppEnv.LINK_SIGNING_SECRET
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

    const response = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    const cookie = await loginAndGetCookie(adminEnv);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleRequest(
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

  it("lists and hard-deletes database file records", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
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
    db.multipartUploads.push({
      id: "file-1",
      source_kind: "local",
      source_url: null,
      file_name: "report.pdf",
      mime_type: "application/pdf",
      size: 12,
      chunk_size: 12,
      chunk_count: 1,
      remark: "季度归档资料",
      uploaded_by: "admin",
      created_at: "2026-05-27T00:00:00.000Z",
      completed_at: "2026-05-27T00:01:00.000Z",
      directory_id: null,
      directory_path: "/"
    });
    const cookie = await loginAndGetCookie(adminEnv);

    const listResponse = await handleRequest(
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

    const deleteResponse = await handleRequest(
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
    expect(db.multipartUploads).toHaveLength(0);

    const afterDeleteResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const afterDeleteBody = await afterDeleteResponse.json() as { pagination: { total: number } };
    expect(afterDeleteBody.pagination.total).toBe(0);
  });

  it("returns an HLS direct download link when HLS parts exceed the former direct-link budget", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "file-hls",
      file_name: "movie.m3u8",
      mime_type: "application/vnd.apple.mpegurl",
      size: 123,
      md5: "hls-md5",
      telegram_file_id: "hls:hls-asset",
      telegram_file_unique_id: null,
      file_path: "/hls/signed-token/movie.m3u8",
      storage_backend: "hls_package",
      chunk_size: null,
      chunk_count: null
    }));
    db.hlsAssets.push(hlsAssetRecord({
      segment_count: formerDirectAccessMaxChunks + 1,
      duration_seconds: formerDirectAccessMaxChunks + 1,
      estimated_size: formerDirectAccessMaxChunks + 1
    }));
    db.hlsSegments.push(
      ...Array.from({ length: formerDirectAccessMaxChunks + 1 }, (_, index) =>
        hlsSegmentRecord(index, {
          size: 1,
          duration_seconds: 1
        })
      )
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      files: Array<{
        id: string;
        url: string | null;
        download_url: string | null;
        direct_access: boolean;
        direct_download: boolean;
        download_strategy: string;
        hls_download: {
          part_count: number;
          direct_access: boolean;
          direct_access_max_parts: number;
          downloadable: boolean;
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      id: "file-hls",
      url: "https://cdn.example.com/api/hls/signed-token/movie.m3u8",
      download_url: "https://cdn.example.com/api/hls/signed-token/movie.m3u8?download=1",
      direct_access: true,
      direct_download: true,
      download_strategy: "direct_or_accelerated"
    });
    expect(body.files[0]?.hls_download).toMatchObject({
      part_count: formerDirectAccessMaxChunks + 1,
      direct_access: true,
      direct_access_max_parts: directAccessMaxChunks,
      downloadable: true
    });
  });

  it("returns an HLS accelerated download plan with contiguous part offsets", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "file-hls",
      file_name: "movie.m3u8",
      mime_type: "application/vnd.apple.mpegurl",
      size: 123,
      md5: "hls-md5",
      telegram_file_id: "hls:hls-asset",
      telegram_file_unique_id: null,
      file_path: "/hls/signed-token/movie.m3u8",
      storage_backend: "hls_package",
      chunk_size: null,
      chunk_count: null
    }));
    db.hlsAssets.push(hlsAssetRecord({
      segment_count: 2,
      estimated_size: 7
    }));
    db.hlsSegments.push(
      hlsSegmentRecord(0, {
        size: 3
      }),
      hlsSegmentRecord(1, {
        size: 4,
        storage_backend: "telegram_multipart",
        telegram_file_id: null,
        telegram_file_unique_id: null,
        multipart_upload_id: "hls-segment-upload",
        chunk_size: 3,
        chunk_count: 2
      })
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files/file-hls/hls-download", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      hls_download: {
        file_id: string;
        file_name: string;
        total_size: number;
        segment_count: number;
        part_count: number;
        direct_access: boolean;
        direct_access_max_parts: number;
        parts: Array<{
          index: number;
          segment_index: number;
          chunk_index: number | null;
          offset: number;
          size: number;
          url: string;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.hls_download).toMatchObject({
      file_id: "file-hls",
      file_name: "movie.ts",
      total_size: 7,
      segment_count: 2,
      part_count: 3,
      direct_access: true,
      direct_access_max_parts: directAccessMaxChunks
    });
    expect(body.hls_download.parts.map(({ index, segment_index, chunk_index, offset, size }) => ({
      index,
      segment_index,
      chunk_index,
      offset,
      size
    }))).toEqual([
      { index: 0, segment_index: 0, chunk_index: null, offset: 0, size: 3 },
      { index: 1, segment_index: 1, chunk_index: 0, offset: 3, size: 3 },
      { index: 2, segment_index: 1, chunk_index: 1, offset: 6, size: 1 }
    ]);
    expect(new URL(body.hls_download.parts[0]?.url || "").pathname).toMatch(/^\/api\/hls\/[^/]+\/segments\/0\/seg-0\.ts$/);
    expect(new URL(body.hls_download.parts[1]?.url || "").pathname).toMatch(/^\/api\/hls\/[^/]+\/segments\/1\/chunks\/0$/);
    expect(new URL(body.hls_download.parts[2]?.url || "").pathname).toMatch(/^\/api\/hls\/[^/]+\/segments\/1\/chunks\/1$/);
  });

  it("filters database file records by filename, remark, type and upload time", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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
        id: "file-video",
        file_name: "clip.mp4",
        mime_type: "video/mp4",
        size: 50,
        md5: "video-md5",
        telegram_file_id: "tg-video",
        telegram_file_unique_id: null,
        file_path: "/f/token/clip.mp4",
        remark: null,
        uploaded_by: "admin",
        created_at: "2026-05-29T02:00:00.000Z",
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

    const remarkResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files?q=季度", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const remarkBody = await remarkResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(remarkBody.pagination.total).toBe(1);
    expect(remarkBody.files[0]?.id).toBe("file-pdf");

    const imageResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files?type=image", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const imageBody = await imageResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(imageBody.pagination.total).toBe(1);
    expect(imageBody.files[0]?.id).toBe("file-image");

    const videoResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files?type=video", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const videoBody = await videoResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(videoBody.pagination.total).toBe(1);
    expect(videoBody.files[0]?.id).toBe("file-video");

    const limitedResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files?limit=2", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const limitedBody = await limitedResponse.json() as { files: Array<{ id: string }>; pagination: { total: number } };
    expect(limitedBody.pagination.total).toBe(5);
    expect(limitedBody.files).toHaveLength(2);

    const allResponse = await handleRequest(
      new Request("https://files.example.com/api/admin/files?all=1&limit=2", {
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const allBody = await allResponse.json() as { files: Array<{ id: string }>; pagination: { total: number; total_pages: number } };
    expect(allBody.pagination.total).toBe(5);
    expect(allBody.pagination.total_pages).toBe(1);
    expect(allBody.files).toHaveLength(5);

    const dateResponse = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
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

    const remarkResponse = await handleRequest(
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

    const renameResponse = await handleRequest(
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
    const payload = await verifySignedToken(token, AppEnv.LINK_SIGNING_SECRET);

    expect(renameResponse.status).toBe(200);
    expect(renameBody.file.file_name).toBe("new name.txt");
    expect(renameBody.file.remark).toBeNull();
    expect(renameBody.file.file_path).toMatch(/^\/f\/.+\/new%20name\.txt$/);
    expect(renameBody.file.file_path).not.toBe("/f/old-token/old.txt");
    expect(renameBody.file.url).toBe(`https://cdn.example.com${renameBody.file.file_path}`);
    expect(renameBody.file.download_url).toBe(`${renameBody.file.url}?download=1`);
    expect(payload).toMatchObject({
      v: 3,
      channel_id: "default",
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

  it("updates an existing file thumbnail from multipart upload", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "file-thumb",
      file_name: "movie.mp4",
      mime_type: "video/mp4",
      size: 1024,
      telegram_file_id: "tg-movie"
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const inputUrl = String(input);
      if (inputUrl.endsWith("/sendDocument")) {
        return jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-thumbnail",
              file_unique_id: "unique-thumbnail",
              file_name: "movie.thumbnail.jpg",
              mime_type: "image/jpeg",
              file_size: 4
            }
          }
        });
      }

      throw new Error(`Unexpected fetch ${inputUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cookie = await loginAndGetCookie(adminEnv);
    const form = new FormData();
    form.set("thumbnail", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "cover.jpg", { type: "image/jpeg" }));
    form.set("thumbnail_width", "320");
    form.set("thumbnail_height", "180");

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files/file-thumb/thumbnail", {
        method: "PUT",
        headers: { Cookie: cookie },
        body: form
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: {
        thumbnail_status: string;
        thumbnail_url: string | null;
        thumbnail_file_id: string | null;
        thumbnail_file_path: string | null;
        thumbnail_width: number | null;
        thumbnail_height: number | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.file.thumbnail_status).toBe("ready");
    expect(body.file.thumbnail_file_id).toBe("tg-thumbnail");
    expect(body.file.thumbnail_url).toMatch(/^https:\/\/cdn\.example\.com\/f\//);
    expect(body.file.thumbnail_width).toBe(320);
    expect(body.file.thumbnail_height).toBe(180);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.files[0]).toMatchObject({
      thumbnail_file_id: "tg-thumbnail",
      thumbnail_file_unique_id: "unique-thumbnail",
      thumbnail_file_path: body.file.thumbnail_file_path,
      thumbnail_mime_type: "image/jpeg",
      thumbnail_size: 4,
      thumbnail_width: 320,
      thumbnail_height: 180,
      thumbnail_status: "ready"
    });
  });

  it("updates an existing file thumbnail from a remote URL with custom headers", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      PUBLIC_BASE_URL: "https://cdn.example.com",
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "file-thumb-url",
      file_name: "remote-video.mp4",
      mime_type: "video/mp4",
      size: 2048,
      telegram_file_id: "tg-remote-video"
    }));
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sourceHeadersSeen: Array<{
      accept: string | null;
      authorization: string | null;
      referer: string | null;
    }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = String(input);
      if (inputUrl === "https://images.example.com/cover.png") {
        const headers = new Headers(init?.headers);
        sourceHeadersSeen.push({
          accept: headers.get("Accept"),
          authorization: headers.get("Authorization"),
          referer: headers.get("Referer")
        });
        return new Response(pngBytes, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(pngBytes.byteLength)
          }
        });
      }

      if (inputUrl.endsWith("/sendDocument")) {
        return jsonResponse({
          ok: true,
          result: {
            document: {
              file_id: "tg-thumbnail-url",
              file_unique_id: "unique-thumbnail-url",
              file_name: "remote-video.thumbnail.png",
              mime_type: "image/png",
              file_size: pngBytes.byteLength
            }
          }
        });
      }

      throw new Error(`Unexpected fetch ${inputUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files/file-thumb-url/thumbnail", {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          thumbnail_url: "https://images.example.com/cover.png",
          thumbnail_headers: {
            Authorization: "Bearer cover-token",
            Referer: "https://images.example.com/gallery"
          },
          thumbnail_width: 640,
          thumbnail_height: 360
        })
      }),
      adminEnv
    );
    const body = await response.json() as {
      file: {
        thumbnail_status: string;
        thumbnail_url: string | null;
        thumbnail_file_id: string | null;
        thumbnail_mime_type: string | null;
        thumbnail_width: number | null;
        thumbnail_height: number | null;
      };
    };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sourceHeadersSeen[0]).toMatchObject({
      authorization: "Bearer cover-token",
      referer: "https://images.example.com/gallery"
    });
    expect(sourceHeadersSeen[0]?.accept).toContain("image/png");
    expect(body.file).toMatchObject({
      thumbnail_status: "ready",
      thumbnail_file_id: "tg-thumbnail-url",
      thumbnail_mime_type: "image/png",
      thumbnail_width: 640,
      thumbnail_height: 360
    });
    expect(body.file.thumbnail_url).toMatch(/^https:\/\/cdn\.example\.com\/f\//);
    expect(db.files[0]).toMatchObject({
      thumbnail_file_id: "tg-thumbnail-url",
      thumbnail_file_unique_id: "unique-thumbnail-url",
      thumbnail_mime_type: "image/png",
      thumbnail_size: pngBytes.byteLength,
      thumbnail_status: "ready"
    });
  });

  it("clears an existing file thumbnail", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.files.push(fileRecord({
      id: "file-thumb-clear",
      thumbnail_file_id: "tg-thumbnail",
      thumbnail_file_unique_id: "unique-thumbnail",
      thumbnail_file_path: "/f/thumb-token/movie.thumbnail.jpg",
      thumbnail_mime_type: "image/jpeg",
      thumbnail_size: 4,
      thumbnail_width: 320,
      thumbnail_height: 180,
      thumbnail_status: "ready"
    }));
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files/file-thumb-clear/thumbnail", {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      adminEnv
    );
    const body = await response.json() as {
      ok: boolean;
      file: {
        thumbnail_status: string;
        thumbnail_url: string | null;
        thumbnail_file_id: string | null;
        thumbnail_file_path: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.file.thumbnail_status).toBe("none");
    expect(body.file.thumbnail_url).toBeNull();
    expect(body.file.thumbnail_file_id).toBeNull();
    expect(body.file.thumbnail_file_path).toBeNull();
    expect(db.files[0]).toMatchObject({
      thumbnail_file_id: null,
      thumbnail_file_unique_id: null,
      thumbnail_file_path: null,
      thumbnail_mime_type: null,
      thumbnail_size: null,
      thumbnail_width: null,
      thumbnail_height: null,
      thumbnail_status: "none"
    });
  });

  it("rejects moving a file into a directory that already has the same file name", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "secret"
    };
    db.directories.push({
      id: "dir-archive",
      parent_id: null,
      name: "archive",
      path: "/archive",
      created_at: "2026-06-01T00:00:00.000Z",
      deleted_at: null
    });
    db.files.push(
      fileRecord({
        id: "file-source-report",
        file_name: "report.txt",
        directory_path: "/inbox"
      }),
      fileRecord({
        id: "file-archive-report",
        file_name: "report.txt",
        directory_id: "dir-archive",
        directory_path: "/archive"
      })
    );
    const cookie = await loginAndGetCookie(adminEnv);

    const response = await handleRequest(
      new Request("https://files.example.com/api/admin/files/move", {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_ids: ["file-source-report"],
          directory_path: "/archive"
        })
      }),
      adminEnv
    );
    const body = await response.json() as {
      error: string;
      details: { directory_path: string; file_name: string; suggested_name: string; source: string };
    };

    expect(response.status).toBe(409);
    expect(body.error).toBe("FileNameConflict");
    expect(body.details).toMatchObject({
      directory_path: "/archive",
      file_name: "report.txt",
      suggested_name: "report (1).txt",
      source: "file"
    });
    expect(db.files.find((item) => item.id === "file-source-report")?.directory_path).toBe("/inbox");
  });

  it("creates virtual directories, moves files, searches current directory, and recursively hard-deletes directories", async () => {
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const createResponse = await handleRequest(
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

    const rootListResponse = await handleRequest(
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

    const rootSearchResponse = await handleRequest(
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

    const childSearchResponse = await handleRequest(
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

    const moveResponse = await handleRequest(
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

    const deleteResponse = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const response = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const response = await handleRequest(
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

    const invalidResponse = await handleRequest(
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

    const renameResponse = await handleRequest(
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
    const db = new FakeDatabase();
    const adminEnv: AppEnv = {
      ...AppEnv,
      DATABASE: db as unknown as AppDatabase,
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

    const moveResponse = await handleRequest(
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

    const deleteResponse = await handleRequest(
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

async function loginAndGetCookie(envWithAdmin: AppEnv): Promise<string> {
  const response = await handleRequest(
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

async function initAdminMultipartForTest(
  envWithAdmin: AppEnv,
  cookie: string,
  body: { file_name: string; mime_type: string; size: number }
): Promise<{ upload: { chunk_size: number; chunk_count: number } }> {
  const response = await handleRequest(
    new Request("https://files.example.com/api/admin/uploads/init", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }),
    envWithAdmin
  );

  expect(response.status).toBe(201);
  return response.json() as Promise<{ upload: { chunk_size: number; chunk_count: number } }>;
}
