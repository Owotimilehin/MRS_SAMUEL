import { describe, it, expect, beforeAll } from "vitest";
import { issueAccessToken, verifyAccessToken } from "../../src/auth/jwt.js";

describe("jwt access tokens", () => {
  beforeAll(() => {
    process.env.JWT_SIGNING_KEY = "test-only-jwt-signing-key-padding-XXXXXX";
  });

  it("issues and verifies a token", async () => {
    const token = await issueAccessToken({
      sub: "user-1",
      role: "owner",
      branch_id: null,
      device_id: "d1",
    });
    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe("user-1");
    expect(payload.role).toBe("owner");
    expect(payload.device_id).toBe("d1");
    expect(payload.branch_id).toBe(null);
  });

  it("rejects tampered tokens", async () => {
    const token = await issueAccessToken({
      sub: "x",
      role: "owner",
      branch_id: null,
      device_id: "d",
    });
    await expect(verifyAccessToken(token + "tamper")).rejects.toThrow();
  });

  it("verifies a token signed with the previous key after rotation", async () => {
    // Issue with key A, then rotate
    process.env.JWT_SIGNING_KEY = "key-A-padding-padding-padding-padding-XXX";
    const tokenA = await issueAccessToken({
      sub: "u",
      role: "branch_staff",
      branch_id: "b1",
      device_id: "d",
    });
    // Rotate: current = B, previous = A
    process.env.JWT_SIGNING_KEY_PREVIOUS = process.env.JWT_SIGNING_KEY;
    process.env.JWT_SIGNING_KEY = "key-B-padding-padding-padding-padding-XXX";
    const verified = await verifyAccessToken(tokenA);
    expect(verified.sub).toBe("u");
    // Clean up
    delete process.env.JWT_SIGNING_KEY_PREVIOUS;
    process.env.JWT_SIGNING_KEY = "test-only-jwt-signing-key-padding-XXXXXX";
  });
});
