import type { ThumbnailUploadPayload } from "../api";
import Hls, { Events, type ErrorData } from "hls.js";

export type ThumbnailKind = "image" | "video" | "audio";

export interface GeneratedThumbnail extends ThumbnailUploadPayload {
  blob: Blob;
  fileName: string;
  objectUrl: string;
  source: "auto" | "manual";
  captureTimeSeconds?: number | null;
}

export interface RemoteThumbnailSource {
  kind: "image" | "video";
  url: string;
  mime_type?: string;
}

const IMAGE_THUMBNAIL_MAX_SIDE = 320;
const MAX_STORED_THUMBNAIL_SIDE = 8192;
const MAX_GENERATED_THUMBNAIL_BYTES = 512 * 1024;
const JPEG_QUALITY = 0.82;
const VIDEO_JPEG_QUALITY = 0.95;
const VIDEO_SEEK_SECONDS = 0.75;
const VIDEO_THUMBNAIL_CANDIDATE_LIMIT = 6;
const THUMBNAIL_CANDIDATE_RATIOS = [0.06, 0.16, 0.3, 0.45, 0.62, 0.8, 0.9];
const VIDEO_FRAME_WAIT_TIMEOUT_MS = 800;
const VIDEO_FORCED_FRAME_WAIT_TIMEOUT_MS = 2500;
const HLS_THUMBNAIL_BUFFER_TIMEOUT_MS = 18000;
const HLS_PLAYER_THUMBNAIL_TIMEOUT_MS = 10000;
const HLS_PLAYER_CANDIDATE_TIMEOUT_MS = 28000;
const VIDEO_SEEK_TIMEOUT_MS = 6000;
const VIDEO_READY_TIMEOUT_MS = 6000;
const VIDEO_BLANK_VARIANCE_THRESHOLD = 12;
const VIDEO_BLANK_WHITE_LUMA = 246;
const VIDEO_BLANK_BLACK_LUMA = 22;
const AUDIO_METADATA_SCAN_BYTES = 16 * 1024 * 1024;
const ID3_MAX_TAG_BYTES = 32 * 1024 * 1024;

interface HlsThumbnailSegmentSource {
  initUrl?: string;
  segmentUrl: string;
  startTime: number;
  duration: number;
  targetTime: number;
  segmentTime: number;
}

interface VideoThumbnailRenderOptions {
  forceFrameDecode?: boolean;
  captureCurrentFrameFirst?: boolean;
  acceptBlankFrame?: boolean;
  seekTimeoutMs?: number;
  readyTimeoutMs?: number;
  candidateLimit?: number;
  targetTimes?: Array<number | null>;
  captureTimeBaseSeconds?: number;
}

interface DrawCanvasOptions {
  fillBackground?: boolean;
  maxSide?: number;
}

interface ThumbnailEncodeOptions {
  quality?: number;
  maxBytes?: number;
}

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

export async function generateThumbnailCandidatesFromRemoteSource(
  source: RemoteThumbnailSource,
  fileName = "remote-file"
): Promise<GeneratedThumbnail[]> {
  if (source.kind === "image") {
    return [await renderImageThumbnail(source.url, "auto", fileName)];
  }

  return renderVideoThumbnailCandidates(source.url, fileName, "auto", false);
}

export async function generateThumbnailFromHlsPlaylist(playlistUrl: string, fileName = "hls-video.m3u8"): Promise<GeneratedThumbnail> {
  try {
    return await generateThumbnailFromHlsFirstSegment(playlistUrl, fileName);
  } catch {
    // Fall back to the browser/Hls.js player path for non-TS or unusual playlists.
  }

  return withTimeout(
    generateThumbnailFromHlsPlayer(playlistUrl, fileName),
    HLS_PLAYER_THUMBNAIL_TIMEOUT_MS,
    "HLS 缩略图生成超时"
  );
}

