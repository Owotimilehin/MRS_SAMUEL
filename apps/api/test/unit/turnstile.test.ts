import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "../../src/lib/turnstile.js";

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as never));
}

describe("verifyTurnstileToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes when no secret is configured (feature off)", async () => {
    expect(await verifyTurnstileToken(undefined, undefined)).toBe(true);
    expect(await verifyTurnstileToken(undefined, "anything")).toBe(true);
  });

  it("rejects when a secret is set but no token is sent", async () => {
    expect(await verifyTurnstileToken("secret", undefined)).toBe(false);
  });

  it("passes on a successful Cloudflare verification", async () => {
    mockFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await verifyTurnstileToken("secret", "tok")).toBe(true);
  });

  it("rejects when Cloudflare actively rejects the token", async () => {
    mockFetch(() => new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(await verifyTurnstileToken("secret", "tok")).toBe(false);
  });

  it("fails open on a Cloudflare non-2xx response", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    expect(await verifyTurnstileToken("secret", "tok")).toBe(true);
  });

  it("fails open when the request throws (network error)", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    expect(await verifyTurnstileToken("secret", "tok")).toBe(true);
  });
});
