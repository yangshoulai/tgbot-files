import type { ThumbnailUploadPayload } from "../api";

export type ThumbnailKind = "image" | "video";

export interface GeneratedThumbnail extends ThumbnailUploadPayload {
  objectUrl: string;
  source: "auto" | "manual";
}

export interface RemoteThumbnailSource {
  kind: ThumbnailKind;
  url: string;
  mime_type?: string;
}

const MAX_SIDE = 320;
const JPEG_QUALITY = 0.82;
const VIDEO_SEEK_SECONDS = 0.75;

export function canAutoGenerateThumbnail(file: File): boolean {
  return thumbnailKindForFile(file) !== null;
}

export function thumbnailKindForFile(file: Pick<File, "type" | "name">): ThumbnailKind | null {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    return "image";
  }

  if (mime.startsWith("video/") || /\.(mp4|m4v|mov|webm|ogv)$/i.test(name)) {
    return "video";
  }

  if (/\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i.test(name)) {
    return "image";
  }

  return null;
}

export async function generateThumbnailFromFile(file: File, source: "auto" | "manual" = "auto"): Promise<GeneratedThumbnail> {
  const kind = thumbnailKindForFile(file);

  if (kind === "image" || source === "manual") {
    return renderImageThumbnail(file, source);
  }

  if (kind === "video") {
    const objectUrl = URL.createObjectURL(file);
    try {
      return await renderVideoThumbnail(objectUrl, file.name, source, true);
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  throw new Error("该文件类型不支持自动生成缩略图");
}

export async function generateThumbnailFromRemoteSource(source: RemoteThumbnailSource, fileName = "remote-file"): Promise<GeneratedThumbnail> {
  if (source.kind === "image") {
    return renderImageThumbnail(source.url, "auto", fileName);
  }

  return renderVideoThumbnail(source.url, fileName, "auto", false);
}

export function revokeThumbnail(thumbnail: GeneratedThumbnail | undefined): void {
  if (thumbnail?.objectUrl) {
    URL.revokeObjectURL(thumbnail.objectUrl);
  }
}

async function renderImageThumbnail(
  source: Blob | string,
  generatedSource: "auto" | "manual",
  fileName = source instanceof Blob && "name" in source ? String(source.name) : "thumbnail"
): Promise<GeneratedThumbnail> {
  const objectUrl = typeof source === "string" ? source : URL.createObjectURL(source);
  const shouldRevokeSource = typeof source !== "string";
  const image = await loadImage(objectUrl);

  try {
    const canvas = drawToCanvas(image.naturalWidth, image.naturalHeight, (context, width, height) => {
      context.drawImage(image, 0, 0, width, height);
    });
    return await canvasToGeneratedThumbnail(canvas, fileName, generatedSource);
  } finally {
    if (shouldRevokeSource) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

async function renderVideoThumbnail(
  sourceUrl: string,
  fileName: string,
  generatedSource: "auto" | "manual",
  revokeSourceUrl: boolean
): Promise<GeneratedThumbnail> {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;

  try {
    const metadataReady = waitForVideoMetadata(video);
    video.src = sourceUrl;
    await metadataReady;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : VIDEO_SEEK_SECONDS;
    const targetTime = Math.min(VIDEO_SEEK_SECONDS, Math.max(0, duration * 0.1));
    await seekVideo(video, targetTime);

    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      throw new Error("无法读取视频画面尺寸");
    }

    const canvas = drawToCanvas(width, height, (context, targetWidth, targetHeight) => {
      context.drawImage(video, 0, 0, targetWidth, targetHeight);
    });

    return await canvasToGeneratedThumbnail(canvas, fileName, generatedSource);
  } finally {
    video.removeAttribute("src");
    video.load();
    if (revokeSourceUrl) {
      URL.revokeObjectURL(sourceUrl);
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片缩略图生成失败"));
    image.src = src;
  });
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频元数据读取超时"));
    }, 12000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频缩略图生成失败"));
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频定位超时"));
    }, 12000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频帧读取失败"));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("loadeddata", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    try {
      video.currentTime = Math.max(0, time);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("视频定位失败"));
    }
  });
}

function drawToCanvas(
  sourceWidth: number,
  sourceHeight: number,
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void
): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("当前浏览器不支持 Canvas");
  }

  canvas.width = width;
  canvas.height = height;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  draw(context, width, height);

  return canvas;
}

async function canvasToGeneratedThumbnail(
  canvas: HTMLCanvasElement,
  sourceFileName: string,
  generatedSource: "auto" | "manual"
): Promise<GeneratedThumbnail> {
  const blob = await canvasToBlob(canvas);
  const objectUrl = URL.createObjectURL(blob);

  return {
    blob,
    fileName: thumbnailFileName(sourceFileName),
    width: canvas.width,
    height: canvas.height,
    objectUrl,
    source: generatedSource
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("缩略图编码失败"));
        }
      },
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

function thumbnailFileName(fileName: string): string {
  const normalized = fileName.split(/[\\/]/).pop() || "thumbnail";
  const base = normalized.replace(/\.[^./\\]{1,12}$/i, "") || "thumbnail";
  return `${base}.thumbnail.jpg`;
}