export async function generateThumbnailCandidatesFromHlsPlaylist(
  playlistUrl: string,
  fileName = "hls-video.m3u8"
): Promise<GeneratedThumbnail[]> {
  const playlist = await fetchTextWithTimeout(playlistUrl, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
  try {
    const candidates = await generateThumbnailCandidatesFromHlsSegments(playlist, playlistUrl, fileName);
    if (candidates.length >= VIDEO_THUMBNAIL_CANDIDATE_LIMIT) {
      return candidates;
    }
  } catch {
    // Fall back to player-based seeking below.
  }

  try {
    const duration = hlsPlaylistDuration(playlist, playlistUrl);
    return await withTimeout(
      generateThumbnailCandidatesFromHlsPlayer(playlistUrl, fileName, duration),
      HLS_PLAYER_CANDIDATE_TIMEOUT_MS,
      "HLS 候选缩略图生成超时"
    );
  } catch {
    // Fall back to first-segment candidates when playlist-wide capture is unavailable.
  }

  return generateThumbnailCandidatesFromHlsFirstSegment(playlistUrl, fileName);
}

async function generateThumbnailFromHlsPlayer(playlistUrl: string, fileName: string): Promise<GeneratedThumbnail> {
  const candidates = await generateThumbnailCandidatesFromHlsPlayer(playlistUrl, fileName);
  const first = candidates[0];
  if (!first) {
    throw new Error("视频截帧为空白，请手动选择缩略图");
  }
  return first;
}

async function generateThumbnailCandidatesFromHlsPlayer(
  playlistUrl: string,
  fileName: string,
  durationOverride?: number
): Promise<GeneratedThumbnail[]> {
  const video = document.createElement("video");
  let hls: Hls | null = null;
  const detachVideo = attachHiddenCaptureVideo(video);

  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    const metadataReady = waitForVideoMetadata(video);
    let bufferReady: Promise<void>;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playlistUrl;
      video.load();
      bufferReady = waitForVideoReadyState(video, 2, "HLS 首帧加载超时", { startMutedPlayback: true });
    } else if (Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 8,
        maxMaxBufferLength: 8,
        xhrSetup(xhr) {
          xhr.withCredentials = true;
        }
      });
      bufferReady = waitForHlsFirstFrame(video, hls);
      hls.attachMedia(video);
      hls.loadSource(playlistUrl);
    } else {
      throw new Error("当前浏览器不支持 HLS 预览");
    }

    await metadataReady;
    await bufferReady;
    await waitForVideoDimensions(video);
    return renderLoadedVideoThumbnailCandidates(video, fileName, "auto", durationOverride, undefined, undefined, {
      forceFrameDecode: true,
      captureCurrentFrameFirst: false,
      seekTimeoutMs: VIDEO_SEEK_TIMEOUT_MS,
      readyTimeoutMs: VIDEO_READY_TIMEOUT_MS
    });
  } finally {
    hls?.destroy();
    detachVideo();
    video.removeAttribute("src");
    video.load();
  }
}

async function generateThumbnailFromHlsFirstSegment(playlistUrl: string, fileName: string): Promise<GeneratedThumbnail> {
  const candidates = await generateThumbnailCandidatesFromHlsFirstSegment(playlistUrl, fileName);
  const first = candidates[0];
  if (!first) {
    throw new Error("视频截帧为空白，请手动选择缩略图");
  }
  return first;
}

