export type StorageBackend = "telegram_single" | "telegram_multipart" | "hls_package";
export type MultipartSourceKind = "local" | "url" | "magnet";
export type HlsAssetStatus = "pending" | "importing" | "done" | "failed" | "cancelled";
export type HlsSegmentStatus = "pending" | "importing" | "done" | "failed";
export type HlsSegmentStorageBackend = "telegram_single" | "telegram_multipart";
export type MagnetImportStatus = "probing" | "ready" | "downloading" | "downloaded" | "importing" | "done" | "failed" | "cancelled";
export type MagnetImportFileStatus = "pending" | "selected" | "uploading" | "done" | "failed";

export interface DirectoryRecord {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: string;
  deleted_at: string | null;
}

export interface FileRecord {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  md5: string;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  telegram_channel_id?: string;
  file_path: string;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  directory_id?: string | null;
  directory_path?: string;
  storage_backend?: StorageBackend;
  chunk_size?: number | null;
  chunk_count?: number | null;
  thumbnail_file_id?: string | null;
  thumbnail_file_unique_id?: string | null;
  thumbnail_file_path?: string | null;
  thumbnail_mime_type?: string | null;
  thumbnail_size?: number | null;
  thumbnail_width?: number | null;
  thumbnail_height?: number | null;
  thumbnail_status?: ThumbnailStatus;
}

export type ThumbnailStatus = "none" | "ready" | "failed";

export interface NewFileRecord {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  md5: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  telegramChannelId?: string;
  filePath: string;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath?: string;
  storageBackend?: StorageBackend;
  chunkSize?: number;
  chunkCount?: number;
  thumbnailFileId?: string;
  thumbnailFileUniqueId?: string;
  thumbnailFilePath?: string;
  thumbnailMimeType?: string;
  thumbnailSize?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  thumbnailStatus?: ThumbnailStatus;
}

export interface UpdateFileThumbnailRecord {
  thumbnailFileId: string | null;
  thumbnailFileUniqueId: string | null;
  thumbnailFilePath: string | null;
  thumbnailMimeType: string | null;
  thumbnailSize: number | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  thumbnailStatus: ThumbnailStatus;
}

export interface FileListResult {
  files: FileRecord[];
  total: number;
}

export interface FileUsageStats {
  file_count: number;
  total_size: number;
}

export interface FileNameConflictRecord {
  id: string;
  source: "file";
}

export type FileNameConflictAction = "error" | "overwrite";

export type FileTypeFilter = "image" | "video" | "text" | "pdf" | "archive" | "other";

export type ApiKeyStatus = "active" | "disabled";

export interface ApiKeyRecord {
  id: string;
  name: string;
  key: string;
  status: ApiKeyStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  deleted_at: string | null;
}

export interface NewApiKeyRecord {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}

export interface MultipartUploadRecord {
  id: string;
  source_kind: MultipartSourceKind;
  source_url: string | null;
  source_headers_json?: string | null;
  source_range_start?: number | null;
  file_name: string;
  mime_type: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  completed_at: string | null;
  directory_id?: string | null;
  telegram_channel_group?: string;
  directory_path?: string;
}

export interface NewMultipartUploadRecord {
  id: string;
  sourceKind: MultipartSourceKind;
  sourceUrl?: string;
  sourceHeadersJson?: string;
  sourceRangeStart?: number | null;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  directoryId?: string | null;
  directoryPath?: string;
  telegramChannelGroup?: string;
}

export interface FileChunkRecord {
  file_id: string;
  chunk_index: number;
  size: number;
  md5: string;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  telegram_channel_id?: string;
  created_at: string;
}

export interface NewFileChunkRecord {
  fileId: string;
  chunkIndex: number;
  size: number;
  md5: string;
  telegramFileId: string;
  telegramFileUniqueId?: string;
  telegramChannelId?: string;
  createdAt: string;
}

