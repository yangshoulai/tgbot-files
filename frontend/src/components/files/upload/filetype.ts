import { type MultipartUpload } from "../../../api";

export function isVideoUploadCandidate(upload: Pick<MultipartUpload, "mime_type" | "file_name">): boolean {
  return upload.mime_type.toLowerCase().startsWith("video/") || /\.(mp4|m4v|mov|webm|ogv)$/i.test(upload.file_name);
}
