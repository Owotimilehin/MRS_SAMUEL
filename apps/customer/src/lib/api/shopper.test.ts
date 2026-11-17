// apps/customer/src/lib/api/shopper.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, setApiHeaderSource } from "./client";
import {
  shopperIpFrom,
  shopperHeadersFor,
  withShopper,
  currentShopperHeaders,
} from "./shopper.server";

const TOKEN = "unit-test-internal-token";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://www.example.test/checkout", { headers });
}

/** Stub fetch and return the headers each API call was sent with, keyed by path. */
function captureApiCalls(): Map<string, Record<string, string>> {
  const seen = new Map<string, Record<string, string>>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      // Yield, so concurrent requests genuinely interleave.
      await new Promise((r) => setTimeout(r, 5));
      seen.set(new URL(url).pathname, { ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return seen;
}

beforeEach(() => {
  vi.stubEnv("INTERNAL_RECONCILE_TOKEN", TOKEN);
  setApiHeaderSource(currentShopperHeaders); // what server.ts does at boot
});

afterEach(() => {
  setApiHeaderSource(() => ({}));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shopperIpFrom", () => {
  it("prefers Cloudflare's CF-Connecting-IP", () => {
    expect(
      shopperIpFrom(req({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "10.0.0.1" })),
    ).toBe("203.0.113.10");
  });

  it("otherwise takes the right-most X-Forwarded-For hop, not a client-supplied one", () => {
    expect(shopperIpFrom(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.11" }))).toBe("203.0.113.11");
  });

  it("is null when no proxy told us the address", () => {
    expect(shopperIpFrom(req())).toBeNull();
  });
});

describe("shopperHeadersFor", () => {
  it("pairs the shopper address with the internal secret", () => {
    expect(shopperHeadersFor(req({ "cf-connecting-ip": "203.0.113.10" }))).toEqual({
      "x-internal-token": TOKEN,
      "x-shopper-ip": "203.0.113.10",
    });
  });

  it("sends nothing when the secret is not configured (default off)", () => {
    vi.stubEnv("INTERNAL_RECONCILE_TOKEN", "");
    expect(shopperHeadersFor(req({ "cf-connecting-ip": "203.0.113.10" }))).toEqual({});
  });

  it("sends nothing (not even the secret) when the address is unknown", () => {
    expect(shopperHeadersFor(req())).toEqual({});
  });
});

describe("apiFetch inside withShopper", () => {
  it("forwards each shopper's own address on concurrent requests", async () => {
    const seen = captureApiCalls();
    await Promise.all([
      withShopper(req({ "cf-connecting-ip": "203.0.113.10" }), () => apiFetch("/v1/a")),
      withShopper(req({ "cf-connecting-ip": "203.0.113.11" }), () => apiFetch("/v1/b")),
    ]);
    expect(seen.get("/v1/a")).toMatchObject({
      "x-internal-token": TOKEN,
      "x-shopper-ip": "203.0.113.10",
    });
    expect(seen.get("/v1/b")).toMatchObject({
      "x-internal-token": TOKEN,
      "x-shopper-ip": "203.0.113.11",
    });
  });

  it("keeps the call's own headers alongside the shopper's", async () => {
    const seen = captureApiCalls();
    await withShopper(req({ "cf-connecting-ip": "203.0.113.10" }), () =>
      apiFetch("/v1/c", { method: "POST", headers: { "idempotency-key": "k1" } }),
    );
    expect(seen.get("/v1/c")).toMatchObject({
      accept: "application/json",
      "idempotency-key": "k1",
      "x-shopper-ip": "203.0.113.10",
    });
  });

  it("adds nothing outside a request", async () => {
    const seen = captureApiCalls();
    await apiFetch("/v1/d");
    expect(seen.get("/v1/d")).toEqual({ accept: "application/json" });
  });
});
