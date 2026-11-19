import { describe, it, expect } from "vitest";
import { socialUrlSignerFromEnv } from "./social-media-url.js";

// Signing is local arithmetic: nothing here reaches R2. The values below are made up.
const settings = { R2_ACCOUNT_ID: "acct-test", R2_ACCESS_KEY_ID: "AKIDTEST", R2_SECRET_ACCESS_KEY: "not-a-real-value", R2_BUCKET: "bucket-test" };
const KEY = "social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.jpg";

describe("socialUrlSignerFromEnv", () => {
  it("is null when file storage is not set up", () => {
    expect(socialUrlSignerFromEnv({})).toBeNull();
    expect(socialUrlSignerFromEnv({ ...settings, R2_BUCKET: "" })).toBeNull();
  });

  it("signs a one-hour GET link for a post file", async () => {
    const sign = socialUrlSignerFromEnv(settings)!;
    const url = new URL(await sign(KEY));
    expect(url.host).toContain("acct-test.r2.cloudflarestorage.com");
    expect(url.pathname).toContain(KEY);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The link carries a signature, never the value that made it.
    expect(url.href).not.toContain("not-a-real-value");
  });

  it("refuses anything that is not a post file", async () => {
    const sign = socialUrlSignerFromEnv(settings)!;
    await expect(sign("inbox/recordings/2026/11/call.mp3")).rejects.toThrow("not a post file");
    await expect(sign("social/posts/2026/11/../../inbox/secret.jpg")).rejects.toThrow("not a post file");
  });
});
