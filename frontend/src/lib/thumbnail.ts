import type { ThumbnailUploadPayload } from "../api";
import Hls, { Events, type ErrorData } from "hls.js";

export type ThumbnailKind = "image" | "video" | "audio";

export interface GeneratedThumbnail extends ThumbnailUploadPayload {
  objectUrl: string;
  source: "auto" | "manual";
}

export interface RemoteThumbnailSource {
  kind: "image" | "video";
  url: string;
  mime_type?: string;
}

const MAX_SIDE = 320;
const JPEG_QUALITY = 0.82;
const VIDEO_SEEK_SECONDS = 0.75;
const VIDEO_FRAME_WAIT_TIMEOUT_MS = 800;
const HLS_THUMBNAIL_BUFFER_TIMEOUT_MS = 18000;
const VIDEO_BLANK_VARIANCE_THRESHOLD = 4;
const VIDEO_BLANK_WHITE_LUMA = 246;
const VIDEO_BLANK_BLACK_LUMA = 10;
const AUDIO_METADATA_SCAN_BYTES = 16 * 1024 * 1024;
const ID3_MAX_TAG_BYTES = 32 * 1024 * 1024;

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

  if (mime.startsWith("audio/") || /\.(mp3|m4a|m4b|aac|flac)$/i.test(name)) {
    return "audio";
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

  if (kind === "audio") {
    return renderAudioCoverThumbnail(file, source);
  }

  throw new Error("该文件类型不支持自动生成缩略图");
}

export async function generateThumbnailFromRemoteSource(source: RemoteThumbnailSource, fileName = "remote-file"): Promise<GeneratedThumbnail> {
  if (source.kind === "image") {
    return renderImageThumbnail(source.url, "auto", fileName);
  }

  return renderVideoThumbnail(source.url, fileName, "auto", false);
}

export async function generateThumbnailFromHlsPlaylist(playlistUrl: string, fileName = "hls-video.m3u8"): Promise<GeneratedThumbnail> {
  const video = document.createElement("video");
  let hls: Hls | null = null;

  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    const metadataReady = waitForVideoMetadata(video);
    let bufferReady: Promise<void>;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      bufferReady = waitForVideoReadyState(video, 2, "HLS 首帧加载超时");
      video.src = playlistUrl;
    } else if (Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 8,
        maxMaxBufferLength: 8,
        xhrSetup(xhr) {
          xhr.withCredentials = true;
        }
      });
      bufferReady = waitForHlsFirstFragment(video, hls);
      hls.attachMedia(video);
      hls.loadSource(playlistUrl);
    } else {
      throw new Error("当前浏览器不支持 HLS 预览");
    }

    await metadataReady;
    await bufferReady;
    return renderLoadedVideoThumbnail(video, fileName, "auto");
  } finally {
    hls?.destroy();
    video.removeAttribute("src");
    video.load();
  }
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

    return await renderLoadedVideoThumbnail(video, fileName, generatedSource, duration, width, height);
  } finally {
    video.removeAttribute("src");
    video.load();
    if (revokeSourceUrl) {
      URL.revokeObjectURL(sourceUrl);
    }
  }
}

async function renderLoadedVideoThumbnail(
  video: HTMLVideoElement,
  fileName: string,
  generatedSource: "auto" | "manual",
  duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : VIDEO_SEEK_SECONDS,
  width = video.videoWidth,
  height = video.videoHeight
): Promise<GeneratedThumbnail> {
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
}

async function renderAudioCoverThumbnail(file: File, generatedSource: "auto" | "manual"): Promise<GeneratedThumbnail> {
  const cover = await extractAudioCover(file);

  if (!cover) {
    throw new Error("未找到音频内嵌封面，请手动选择缩略图");
  }

  return renderImageThumbnail(cover, generatedSource, file.name);
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

function waitForVideoReadyState(video: HTMLVideoElement, readyState: number, timeoutMessage: string): Promise<void> {
  if (video.readyState >= readyState) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      if (video.readyState < readyState) {
        return;
      }
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("HLS 视频加载失败"));
    };

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError, { once: true });
  });
}

