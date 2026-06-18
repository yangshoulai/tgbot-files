import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/utils/md5";

const encoder = new TextEncoder();

describe("md5Hex", () => {
  it("calculates known MD5 digests", () => {
    expect(md5Hex(encoder.encode("").buffer)).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(encoder.encode("hello").buffer)).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(md5Hex(encoder.encode("The quick brown fox jumps over the lazy dog").buffer)).toBe(
      "9e107d9d372bb6826bd81d3542a419d6"
    );
  });
});