export interface MagnetImportRecord {
  id: string;
  magnet_uri: string;
  info_hash: string | null;
  name: string | null;
  status: MagnetImportStatus;
  aria2_metadata_gid: string | null;
  aria2_download_gid: string | null;
  download_dir: string;
  selected_indexes_json: string | null;
  file_count: number;
  total_size: number | null;
  error_message: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  metadata_completed_at: string | null;
  download_started_at: string | null;
  download_completed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface NewMagnetImportRecord {
  id: string;
  magnetUri: string;
  infoHash?: string | null;
  aria2MetadataGid: string;
  downloadDir: string;
  uploadedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MagnetImportFileRecord {
  id: string;
  import_id: string;
  file_index: number;
  path: string;
  file_name: string;
  relative_directory_path: string | null;
  size: number;
  mime_type: string;
  chunk_size: number;
  chunk_count: number;
  upload_id: string | null;
  selected: number;
  status: MagnetImportFileStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewMagnetImportFileRecord {
  id: string;
  importId: string;
  fileIndex: number;
  path: string;
  fileName: string;
  relativeDirectoryPath?: string | null;
  size: number;
  mimeType: string;
  chunkSize: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export type TelegramChannelStatus = "active" | "disabled";

export interface TelegramChannelRecord {
  id: string;
  name: string;
  bot_token_encrypted: string;
  bot_token_hash: string;
  chat_id: string;
  status: TelegramChannelStatus;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface NewTelegramChannelRecord {
  id: string;
  name: string;
  botTokenEncrypted: string;
  botTokenHash: string;
  chatId: string;
  status?: TelegramChannelStatus;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTelegramChannelRecord {
  id: string;
  name: string;
  botTokenEncrypted: string;
  botTokenHash: string;
  chatId: string;
  status: TelegramChannelStatus;
  updatedAt: string;
}

export interface TelegramChannelUsage {
  files: number;
  chunks: number;
}

export interface MultipartCleanupResult {
  deletedUploads: number;
  deletedChunks: number;
}

export interface HlsAssetRecord {
  id: string;
  source_url: string;
  source_headers_json?: string | null;
  media_playlist_url: string;
  file_name: string;
  mime_type: string;
  directory_id: string | null;
  directory_path: string;
  status: HlsAssetStatus;
  selected_variant_id: string | null;
  target_duration_seconds: number;
  duration_seconds: number;
  segment_count: number;
  estimated_size: number | null;
  playlist_text: string;
  playlist_file_id: string | null;
  final_file_id: string | null;
  init_source_url: string | null;
  init_byte_range_start: number | null;
  init_byte_range_length: number | null;
  init_mime_type: string | null;
  init_size: number | null;
  init_storage_backend: HlsSegmentStorageBackend | null;
  init_telegram_file_id: string | null;
  init_telegram_file_unique_id: string | null;
  init_telegram_channel_id: string;
  init_status: "none" | HlsSegmentStatus;
  init_error_message: string | null;
  init_completed_at: string | null;
  thumbnail_status: ThumbnailStatus;
  remark: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

export interface NewHlsAssetRecord {
  id: string;
  sourceUrl: string;
  sourceHeadersJson?: string;
  mediaPlaylistUrl: string;
  fileName: string;
  mimeType: string;
  directoryId?: string | null;
  directoryPath: string;
  status: HlsAssetStatus;
  selectedVariantId?: string | null;
  targetDurationSeconds: number;
  durationSeconds: number;
  segmentCount: number;
  estimatedSize?: number | null;
  playlistText: string;
  initSourceUrl?: string | null;
  initByteRangeStart?: number | null;
  initByteRangeLength?: number | null;
  initMimeType?: string | null;
  remark?: string;
  uploadedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HlsSegmentRecord {
  id: string;
  asset_id: string;
  variant_id: string;
  segment_index: number;
  source_url: string;
  byte_range_start: number | null;
  byte_range_length: number | null;
  duration_seconds: number;
  mime_type: string;
  size: number | null;
  storage_backend: HlsSegmentStorageBackend | null;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  telegram_channel_id: string;
  multipart_upload_id: string | null;
  chunk_size: number | null;
  chunk_count: number | null;
  status: HlsSegmentStatus;
  attempts: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewHlsSegmentRecord {
  id: string;
  assetId: string;
  variantId: string;
  segmentIndex: number;
  sourceUrl: string;
  byteRangeStart?: number | null;
  byteRangeLength?: number | null;
  durationSeconds: number;
  mimeType: string;
  size?: number | null;
  status: HlsSegmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HlsCleanupResult {
  deletedAssets: number;
  deletedSegments: number;
  deletedUploads: number;
  deletedChunks: number;
}
