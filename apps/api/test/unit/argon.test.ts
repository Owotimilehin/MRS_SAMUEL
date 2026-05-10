import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/argon.js";

describe("argon password hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correcthorsebatterystaple");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "correcthorsebatterystaple")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("returns false (not throw) on malformed hash", async () => {
    expect(await verifyPassword("not-a-real-hash", "anything")).toBe(false);
  });
});