async function generateThumbnailCandidatesFromHlsFirstSegment(playlistUrl: string, fileName: string): Promise<GeneratedThumbnail[]> {
  const playlist = await fetchTextWithTimeout(playlistUrl, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
  const source = firstHlsMediaSource(playlist, playlistUrl);
  const [segment, initSegment] = await Promise.all([
    fetchBytesWithTimeout(source.segmentUrl, "HLS 片段读取失败"),
    source.initUrl ? fetchBytesWithTimeout(source.initUrl, "HLS init segment 读取失败") : Promise.resolve(undefined)
  ]);

  const segmentBlob = initSegment
    ? new Blob([arrayBufferFromBytes(initSegment.bytes), arrayBufferFromBytes(segment.bytes)], { type: "video/mp4" })
    : isMp4Bytes(segment.bytes, segment.contentType)
      ? new Blob([arrayBufferFromBytes(segment.bytes)], { type: segment.contentType || "video/mp4" })
      : await transmuxTsSegmentToMp4(segment.bytes);
  const objectUrl = URL.createObjectURL(segmentBlob);

  return renderVideoThumbnailCandidates(objectUrl, fileName, "auto", true, {
    forceFrameDecode: true,
    captureCurrentFrameFirst: true,
    acceptBlankFrame: true
  });
}

async function generateThumbnailCandidatesFromHlsSegments(
  playlistText: string,
  playlistUrl: string,
  fileName: string
): Promise<GeneratedThumbnail[]> {
  const sources = hlsThumbnailSegmentSources(playlistText, playlistUrl, VIDEO_THUMBNAIL_CANDIDATE_LIMIT);
  const thumbnails: GeneratedThumbnail[] = [];

  try {
    for (const source of sources) {
      const thumbnail = await generateThumbnailFromHlsSegmentSource(source, fileName);
      thumbnails.push(thumbnail);
    }
  } catch (error) {
    for (const thumbnail of thumbnails) {
      revokeThumbnail(thumbnail);
    }
    throw error;
  }

  return thumbnails;
}

async function generateThumbnailFromHlsSegmentSource(
  source: HlsThumbnailSegmentSource,
  fileName: string
): Promise<GeneratedThumbnail> {
  const [segment, initSegment] = await Promise.all([
    fetchBytesWithTimeout(source.segmentUrl, "HLS 片段读取失败"),
    source.initUrl ? fetchBytesWithTimeout(source.initUrl, "HLS init segment 读取失败") : Promise.resolve(undefined)
  ]);

  const segmentBlob = initSegment
    ? new Blob([arrayBufferFromBytes(initSegment.bytes), arrayBufferFromBytes(segment.bytes)], { type: "video/mp4" })
    : isMp4Bytes(segment.bytes, segment.contentType)
      ? new Blob([arrayBufferFromBytes(segment.bytes)], { type: segment.contentType || "video/mp4" })
      : await transmuxTsSegmentToMp4(segment.bytes);
  const objectUrl = URL.createObjectURL(segmentBlob);
  const candidate = await renderVideoThumbnail(objectUrl, fileName, "auto", true, {
    forceFrameDecode: true,
    targetTimes: [source.segmentTime],
    acceptBlankFrame: true,
    seekTimeoutMs: VIDEO_SEEK_TIMEOUT_MS,
    readyTimeoutMs: VIDEO_READY_TIMEOUT_MS,
    captureTimeBaseSeconds: source.startTime
  });

  return {
    ...candidate,
    captureTimeSeconds: source.targetTime
  };
}

async function fetchBytesWithTimeout(url: string, label: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetchWithTimeout(url, { credentials: "include" }, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`${label}（HTTP ${response.status}）`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("Content-Type") || ""
  };
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
  revokeSourceUrl: boolean,
  options: VideoThumbnailRenderOptions = {}
): Promise<GeneratedThumbnail> {
  const candidates = await renderVideoThumbnailCandidates(sourceUrl, fileName, generatedSource, revokeSourceUrl, {
    ...options,
    candidateLimit: 1
  });
  const first = candidates[0];
  if (!first) {
    throw new Error("视频截帧为空白，请手动选择缩略图");
  }
  return first;
}

async function renderVideoThumbnailCandidates(
  sourceUrl: string,
  fileName: string,
  generatedSource: "auto" | "manual",
  revokeSourceUrl: boolean,
  options: VideoThumbnailRenderOptions = {}
): Promise<GeneratedThumbnail[]> {
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

    return await renderLoadedVideoThumbnailCandidates(video, fileName, generatedSource, duration, width, height, options);
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
  height = video.videoHeight,
  options: VideoThumbnailRenderOptions = {}
): Promise<GeneratedThumbnail> {
  const candidates = await renderLoadedVideoThumbnailCandidates(video, fileName, generatedSource, duration, width, height, {
    ...options,
    candidateLimit: 1
  });
  const first = candidates[0];
  if (!first) {
    throw new Error("视频截帧为空白，请手动选择缩略图");
  }
  return first;
}

async function renderLoadedVideoThumbnailCandidates(
  video: HTMLVideoElement,
  fileName: string,
  generatedSource: "auto" | "manual",
  duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : VIDEO_SEEK_SECONDS,
  width = video.videoWidth,
  height = video.videoHeight,
  options: VideoThumbnailRenderOptions = {}
): Promise<GeneratedThumbnail[]> {
  if (!width || !height) {
    const dimensions = await waitForVideoDimensions(video);
    width = dimensions.width;
    height = dimensions.height;
  }

  let lastError: Error | undefined;
  let sawBlankFrame = false;
  const thumbnails: GeneratedThumbnail[] = [];
  const blankThumbnails: GeneratedThumbnail[] = [];
  const candidateLimit = options.candidateLimit ?? VIDEO_THUMBNAIL_CANDIDATE_LIMIT;
  const targetTimes: Array<number | null> = options.targetTimes ?? (options.captureCurrentFrameFirst
    ? [null, ...videoCaptureTimes(duration)]
    : videoCaptureTimes(duration));

  for (const targetTime of targetTimes) {
    try {
      if (targetTime !== null) {
        await seekVideo(video, targetTime, options.seekTimeoutMs);
      }
      await waitForVideoReadyState(video, 2, "视频帧读取超时", { timeoutMs: options.readyTimeoutMs });
      const dimensions = await waitForVideoDimensions(video);
      await waitForVideoPaint(video, options);

      const canvas = drawToCanvas(
        dimensions.width,
        dimensions.height,
        (context, targetWidth, targetHeight) => {
          context.drawImage(video, 0, 0, targetWidth, targetHeight);
        },
        {
          fillBackground: false,
          maxSide: MAX_STORED_THUMBNAIL_SIDE
        }
      );

      const thumbnail = await canvasToGeneratedThumbnail(canvas, fileName, generatedSource, {
        quality: VIDEO_JPEG_QUALITY,
        maxBytes: MAX_GENERATED_THUMBNAIL_BYTES,
        captureTimeSeconds: targetTime === null
          ? (options.captureTimeBaseSeconds ?? null)
          : (options.captureTimeBaseSeconds ?? 0) + targetTime
      });
      if (options.acceptBlankFrame || !isProbablyBlankVideoFrame(canvas)) {
        thumbnails.push(thumbnail);
        if (thumbnails.length >= candidateLimit) {
          break;
        }
        continue;
      }

      blankThumbnails.push(thumbnail);
      sawBlankFrame = true;
      if (thumbnails.length + blankThumbnails.length >= candidateLimit) {
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("视频帧读取失败");
    }
  }

  while (thumbnails.length < candidateLimit && blankThumbnails.length > 0) {
    thumbnails.push(blankThumbnails.shift()!);
  }
  for (const unused of blankThumbnails) {
    revokeThumbnail(unused);
  }

  if (thumbnails.length > 0) {
    return await fillThumbnailCandidates(thumbnails, candidateLimit);
  }

  if (sawBlankFrame) {
    throw new Error("视频截帧为空白，请手动选择缩略图");
  }

  throw lastError ?? new Error("视频截帧为空白，请手动选择缩略图");
}

async function fillThumbnailCandidates(
  thumbnails: GeneratedThumbnail[],
  candidateLimit: number
): Promise<GeneratedThumbnail[]> {
  if (thumbnails.length === 0 || thumbnails.length >= candidateLimit) {
    return thumbnails.slice(0, candidateLimit);
  }

  const filled = [...thumbnails];
  for (let index = 0; filled.length < candidateLimit; index += 1) {
    const source = thumbnails[index % thumbnails.length]!;
    filled.push({
      ...source,
      objectUrl: URL.createObjectURL(source.blob)
    });
  }

  return filled;
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

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const response = await fetchWithTimeout(url, { credentials: "include" }, timeoutMs);

  if (!response.ok) {
    throw new Error(`HLS playlist 读取失败（HTTP ${response.status}）`);
  }

  return response.text();
}

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  return fetch(input, {
    ...init,
    signal: controller.signal
  }).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function firstHlsMediaSource(playlistText: string, playlistUrl: string): { initUrl?: string; segmentUrl: string } {
  const baseUrl = absoluteUrl(playlistUrl);
  let pendingSegment = false;
  let initUrl: string | undefined;

  for (const rawLine of playlistText.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const uri = hlsAttributeValue(line, "URI");
      if (uri) {
        initUrl = new URL(uri, baseUrl).toString();
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      pendingSegment = true;
      continue;
    }

    if (pendingSegment && !line.startsWith("#")) {
      return {
        ...(initUrl ? { initUrl } : {}),
        segmentUrl: new URL(line, baseUrl).toString()
      };
    }
  }

  throw new Error("HLS playlist 缺少可截帧片段");
}

function hlsThumbnailSegmentSources(
  playlistText: string,
  playlistUrl: string,
  count: number
): HlsThumbnailSegmentSource[] {
  const segments = hlsMediaSegments(playlistText, playlistUrl);
  if (segments.length === 0) {
    throw new Error("HLS playlist 缺少可截帧片段");
  }

  const totalDuration = segments.reduce((total, segment) => total + Math.max(0, segment.duration), 0);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error("HLS playlist 缺少有效时长");
  }

  const selected: HlsThumbnailSegmentSource[] = [];
  for (const ratio of THUMBNAIL_CANDIDATE_RATIOS) {
    const targetTime = Math.max(0, Math.min(totalDuration - 0.001, totalDuration * ratio));
    const index = hlsSegmentIndexAtTime(segments, targetTime);
    const segment = segments[index]!;
    selected.push({
      ...segment,
      targetTime,
      segmentTime: Math.max(0, Math.min(segment.duration * 0.8, targetTime - segment.startTime))
    });
    if (selected.length >= count) {
      break;
    }
  }

  for (let index = 0; selected.length < count; index += 1) {
    const segment = segments[index % segments.length]!;
    const ratio = (selected.length + 1) / (count + 1);
    const segmentTime = Math.max(0, Math.min(segment.duration * 0.8, segment.duration * ratio));
    selected.push({
      ...segment,
      targetTime: segment.startTime + segmentTime,
      segmentTime
    });
  }

  return selected.slice(0, count);
}

function hlsPlaylistDuration(playlistText: string, playlistUrl: string): number | undefined {
  const duration = hlsMediaSegments(playlistText, playlistUrl)
    .reduce((total, segment) => total + Math.max(0, segment.duration), 0);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function hlsMediaSegments(playlistText: string, playlistUrl: string): HlsThumbnailSegmentSource[] {
  const baseUrl = absoluteUrl(playlistUrl);
  const segments: HlsThumbnailSegmentSource[] = [];
  let pendingDuration: number | undefined;
  let initUrl: string | undefined;
  let currentTime = 0;

  for (const rawLine of playlistText.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const uri = hlsAttributeValue(line, "URI");
      initUrl = uri ? new URL(uri, baseUrl).toString() : undefined;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const value = Number(line.slice("#EXTINF:".length).split(",")[0]);
      pendingDuration = Number.isFinite(value) && value > 0 ? value : undefined;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (pendingDuration !== undefined) {
      segments.push({
        ...(initUrl ? { initUrl } : {}),
        segmentUrl: new URL(line, baseUrl).toString(),
        startTime: currentTime,
        duration: pendingDuration,
        targetTime: currentTime,
        segmentTime: 0
      });
      currentTime += pendingDuration;
      pendingDuration = undefined;
    }
  }

  return segments;
}

function hlsSegmentIndexAtTime(segments: HlsThumbnailSegmentSource[], targetTime: number): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (targetTime < segment.startTime + segment.duration) {
      return index;
    }
  }

  return Math.max(0, segments.length - 1);
}

