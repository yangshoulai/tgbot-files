import { describe, expect, it } from "vitest";
import { detectMimeTypeFromBytes, resolveStoredMimeType } from "../src/mime";

describe("MIME type detection", () => {
  it("detects WebP from RIFF WEBP bytes even when callers send octet-stream", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x02, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50
    ]);

    expect(detectMimeTypeFromBytes(bytes.buffer)).toBe("image/webp");
    expect(resolveStoredMimeType({ bytes: bytes.buffer, fileType: "application/octet-stream" })).toBe("image/webp");
  });

  it("prefers content detection over Telegram and browser fallback values", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);

    expect(resolveStoredMimeType({
      bytes: bytes.buffer,
      fileType: "application/octet-stream",
      telegramMimeType: "application/octet-stream"
    })).toBe("image/jpeg");
  });

  it("detects MP4 and WebM video bytes for browser preview", () => {
    const mp4 = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x02, 0x00,
      0x6d, 0x70, 0x34, 0x32
    ]);
    const webm = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3,
      ...new TextEncoder().encode("webm")
    ]);

    expect(detectMimeTypeFromBytes(mp4.buffer)).toBe("video/mp4");
    expect(detectMimeTypeFromBytes(webm.buffer)).toBe("video/webm");
  });

  it("uses non-octet fallback MIME types when content is unknown", () => {
    const bytes = new TextEncoder().encode("hello");

    expect(resolveStoredMimeType({
      bytes: bytes.buffer,
      fileType: "text/plain",
      telegramMimeType: "application/octet-stream"
    })).toBe("text/plain");
  });
});
