// This module is a thin re-export facade. The implementation has been split into
// cohesive service modules under ../services/. The six consumers of this module
// import the symbols below and continue to work unchanged.

export { runScheduledCleanup } from "../services/scheduled-cleanup";

export {
  getPublicBaseUrl,
  normalizeFileNameConflictAction,
  thumbnailRecordUpdateFields,
  emptyThumbnailRecordUpdateFields,
  normalizeChunkIndex,
  expectedChunkSize,
  validateChunkFile,
  missingChunkIndexes,
  hlsPublicSegmentPath,
  hlsPublicInitSegmentPath
} from "../services/storage-shared";

export {
  resolveTelegramChannel,
  getRateLimitedTelegramFileUrl
} from "../services/telegram-channel";

export {
  createMultipartUpload,
  probeRemoteSourceForMultipart,
  downloadAndUploadRemoteChunk,
  uploadChunkToTelegram,
  completeMultipartUpload,
  uploadThumbnailToTelegram,
  uploadAndRecordFile,
  createFilePathForRecord,
  requireMultipartUpload
} from "../services/multipart-upload";

export {
  readUploadInput,
  readCompleteUploadInput
} from "../services/upload-download";

export {
  createThumbnailSourceInfo,
  handleThumbnailSourceProxy
} from "../services/thumbnail-source";

export {
  requireFileRecord,
  requireFileNameAvailable,
  requireFileNameWritable,
  normalizeUploadPreflightEntries,
  preflightUploadEntries,
  requireFileMoveNamesAvailable,
  requireUploadApiKey
} from "../services/upload-validation";

export {
  probeHlsSource,
  createHlsUpload,
  importHlsSegment,
  importHlsSegmentChunk,
  completeHlsMultipartSegment,
  completeHlsUpload,
  requireHlsAsset,
  requireMutableHlsAsset,
  requireHlsSegment,
  serializeHlsUploadResult,
  serializeHlsSegment
} from "../services/hls-upload";

export {
  handleAdminHlsPreviewPlaylist,
  serveHlsPackageDownload,
  serveStoredHlsInitSegment,
  serveStoredHlsSegment,
  serveHlsSegmentChunk
} from "../services/hls-delivery";

export {
  handleMultipartChunkAccess,
  handleMultipartChunkRecordAccess,
  handleMultipartFileAccess
} from "../services/multipart-access";

export {
  serializeFileRecord,
  serializeUploadedFileResult,
  serializeHlsDownloadPlanForFile
} from "../services/file-serialization";

export {
  cancelMagnetImportUpload,
  createMagnetImport,
  refreshMagnetImportStatus,
  initMagnetImportSelection,
  importMagnetFileChunk,
  completeMagnetFileUpload,
  serveMagnetThumbnailSource,
  serializeMagnetImport,
  normalizeMagnetFileUploadOptions
} from "../services/magnet-import";