function hlsAttributeValue(line: string, key: string): string | undefined {
  const body = line.slice(line.indexOf(":") + 1);
  const pattern = new RegExp(`(?:^|,)${key}=((?:"[^"]*")|[^,]*)`, "i");
  const match = pattern.exec(body);
  const value = match?.[1]?.trim();

  if (!value) {
    return undefined;
  }

  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function absoluteUrl(value: string): string {
  if (typeof window === "undefined") {
    return value;
  }

  return new URL(value, window.location.origin).toString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  });
}

function isMp4Bytes(bytes: Uint8Array, contentType: string): boolean {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "video/mp4" || normalized === "audio/mp4") {
    return true;
  }

  return bytesToAscii(bytes, 4, 4) === "ftyp";
}

async function transmuxTsSegmentToMp4(bytes: Uint8Array): Promise<Blob> {
  if (bytes[0] !== 0x47) {
    throw new Error("HLS segment 不是可转封装的 TS 数据");
  }

  const mp4 = await import("mux.js/lib/mp4");
  const transmuxer = new mp4.Transmuxer();
  const chunks: Uint8Array[] = [];

  transmuxer.setBaseMediaDecodeTime(0);
  transmuxer.on("data", (data) => {
    if (data.initSegment) {
      chunks.push(data.initSegment);
    }
    chunks.push(data.data);
  });
  transmuxer.push(bytes);
  transmuxer.flush();

  if (chunks.length === 0) {
    throw new Error("HLS segment 转封装失败");
  }

  return new Blob(chunks.map(arrayBufferFromBytes), { type: "video/mp4" });
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

function waitForVideoDimensions(video: HTMLVideoElement): Promise<{ width: number; height: number }> {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve({ width: video.videoWidth, height: video.videoHeight });
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("无法读取视频画面尺寸"));
    }, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("resize", onReady);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        return;
      }
      cleanup();
      resolve({ width: video.videoWidth, height: video.videoHeight });
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频缩略图生成失败"));
    };

    video.addEventListener("resize", onReady);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError, { once: true });
    onReady();
  });
}