function waitForHlsFirstFragment(video: HTMLVideoElement, hls: Hls): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("HLS 首个片段缓冲超时"));
    }, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      hls.off(Events.FRAG_BUFFERED, onFragmentBuffered);
      hls.off(Events.ERROR, onHlsError);
      video.removeEventListener("loadeddata", onVideoReady);
      video.removeEventListener("canplay", onVideoReady);
      video.removeEventListener("error", onVideoError);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onVideoReady = () => {
      if (video.readyState >= 2) {
        finish();
      }
    };
    const onFragmentBuffered = () => {
      finish();
    };
    const onHlsError = (_event: Events.ERROR, data: ErrorData) => {
      if (!data.fatal) {
        return;
      }
      cleanup();
      reject(new Error(data.error?.message || "HLS 视频加载失败"));
    };
    const onVideoError = () => {
      cleanup();
      reject(new Error("HLS 视频加载失败"));
    };

    if (video.readyState >= 2) {
      finish();
      return;
    }

    hls.on(Events.FRAG_BUFFERED, onFragmentBuffered);
    hls.on(Events.ERROR, onHlsError);
    video.addEventListener("loadeddata", onVideoReady);
    video.addEventListener("canplay", onVideoReady);
    video.addEventListener("error", onVideoError, { once: true });
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

async function extractAudioCover(file: File): Promise<Blob | undefined> {
  return await extractId3Cover(file) ??
    await extractFlacCover(file) ??
    await extractMp4Cover(file);
}

async function extractId3Cover(file: File): Promise<Blob | undefined> {
  if (file.size < 10) return undefined;

  const header = await readFileBytes(file, 0, 10);
  if (bytesToAscii(header, 0, 3) !== "ID3") {
    return undefined;
  }

  const majorVersion = header[3] ?? 0;
  if (majorVersion < 2 || majorVersion > 4) {
    return undefined;
  }

  const tagSize = synchsafeInteger(header, 6);
  if (tagSize <= 0) return undefined;

  const bytesToRead = Math.min(file.size, 10 + Math.min(tagSize, ID3_MAX_TAG_BYTES));
  const tag = await readFileBytes(file, 0, bytesToRead);
  let body = tag.subarray(10, Math.min(tag.length, 10 + tagSize));
  const flags = header[5] ?? 0;

  if ((flags & 0x80) !== 0) {
    body = removeId3Unsynchronisation(body);
  }

  let offset = 0;
  if ((flags & 0x40) !== 0) {
    if (majorVersion === 3 && body.length >= 4) {
      offset += 4 + uint32(body, 0);
    } else if (majorVersion === 4 && body.length >= 4) {
      offset += synchsafeInteger(body, 0);
    }
  }

  return majorVersion === 2
    ? extractId3v22CoverFrame(body, offset)
    : extractId3v23Or24CoverFrame(body, offset, majorVersion);
}

function extractId3v22CoverFrame(body: Uint8Array, offset: number): Blob | undefined {
  while (offset + 6 <= body.length) {
    const frameId = bytesToAscii(body, offset, 3);
    const frameSize = uint24(body, offset + 3);

    offset += 6;
    if (!frameId.trim() || frameSize <= 0 || offset + frameSize > body.length) {
      break;
    }

    if (frameId === "PIC") {
      const frame = body.subarray(offset, offset + frameSize);
      const cover = parseId3v22PicFrame(frame);
      if (cover) return cover;
    }

    offset += frameSize;
  }

  return undefined;
}

function extractId3v23Or24CoverFrame(body: Uint8Array, offset: number, version: number): Blob | undefined {
  while (offset + 10 <= body.length) {
    const frameId = bytesToAscii(body, offset, 4);
    const frameSize = version === 4 ? synchsafeInteger(body, offset + 4) : uint32(body, offset + 4);

    offset += 10;
    if (!frameId.trim() || frameSize <= 0 || offset + frameSize > body.length) {
      break;
    }

    if (frameId === "APIC") {
      const frame = body.subarray(offset, offset + frameSize);
      const cover = parseId3ApicFrame(frame);
      if (cover) return cover;
    }

    offset += frameSize;
  }

  return undefined;
}

