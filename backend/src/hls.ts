import { AppError, sanitizeFileName } from "./http";

export interface HlsVariantPlan {
  id: string;
  uri: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
}

export interface HlsSegmentPlan {
  index: number;
  uri: string;
  rawUri: string;
  duration: number;
  encryption: HlsSegmentEncryption | null;
}

export interface HlsSegmentEncryption {
  method: "AES-128";
  keyUri: string;
  rawKeyUri: string;
  ivHex: string;
}

interface HlsEncryptionState {
  method: "AES-128";
  keyUri: string;
  rawKeyUri: string;
  ivHex?: string;
}

export interface HlsMediaPlan {
  kind: "media";
  playlistUrl: string;
  playlistText: string;
  targetDuration: number;
  duration: number;
  segments: HlsSegmentPlan[];
}

export interface HlsMasterPlan {
  kind: "master";
  playlistUrl: string;
  variants: HlsVariantPlan[];
}

export type HlsPlaylistPlan = HlsMediaPlan | HlsMasterPlan;

export function parseHlsPlaylist(text: string, playlistUrl: URL): HlsPlaylistPlan {
  const normalizedText = text.replace(/^\uFEFF/, "");
  const lines = normalizedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0] !== "#EXTM3U") {
    throw new AppError(400, "InvalidHlsPlaylist", "m3u8 文件必须以 #EXTM3U 开头");
  }

  rejectUnsupportedHlsTags(lines);

  const hasMasterVariant = lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"));
  return hasMasterVariant
    ? parseMasterPlaylist(lines, playlistUrl)
    : parseMediaPlaylist(lines, playlistUrl, normalizedText);
}

export function hlsFileNameFromUrl(url: URL): string {
  const segment = url.pathname.split("/").filter(Boolean).at(-1) || "playlist.m3u8";
  return sanitizeFileName(segment.toLowerCase().endsWith(".m3u8") ? segment : `${segment}.m3u8`);
}

export function hlsSegmentFileName(url: URL, index: number): string {
  const segment = url.pathname.split("/").filter(Boolean).at(-1);
  if (segment) {
    return sanitizeFileName(segment);
  }

  return `segment-${String(index).padStart(5, "0")}.ts`;
}

export function hlsMimeTypeForSegment(url: URL, contentType?: string | null): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") {
    return normalized;
  }

  const path = url.pathname.toLowerCase();
  if (path.endsWith(".m4s") || path.endsWith(".mp4") || path.endsWith(".cmfv")) {
    return "video/mp4";
  }
  if (path.endsWith(".aac")) {
    return "audio/aac";
  }
  if (path.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  return "video/mp2t";
}

export function buildRewrittenMediaPlaylist(params: {
  playlistText?: string | null;
  targetDuration: number;
  segments: Array<{ index: number; duration: number; path: string }>;
}): string {
  if (params.playlistText) {
    return rewriteMediaPlaylistUris(params.playlistText, params.segments);
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(params.targetDuration))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD"
  ];

  for (const segment of params.segments) {
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
    lines.push(segment.path);
  }

  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

function rejectUnsupportedHlsTags(lines: string[]): void {
  if (lines.some((line) => line.startsWith("#EXT-X-BYTERANGE"))) {
    throw new AppError(400, "UnsupportedHlsByteRange", "暂不支持 byte-range HLS");
  }

  if (lines.some((line) => line.startsWith("#EXT-X-MAP"))) {
    throw new AppError(400, "UnsupportedHlsInitSegment", "暂不支持 fMP4/init segment HLS");
  }
}

function parseMasterPlaylist(lines: string[], playlistUrl: URL): HlsMasterPlan {
  const variants: HlsVariantPlan[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const uri = nextUriLine(lines, index + 1);
    if (!uri) {
      throw new AppError(400, "InvalidHlsPlaylist", "master playlist 缺少 variant URI");
    }

    const attrs = parseHlsAttributes(line.slice(line.indexOf(":") + 1));
    const absoluteUri = new URL(uri, playlistUrl).toString();
    const bandwidth = numberAttr(attrs.BANDWIDTH);
    variants.push({
      id: `v${variants.length}`,
      uri: absoluteUri,
      ...(bandwidth !== undefined ? { bandwidth } : {}),
      ...(attrs.RESOLUTION ? { resolution: attrs.RESOLUTION } : {}),
      ...(attrs.CODECS ? { codecs: attrs.CODECS } : {})
    });
  }

  if (variants.length === 0) {
    throw new AppError(400, "InvalidHlsPlaylist", "master playlist 没有可导入的 variant");
  }

  return {
    kind: "master",
    playlistUrl: playlistUrl.toString(),
    variants
  };
}

