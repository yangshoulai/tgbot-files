import { describe, expect, it } from "vitest";
import { buildRewrittenMediaPlaylist, parseHlsPlaylist } from "../src/hls";

describe("HLS playlist parsing", () => {
  it("parses AES-128 encryption and derives missing IV from media sequence", () => {
    const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="enc.key"
#EXTINF:4.000,
seg-7.ts
#EXTINF:4.000,
seg-8.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4.000,
clear.ts
#EXT-X-ENDLIST
`;

    const plan = parseHlsPlaylist(playlist, new URL("https://media.example.com/path/index.m3u8"));

    expect(plan.kind).toBe("media");
    if (plan.kind !== "media") {
      return;
    }
    expect(plan.segments[0]?.encryption).toMatchObject({
      method: "AES-128",
      keyUri: "https://media.example.com/path/enc.key",
      rawKeyUri: "enc.key",
      ivHex: "00000000000000000000000000000007"
    });
    expect(plan.segments[1]?.encryption?.ivHex).toBe("00000000000000000000000000000008");
    expect(plan.segments[2]?.encryption).toBeNull();
  });

  it("uses explicit AES-128 IV for all following encrypted segments", () => {
    const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/enc.key",IV=0x0000000000000000000000000000000a
#EXTINF:4.000,
seg-0.ts
#EXTINF:4.000,
seg-1.ts
#EXT-X-ENDLIST
`;

    const plan = parseHlsPlaylist(playlist, new URL("https://media.example.com/index.m3u8"));

    expect(plan.kind).toBe("media");
    if (plan.kind !== "media") {
      return;
    }
    expect(plan.segments.map((segment) => segment.encryption?.ivHex)).toEqual([
      "0000000000000000000000000000000a",
      "0000000000000000000000000000000a"
    ]);
  });

  it("rejects non-AES-128 encryption methods", () => {
    const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="enc.key"
#EXTINF:4.000,
seg-0.ts
#EXT-X-ENDLIST
`;

    expect(() => parseHlsPlaylist(playlist, new URL("https://media.example.com/index.m3u8")))
      .toThrow("暂只支持 AES-128 加密 HLS");
  });

  it("strips key tags when rewriting a decrypted media playlist", () => {
    const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="enc.key"
#EXTINF:4.000,
seg-0.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4.000,
seg-1.ts
#EXT-X-ENDLIST
`;

    const rewritten = buildRewrittenMediaPlaylist({
      playlistText: playlist,
      targetDuration: 4,
      segments: [
        { index: 0, duration: 4, path: "https://files.example.com/api/hls/token/segments/0/seg-0.ts" },
        { index: 1, duration: 4, path: "https://files.example.com/api/hls/token/segments/1/seg-1.ts" }
      ]
    });

    expect(rewritten).not.toContain("#EXT-X-KEY");
    expect(rewritten).toContain("https://files.example.com/api/hls/token/segments/0/seg-0.ts");
    expect(rewritten).toContain("https://files.example.com/api/hls/token/segments/1/seg-1.ts");
  });
});
