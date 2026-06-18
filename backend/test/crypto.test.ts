import { describe, expect, it } from "vitest";
import { createSignedToken, verifySignedToken } from "../src/utils/crypto";

const payload = {
  v: 1 as const,
  file_id: "BQACAgUAAxkBAAIB_test",
  name: "测试文件.txt",
  mime_type: "text/plain",
  size: 12,
  iat: 1_768_566_400
};

describe("signed file token", () => {
  it("generates and verifies a token", async () => {
    const token = await createSignedToken(payload, "secret-for-tests");

    await expect(verifySignedToken(token, "secret-for-tests")).resolves.toEqual(payload);
  });

  it("rejects a tampered token", async () => {
    const token = await createSignedToken(payload, "secret-for-tests");
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(verifySignedToken(tampered, "secret-for-tests")).rejects.toThrow("Invalid token signature");
  });
});
