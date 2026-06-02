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
const VIDEO_FRAME_WAIT_TIMEOUT_MS = 800;
const VIDEO_BLANK_VARIANCE_THRESHOLD = 4;
const VIDEO_BLANK_WHITE_LUMA = 246;
const VIDEO_BLANK_BLACK_LUMA = 10;

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
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    const metadataReady = waitForVideoMetadata(video);
    video.src = sourceUrl;
    await metadataReady;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : VIDEO_SEEK_SECONDS;

    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      throw new Error("无法读取视频画面尺寸");
    }

    for (const targetTime of videoCaptureTimes(duration)) {
      await seekVideo(video, targetTime);
      await waitForVideoPaint(video);

      const canvas = drawToCanvas(
        width,
        height,
        (context, targetWidth, targetHeight) => {
          context.drawImage(video, 0, 0, targetWidth, targetHeight);
        },
        { fillBackground: false }
      );

      if (!isProbablyBlankVideoFrame(canvas)) {
        return await canvasToGeneratedThumbnail(canvas, fileName, generatedSource);
      }
    }

    throw new Error("视频截帧为空白，请手动选择缩略图");
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
    const targetTime = Math.max(0, time);

    if (video.readyState >= 2 && Math.abs(video.currentTime - targetTime) < 0.03) {
      resolve();
      return;
    }

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频定位超时"));
    }, 12000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
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
    video.addEventListener("error", onError, { once: true });

    try {
      video.currentTime = targetTime;
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("视频定位失败"));
    }
  });
}

function drawToCanvas(
  sourceWidth: number,
  sourceHeight: number,
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void,
  options: { fillBackground?: boolean } = { fillBackground: true }
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
  if (options.fillBackground !== false) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  draw(context, width, height);

  return canvas;
}

function videoCaptureTimes(duration: number): number[] {
  const rawCandidates = [
    0.1,
    0.35,
    VIDEO_SEEK_SECONDS,
    1.25,
    duration * 0.1,
    duration * 0.25
  ];
  const maxTime = Number.isFinite(duration) && duration > 0.1 ? duration - 0.05 : VIDEO_SEEK_SECONDS;
  const unique = new Set<number>();

  for (const candidate of rawCandidates) {
    if (!Number.isFinite(candidate)) continue;
    const clamped = Math.max(0, Math.min(candidate, maxTime));
    unique.add(Number(clamped.toFixed(2)));
  }

  return Array.from(unique).sort((left, right) => left - right);
}

async function waitForVideoPaint(video: HTMLVideoElement): Promise<void> {
  const frameVideo = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    let handle: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (handle !== undefined && typeof frameVideo.cancelVideoFrameCallback === "function") {
        frameVideo.cancelVideoFrameCallback(handle);
      }
      resolve();
    };

    if (typeof frameVideo.requestVideoFrameCallback === "function") {
      handle = frameVideo.requestVideoFrameCallback(finish);
    }

    window.setTimeout(finish, VIDEO_FRAME_WAIT_TIMEOUT_MS);
  });

  await nextAnimationFrame();
  await nextAnimationFrame();
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function isProbablyBlankVideoFrame(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return true;

  const { width, height } = canvas;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const sampleStep = Math.max(4, Math.floor(data.length / 1200 / 4) * 4);
  let count = 0;
  let alphaTotal = 0;
  let lumaTotal = 0;
  let lumaSquaredTotal = 0;

  for (let index = 0; index < data.length; index += sampleStep) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const alpha = data[index + 3] ?? 0;
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue;

    count += 1;
    alphaTotal += alpha;
    lumaTotal += luma;
    lumaSquaredTotal += luma * luma;
  }

  if (count === 0) return true;

  const alphaAverage = alphaTotal / count;
  const lumaAverage = lumaTotal / count;
  const variance = lumaSquaredTotal / count - lumaAverage * lumaAverage;

  if (alphaAverage < 8) return true;

  return variance < VIDEO_BLANK_VARIANCE_THRESHOLD &&
    (lumaAverage > VIDEO_BLANK_WHITE_LUMA || lumaAverage < VIDEO_BLANK_BLACK_LUMA);
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
