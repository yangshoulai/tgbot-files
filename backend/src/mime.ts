const OCTET_STREAM = "application/octet-stream";

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