function waitForVideoReadyState(
  video: HTMLVideoElement,
  readyState: number,
  timeoutMessage: string,
  options: { startMutedPlayback?: boolean; timeoutMs?: number } = {}
): Promise<void> {
  if (video.readyState >= readyState) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let playbackStarted = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, options.timeoutMs ?? HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      if (playbackStarted) {
        video.pause();
      }
    };
    const startPlayback = () => {
      if (!options.startMutedPlayback || playbackStarted || !video.paused) {
        return;
      }
      playbackStarted = true;
      void video.play().catch(() => undefined);
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
    startPlayback();
  });
}

function waitForHlsFirstFrame(video: HTMLVideoElement, hls: Hls): Promise<void> {
  return new Promise((resolve, reject) => {
    let playbackStarted = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("HLS 首帧加载超时"));
    }, HLS_THUMBNAIL_BUFFER_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      hls.off(Events.FRAG_BUFFERED, onFragmentBuffered);
      hls.off(Events.ERROR, onHlsError);
      video.removeEventListener("loadeddata", onVideoReady);
      video.removeEventListener("canplay", onVideoReady);
      video.removeEventListener("error", onVideoError);
      if (playbackStarted) {
        video.pause();
      }
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
      startPlayback();
      onVideoReady();
    };
    const startPlayback = () => {
      if (playbackStarted || !video.paused) {
        return;
      }
      playbackStarted = true;
      void video.play().catch(() => undefined);
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

function seekVideo(video: HTMLVideoElement, time: number, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const targetTime = Math.max(0, time);

    if (video.readyState >= 2 && Math.abs(video.currentTime - targetTime) < 0.03) {
      resolve();
      return;
    }

    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频定位超时"));
    }, timeoutMs);
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
  options: DrawCanvasOptions = { fillBackground: true }
): HTMLCanvasElement {
  const maxSide = options.maxSide ?? IMAGE_THUMBNAIL_MAX_SIDE;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
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
  const maxTime = Number.isFinite(duration) && duration > 0.1 ? duration - 0.05 : VIDEO_SEEK_SECONDS;
  const rawCandidates = [
    ...THUMBNAIL_CANDIDATE_RATIOS.slice(0, VIDEO_THUMBNAIL_CANDIDATE_LIMIT).map((ratio) => duration * ratio),
    VIDEO_SEEK_SECONDS,
    1.5,
    3
  ];
  const times: number[] = [];

  for (const candidate of rawCandidates) {
    if (!Number.isFinite(candidate)) continue;
    const clamped = Math.max(0, Math.min(candidate, maxTime));
    const rounded = Number(clamped.toFixed(2));
    if (!times.includes(rounded)) {
      times.push(rounded);
    }
  }

  for (let index = 0; times.length < VIDEO_THUMBNAIL_CANDIDATE_LIMIT; index += 1) {
    const ratio = (index + 1) / (VIDEO_THUMBNAIL_CANDIDATE_LIMIT + 1);
    times.push(Number(Math.max(0, Math.min(maxTime, maxTime * ratio)).toFixed(2)));
  }

  return times
    .sort((left, right) => left - right)
    .slice(0, VIDEO_THUMBNAIL_CANDIDATE_LIMIT);
}

