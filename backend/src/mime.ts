const OCTET_STREAM = "application/octet-stream";

const EXTENSION_TO_MIME: Record<string, string> = {
  "7z": "application/x-7z-compressed",
  avif: "image/avif",
  bin: OCTET_STREAM,
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  gz: "application/gzip",
  gzip: "application/gzip",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  log: "text/plain",
  mjs: "text/javascript",
  m4v: "video/mp4",
  markdown: "text/markdown",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  pot: "application/vnd.ms-powerpoint",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  pps: "application/vnd.ms-powerpoint",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rar: "application/x-rar-compressed",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  toml: "application/toml",
  ts: "text/typescript",
  tsx: "text/typescript",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip"
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "application/gzip": "gz",
  "application/json": "json",
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/toml": "toml",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
  "application/x-tar": "tar",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/css": "css",
  "text/csv": "csv",
  "text/html": "html",
  "text/javascript": "js",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/typescript": "ts",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm"
};

interface MimeSource {
  bytes: ArrayBuffer;
  fileType?: string | undefined;
  telegramMimeType?: string | undefined;
}

export function resolveStoredMimeType(source: MimeSource): string {
  const detected = detectMimeTypeFromBytes(source.bytes);
  if (detected) {
    return detected;
  }

  const telegramMimeType = normalizeMimeType(source.telegramMimeType);
  if (telegramMimeType && telegramMimeType !== OCTET_STREAM) {
    return telegramMimeType;
  }

  const fileType = normalizeMimeType(source.fileType);
  if (fileType && fileType !== OCTET_STREAM) {
    return fileType;
  }

  return telegramMimeType || fileType || OCTET_STREAM;
}

export function detectMimeTypeFromBytes(buffer: ArrayBuffer): string | undefined {
  const bytes = new Uint8Array(buffer);

  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (matches(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) {
    return "image/gif";
  }

  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }

  if (asciiAt(bytes, 0, "%PDF-")) {
    return "application/pdf";
  }

  if (
    matches(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    matches(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    matches(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }

  if (matches(bytes, [0x1f, 0x8b, 0x08])) {
    return "application/gzip";
  }

  if (asciiAt(bytes, 0, "Rar!\x1a\x07\x00") || asciiAt(bytes, 0, "Rar!\x1a\x07\x01\x00")) {
    return "application/x-rar-compressed";
  }

  if (matches(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return "application/x-7z-compressed";
  }

  const isoBrand = asciiAt(bytes, 4, "ftyp") ? readAscii(bytes, 8, 16) : "";
  if (isoBrand) {
    if (isoBrand.includes("avif") || isoBrand.includes("avis")) {
      return "image/avif";
    }

    if (/(isom|iso2|mp41|mp42|avc1|m4v|qt  )/i.test(isoBrand)) {
      return isoBrand.toLowerCase().includes("qt  ") ? "video/quicktime" : "video/mp4";
    }
  }

  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && readAscii(bytes, 0, 4096).includes("webm")) {
    return "video/webm";
  }

  return undefined;
}

export function mimeTypeForFileName(fileName: string): string | undefined {
  const extension = fileName.split(".").at(-1)?.trim().toLowerCase();

  if (!extension || extension === fileName.toLowerCase()) {
    return undefined;
  }

  return EXTENSION_TO_MIME[extension];
}

export function extensionForMimeType(mimeType: string | undefined): string | undefined {
  const normalized = normalizeMimeType(mimeType);

  if (!normalized || normalized === OCTET_STREAM) {
    return undefined;
  }

  return MIME_TO_EXTENSION[normalized];
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function matches(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) {
    return false;
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  const end = Math.min(bytes.length, offset + length);
  let value = "";

  for (let index = offset; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }

  return value;
}
