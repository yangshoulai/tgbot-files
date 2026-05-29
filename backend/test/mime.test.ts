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

  it("uses non-octet fallback MIME types when content is unknown", () => {
    const bytes = new TextEncoder().encode("hello");

    expect(resolveStoredMimeType({
      bytes: bytes.buffer,
      fileType: "text/plain",
      telegramMimeType: "application/octet-stream"
    })).toBe("text/plain");
  });
});