function parseId3ApicFrame(frame: Uint8Array): Blob | undefined {
  if (frame.length < 4) return undefined;

  const encoding = frame[0] ?? 0;
  const mimeEnd = frame.indexOf(0, 1);
  if (mimeEnd < 0 || mimeEnd + 2 >= frame.length) {
    return undefined;
  }

  const rawMime = bytesToLatin1(frame.subarray(1, mimeEnd));
  let offset = mimeEnd + 2;
  const descriptionEnd = findEncodedTextTerminator(frame, offset, encoding);
  offset = Math.min(frame.length, descriptionEnd + textTerminatorLength(encoding));

  return imageBlobFromBytes(frame.subarray(offset), normalizeEmbeddedImageMime(rawMime));
}

function parseId3v22PicFrame(frame: Uint8Array): Blob | undefined {
  if (frame.length < 6) return undefined;

  const encoding = frame[0] ?? 0;
  const imageFormat = bytesToAscii(frame, 1, 3);
  let offset = 5;
  const descriptionEnd = findEncodedTextTerminator(frame, offset, encoding);
  offset = Math.min(frame.length, descriptionEnd + textTerminatorLength(encoding));

  return imageBlobFromBytes(frame.subarray(offset), normalizeEmbeddedImageMime(imageFormat));
}

async function extractFlacCover(file: File): Promise<Blob | undefined> {
  const bytes = await readFileBytes(file, 0, Math.min(file.size, AUDIO_METADATA_SCAN_BYTES));
  if (bytesToAscii(bytes, 0, 4) !== "fLaC") {
    return undefined;
  }

  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const blockHeader = bytes[offset] ?? 0;
    const isLastBlock = (blockHeader & 0x80) !== 0;
    const blockType = blockHeader & 0x7f;
    const blockSize = uint24(bytes, offset + 1);
    const blockStart = offset + 4;
    const blockEnd = blockStart + blockSize;

    if (blockSize <= 0 || blockEnd > bytes.length) {
      break;
    }

    if (blockType === 6) {
      const cover = parseFlacPictureBlock(bytes.subarray(blockStart, blockEnd));
      if (cover) return cover;
    }

    offset = blockEnd;
    if (isLastBlock) break;
  }

  return undefined;
}

function parseFlacPictureBlock(block: Uint8Array): Blob | undefined {
  let offset = 0;
  if (block.length < 32) return undefined;

  offset += 4;
  const mimeLength = uint32(block, offset);
  offset += 4;
  if (mimeLength <= 0 || offset + mimeLength + 24 > block.length) {
    return undefined;
  }

  const mime = bytesToUtf8(block.subarray(offset, offset + mimeLength));
  offset += mimeLength;
  const descriptionLength = uint32(block, offset);
  offset += 4 + descriptionLength;
  if (offset + 20 > block.length) {
    return undefined;
  }

  offset += 16;
  const imageLength = uint32(block, offset);
  offset += 4;
  if (imageLength <= 0 || offset + imageLength > block.length) {
    return undefined;
  }

  return imageBlobFromBytes(block.subarray(offset, offset + imageLength), normalizeEmbeddedImageMime(mime));
}

async function extractMp4Cover(file: File): Promise<Blob | undefined> {
  const ranges: Array<{ start: number; end: number }> = [
    { start: 0, end: Math.min(file.size, AUDIO_METADATA_SCAN_BYTES) }
  ];

  if (file.size > AUDIO_METADATA_SCAN_BYTES) {
    ranges.push({
      start: Math.max(0, file.size - AUDIO_METADATA_SCAN_BYTES),
      end: file.size
    });
  }

  for (const range of ranges) {
    const bytes = await readFileBytes(file, range.start, range.end);
    const cover = extractMp4CoverFromBytes(bytes);
    if (cover) return cover;
  }

  return undefined;
}