async function waitForVideoPaint(
  video: HTMLVideoElement,
  options: VideoThumbnailRenderOptions = {}
): Promise<void> {
  const frameVideo = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  let playbackStarted = false;

  const startPlayback = () => {
    if (!options.forceFrameDecode || playbackStarted || !video.paused) {
      return;
    }
    playbackStarted = true;
    void video.play().catch(() => undefined);
  };

  try {
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

      window.setTimeout(finish, options.forceFrameDecode ? VIDEO_FORCED_FRAME_WAIT_TIMEOUT_MS : VIDEO_FRAME_WAIT_TIMEOUT_MS);
      startPlayback();
    });
  } finally {
    if (playbackStarted) {
      video.pause();
    }
  }

  await nextAnimationFrame();
  await nextAnimationFrame();
}

function attachHiddenCaptureVideo(video: HTMLVideoElement): () => void {
  if (!document.body) {
    return () => undefined;
  }

  video.setAttribute("aria-hidden", "true");
  video.tabIndex = -1;
  video.autoplay = true;
  Object.assign(video.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "320px",
    height: "180px",
    opacity: "0.01",
    pointerEvents: "none",
    zIndex: "-1"
  });
  document.body.append(video);

  return () => {
    video.remove();
  };
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
  generatedSource: "auto" | "manual",
  options: ThumbnailEncodeOptions & { captureTimeSeconds?: number | null } = {}
): Promise<GeneratedThumbnail> {
  const output = await canvasToThumbnailBlob(canvas, options);
  const blob = output.blob;
  const objectUrl = URL.createObjectURL(blob);

  return {
    blob,
    fileName: thumbnailFileName(sourceFileName),
    width: output.width,
    height: output.height,
    objectUrl,
    source: generatedSource,
    ...(options.captureTimeSeconds !== undefined ? { captureTimeSeconds: options.captureTimeSeconds } : {})
  };
}