function parseMediaPlaylist(lines: string[], playlistUrl: URL, playlistText: string): HlsMediaPlan {
  if (!lines.includes("#EXT-X-ENDLIST")) {
    throw new AppError(400, "UnsupportedHlsLive", "暂不支持直播 HLS，只支持包含 #EXT-X-ENDLIST 的点播 playlist");
  }

  const segments: HlsSegmentPlan[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let currentEncryption: HlsEncryptionState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const parsed = Number(line.slice("#EXT-X-TARGETDURATION:".length));
      targetDuration = Number.isFinite(parsed) && parsed > 0 ? parsed : targetDuration;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const parsed = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      mediaSequence = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : mediaSequence;
      continue;
    }

    if (line.startsWith("#EXT-X-KEY")) {
      currentEncryption = parseHlsKey(line, playlistUrl);
      continue;
    }

    if (!line.startsWith("#EXTINF:")) {
      continue;
    }

    const duration = parseExtinfDuration(line);
    const uri = nextUriLine(lines, index + 1);
    if (!uri) {
      throw new AppError(400, "InvalidHlsPlaylist", "#EXTINF 后缺少 segment URI");
    }
    const segmentSequence = mediaSequence + segments.length;

    segments.push({
      index: segments.length,
      uri: new URL(uri, playlistUrl).toString(),
      rawUri: uri,
      duration,
      encryption: currentEncryption
        ? {
            ...currentEncryption,
            ivHex: currentEncryption.ivHex ?? mediaSequenceToIvHex(segmentSequence)
          }
        : null
    });
  }

  if (segments.length === 0) {
    throw new AppError(400, "InvalidHlsPlaylist", "media playlist 没有可导入的 segment");
  }

  return {
    kind: "media",
    playlistUrl: playlistUrl.toString(),
    playlistText,
    targetDuration: targetDuration || Math.max(...segments.map((segment) => segment.duration)),
    duration: segments.reduce((total, segment) => total + segment.duration, 0),
    segments
  };
}

function rewriteMediaPlaylistUris(
  playlistText: string,
  segments: Array<{ index: number; duration: number; path: string }>
): string {
  const replacements = new Map(segments.map((segment) => [segment.index, segment.path]));
  const output: string[] = [];
  let pendingSegmentIndex: number | null = null;
  let nextSegmentIndex = 0;

  for (const rawLine of playlistText.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("#EXTINF:")) {
      pendingSegmentIndex = nextSegmentIndex;
      nextSegmentIndex += 1;
      output.push(rawLine);
      continue;
    }

    if (line.startsWith("#EXT-X-KEY")) {
      continue;
    }

    if (pendingSegmentIndex !== null && line && !line.startsWith("#")) {
      output.push(replacements.get(pendingSegmentIndex) ?? rawLine);
      pendingSegmentIndex = null;
      continue;
    }

    output.push(rawLine);
  }

  const text = output.join("\n").replace(/\n*$/g, "");
  return `${text}\n`;
}

function nextUriLine(lines: string[], startIndex: number): string | undefined {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.startsWith("#")) {
      continue;
    }
    return line;
  }

  return undefined;
}

function parseExtinfDuration(line: string): number {
  const value = line.slice("#EXTINF:".length).split(",")[0]?.trim();
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError(400, "InvalidHlsPlaylist", "segment duration 无效");
  }
  return duration;
}

function parseHlsAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let cursor = 0;

  while (cursor < value.length) {
    const equals = value.indexOf("=", cursor);
    if (equals === -1) break;

    const key = value.slice(cursor, equals).replace(/^,/, "").trim();
    cursor = equals + 1;

    let attrValue = "";
    if (value[cursor] === "\"") {
      cursor += 1;
      const end = value.indexOf("\"", cursor);
      attrValue = end === -1 ? value.slice(cursor) : value.slice(cursor, end);
      cursor = end === -1 ? value.length : end + 1;
    } else {
      const comma = value.indexOf(",", cursor);
      attrValue = comma === -1 ? value.slice(cursor) : value.slice(cursor, comma);
      cursor = comma === -1 ? value.length : comma + 1;
    }

    if (key) {
      attrs[key.toUpperCase()] = attrValue.trim();
    }

    while (value[cursor] === ",") cursor += 1;
  }

  return attrs;
}

function parseHlsKey(line: string, playlistUrl: URL): HlsEncryptionState | null {
  const attrs = parseHlsAttributes(line.slice(line.indexOf(":") + 1));
  const method = attrs.METHOD?.toUpperCase();

  if (!method || method === "NONE") {
    return null;
  }

  if (method !== "AES-128") {
    throw new AppError(400, "UnsupportedHlsEncryption", "暂只支持 AES-128 加密 HLS");
  }

  if (!attrs.URI) {
    throw new AppError(400, "InvalidHlsPlaylist", "AES-128 HLS 缺少 key URI");
  }

  if (attrs.KEYFORMAT && attrs.KEYFORMAT.toLowerCase() !== "identity") {
    throw new AppError(400, "UnsupportedHlsEncryption", "暂只支持 identity KEYFORMAT 的 AES-128 HLS");
  }

  return {
    method: "AES-128",
    keyUri: new URL(attrs.URI, playlistUrl).toString(),
    rawKeyUri: attrs.URI,
    ...(attrs.IV ? { ivHex: normalizeHlsIv(attrs.IV) } : {})
  };
}

function normalizeHlsIv(value: string): string {
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{1,32}$/.test(normalized)) {
    throw new AppError(400, "InvalidHlsPlaylist", "AES-128 HLS IV 必须是不超过 16 字节的十六进制值");
  }

  return normalized.padStart(32, "0");
}

function mediaSequenceToIvHex(segmentSequence: number): string {
  let value = BigInt(segmentSequence);
  const bytes = new Uint8Array(16);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function numberAttr(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