function extractMp4CoverFromBytes(bytes: Uint8Array): Blob | undefined {
  for (let typeOffset = 4; typeOffset + 4 <= bytes.length; typeOffset += 1) {
    if (bytesToAscii(bytes, typeOffset, 4) !== "covr") {
      continue;
    }

    const coverBoxStart = typeOffset - 4;
    const coverBoxSize = uint32(bytes, coverBoxStart);
    const coverBoxEnd = coverBoxSize > 8
      ? Math.min(bytes.length, coverBoxStart + coverBoxSize)
      : bytes.length;
    let offset = typeOffset + 4;

    while (offset + 16 <= coverBoxEnd) {
      const atomSize = uint32(bytes, offset);
      const atomType = bytesToAscii(bytes, offset + 4, 4);
      if (atomSize < 16 || offset + atomSize > coverBoxEnd) {
        break;
      }

      if (atomType === "data") {
        const dataType = uint32(bytes, offset + 8) & 0xffffff;
        const explicitMime = mp4CoverMimeType(dataType);
        return imageBlobFromBytes(bytes.subarray(offset + 16, offset + atomSize), explicitMime);
      }

      offset += atomSize;
    }
  }

  return undefined;
}

function imageBlobFromBytes(bytes: Uint8Array, mimeType?: string): Blob | undefined {
  if (bytes.length <= 0) {
    return undefined;
  }

  const detectedMime = imageMimeTypeFromMagic(bytes);
  const type = detectedMime ?? mimeType;
  if (!type?.startsWith("image/")) {
    return undefined;
  }

  return new Blob([arrayBufferFromBytes(bytes)], { type });
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

function readFileBytes(file: File, start: number, end: number): Promise<Uint8Array> {
  return file.slice(start, end).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return value;
}

function bytesToUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return bytesToLatin1(bytes);
  }
}

function uint24(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 16) |
    ((bytes[offset + 1] ?? 0) << 8) |
    (bytes[offset + 2] ?? 0);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) >>> 0) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0);
}

function synchsafeInteger(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 21) |
    ((bytes[offset + 1] ?? 0) << 14) |
    ((bytes[offset + 2] ?? 0) << 7) |
    (bytes[offset + 3] ?? 0);
}

function removeId3Unsynchronisation(bytes: Uint8Array): Uint8Array {
  const output: number[] = [];

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    output.push(byte);
    if (byte === 0xff && bytes[index + 1] === 0x00) {
      index += 1;
    }
  }

  return new Uint8Array(output);
}

function findEncodedTextTerminator(bytes: Uint8Array, offset: number, encoding: number): number {
  if (textTerminatorLength(encoding) === 2) {
    for (let index = offset; index + 1 < bytes.length; index += 1) {
      if (bytes[index] === 0 && bytes[index + 1] === 0) {
        return index;
      }
    }
    return bytes.length;
  }

  const end = bytes.indexOf(0, offset);
  return end < 0 ? bytes.length : end;
}

function textTerminatorLength(encoding: number): 1 | 2 {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

function normalizeEmbeddedImageMime(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();

  if (!normalized || normalized === "-->") return undefined;
  if (normalized === "jpg" || normalized === "jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "png") return "image/png";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  if (normalized.startsWith("image/")) return normalized;

  return undefined;
}

function mp4CoverMimeType(dataType: number): string | undefined {
  if (dataType === 13) return "image/jpeg";
  if (dataType === 14) return "image/png";
  if (dataType === 27) return "image/bmp";
  return undefined;
}

function imageMimeTypeFromMagic(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  if (
    bytesToAscii(bytes, 0, 4) === "RIFF" &&
    bytesToAscii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }

  if (bytesToAscii(bytes, 0, 3) === "GIF") {
    return "image/gif";
  }

  if (bytesToAscii(bytes, 0, 2) === "BM") {
    return "image/bmp";
  }

  return undefined;
}