async function canvasToThumbnailBlob(
  canvas: HTMLCanvasElement,
  options: ThumbnailEncodeOptions
): Promise<{ blob: Blob; width: number; height: number }> {
  const initialQuality = options.quality ?? JPEG_QUALITY;
  const maxBytes = options.maxBytes;
  let outputCanvas = canvas;
  let quality = initialQuality;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const blob = await canvasToBlob(outputCanvas, quality);

    if (!maxBytes || blob.size <= maxBytes) {
      return {
        blob,
        width: outputCanvas.width,
        height: outputCanvas.height
      };
    }

    if (quality > 0.62) {
      quality = Math.max(0.62, quality - 0.11);
      continue;
    }

    const scale = Math.max(0.5, Math.sqrt(maxBytes / blob.size) * 0.92);
    const nextWidth = Math.max(1, Math.round(outputCanvas.width * scale));
    const nextHeight = Math.max(1, Math.round(outputCanvas.height * scale));

    if (nextWidth === outputCanvas.width && nextHeight === outputCanvas.height) {
      break;
    }

    outputCanvas = resizeCanvas(outputCanvas, nextWidth, nextHeight);
    quality = initialQuality;
  }

  const blob = await canvasToBlob(outputCanvas, 0.62);
  if (maxBytes && blob.size > maxBytes) {
    throw new Error("缩略图编码后仍超过上传限制");
  }

  return {
    blob,
    width: outputCanvas.width,
    height: outputCanvas.height
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
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
      quality
    );
  });
}

function resizeCanvas(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("当前浏览器不支持 Canvas");
  }

  canvas.width = width;
  canvas.height = height;
  context.drawImage(source, 0, 0, width, height);

  return canvas;
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
