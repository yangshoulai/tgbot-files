import { type ThumbnailUploadPayload } from "../../../api";
import type { GeneratedThumbnail } from "../../../lib/thumbnail";
import type { UploadThumbnailState } from "./types";

export function generatedThumbnailPayload(thumbnail: GeneratedThumbnail): ThumbnailUploadPayload {
  return {
    blob: thumbnail.blob,
    fileName: thumbnail.fileName,
    ...(thumbnail.width ? { width: thumbnail.width } : {}),
    ...(thumbnail.height ? { height: thumbnail.height } : {})
  };
}

export function thumbnailStatePayload(thumbnail: UploadThumbnailState | undefined): ThumbnailUploadPayload | undefined {
  if (thumbnail?.status !== "ready") {
    return undefined;
  }

  if (thumbnail.generated) {
    return generatedThumbnailPayload(thumbnail.generated);
  }

  if (thumbnail.remote) {
    return {
      sourceUrl: thumbnail.remote.url,
      ...(thumbnail.remote.headers ? { sourceHeaders: thumbnail.remote.headers } : {})
    };
  }

  return undefined;
}
