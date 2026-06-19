export type {
  StorageBackend,
  MultipartSourceKind,
  HlsAssetStatus,
  HlsSegmentStatus,
  HlsSegmentStorageBackend,
  MagnetImportStatus,
  MagnetImportFileStatus,
  DirectoryRecord,
  FileRecord,
  ThumbnailStatus,
  NewFileRecord,
  UpdateFileThumbnailRecord,
  FileListResult,
  FileUsageStats,
  FileNameConflictRecord,
  FileNameConflictAction,
  FileTypeFilter,
  ApiKeyStatus,
  ApiKeyRecord,
  NewApiKeyRecord,
  MultipartUploadRecord,
  NewMultipartUploadRecord,
  FileChunkRecord,
  NewFileChunkRecord,
  MagnetImportRecord,
  NewMagnetImportRecord,
  MagnetImportFileRecord,
  NewMagnetImportFileRecord,
  TelegramChannelStatus,
  TelegramChannelRecord,
  NewTelegramChannelRecord,
  UpdateTelegramChannelRecord,
  TelegramChannelUsage,
  MultipartCleanupResult,
  HlsAssetRecord,
  NewHlsAssetRecord,
  HlsSegmentRecord,
  NewHlsSegmentRecord,
  HlsCleanupResult
} from "./database/types";

export { requireDb } from "./database/shared";

export {
  getDirectoryRecord,
  getDirectoryRecordByPath,
  listDirectoryChildren,
  listAllDirectoryRecords,
  getDirectoryUsageStats,
  insertDirectoryRecord,
  deleteDirectoryTree,
  moveDirectoryTree,
  renameDirectoryTree
} from "./database/directories";

export {
  insertFileRecord,
  insertFileRecordWithConflictAction,
  listFileRecords,
  getFileRecord,
  findActiveFileNameConflict,
  deleteFileRecord,
  updateFileRecordMetadata,
  updateFileRecordThumbnail,
  getGlobalFileUsageStats,
  moveFileRecords
} from "./database/files";

export {
  upsertFileChunkRecord,
  listFileChunkRecords,
  getFileChunkRecord
} from "./database/file-chunks";

export {
  insertMultipartUploadRecord,
  getMultipartUploadRecord,
  listIncompleteMultipartUploadRecords,
  completeMultipartUploadRecord,
  updateMultipartUploadDirectory,
  completeMultipartUploadWithFileRecord,
  deleteStaleMultipartUploadData
} from "./database/multipart-uploads";

export {
  insertMagnetImportRecord,
  getMagnetImportRecord,
  listIncompleteMagnetImportRecords,
  findReusableMagnetImportRecord,
  listRestartableMagnetImportRecordsBySource,
  listMagnetImportRecordsForAria2Cleanup,
  listProtectedMagnetImportRecordsForAria2Cleanup,
  listMagnetImportFileRecords,
  getMagnetImportFileRecord,
  replaceMagnetImportFiles,
  markMagnetImportFailed,
  markMagnetImportDownloading,
  markMagnetImportDownloaded,
  markMagnetImportImporting,
  markMagnetImportDoneIfComplete,
  cancelMagnetImportRecord,
  selectMagnetImportFiles,
  updateMagnetImportFileStatus
} from "./database/magnet-imports";

export {
  listTelegramChannelRecords,
  listActiveTelegramChannelRecords,
  getTelegramChannelRecord,
  insertTelegramChannelRecord,
  updateTelegramChannelRecord,
  deleteTelegramChannelRecord,
  getTelegramChannelUsage
} from "./database/telegram-channels";

export {
  insertHlsAssetRecord,
  insertHlsSegmentRecords,
  getHlsAssetRecord,
  listIncompleteHlsAssetRecords,
  getHlsAssetRecordByFinalFileId,
  listHlsSegmentRecords,
  getHlsSegmentRecordByIndex,
  markHlsAssetStatus,
  markHlsSegmentImporting,
  markHlsInitSegmentImporting,
  completeHlsInitSegmentSingle,
  completeHlsSegmentSingle,
  attachHlsSegmentMultipartUpload,
  completeHlsSegmentMultipart,
  failHlsSegment,
  failHlsInitSegment,
  completeHlsAssetWithFileRecord,
  deleteHlsAssetTempData,
  deleteStaleHlsUploadData
} from "./database/hls";

export {
  insertApiKeyRecord,
  listApiKeyRecords,
  getApiKeyRecord,
  findActiveApiKeyRecord,
  touchApiKeyRecord,
  updateApiKeyRecord,
  softDeleteApiKeyRecord
} from "./database/api-keys";

export {
  UPLOAD_CONCURRENCY_SETTING_KEY,
  DEFAULT_UPLOAD_CONCURRENCY,
  MIN_UPLOAD_CONCURRENCY,
  MAX_UPLOAD_CONCURRENCY,
  VIDEO_PREVIEW_CACHE_BYTES_SETTING_KEY,
  DEFAULT_VIDEO_PREVIEW_CACHE_BYTES,
  MIN_VIDEO_PREVIEW_CACHE_BYTES,
  MAX_VIDEO_PREVIEW_CACHE_BYTES,
  TELEGRAM_CHUNK_SIZE_BYTES_SETTING_KEY,
  TELEGRAM_VIDEO_CHUNK_SIZE_BYTES_SETTING_KEY,
  TELEGRAM_AUDIO_CHUNK_SIZE_BYTES_SETTING_KEY,
  TELEGRAM_TEXT_CHUNK_SIZE_BYTES_SETTING_KEY,
  TELEGRAM_IMAGE_CHUNK_SIZE_BYTES_SETTING_KEY,
  DEFAULT_TELEGRAM_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_VIDEO_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_AUDIO_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_TEXT_CHUNK_SIZE_BYTES,
  DEFAULT_TELEGRAM_IMAGE_CHUNK_SIZE_BYTES,
  MIN_TELEGRAM_CHUNK_SIZE_BYTES,
  MAX_TELEGRAM_CHUNK_SIZE_BYTES,
  getUploadConcurrencySetting,
  setUploadConcurrencySetting,
  getVideoPreviewCacheBytesSetting,
  setVideoPreviewCacheBytesSetting,
  getTelegramChunkSizeBytesSetting,
  setTelegramChunkSizeBytesSetting,
  getTelegramVideoChunkSizeBytesSetting,
  setTelegramVideoChunkSizeBytesSetting,
  getTelegramAudioChunkSizeBytesSetting,
  setTelegramAudioChunkSizeBytesSetting,
  getTelegramTextChunkSizeBytesSetting,
  setTelegramTextChunkSizeBytesSetting,
  getTelegramImageChunkSizeBytesSetting,
  setTelegramImageChunkSizeBytesSetting
} from "./database/settings";
