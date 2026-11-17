import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type * as RateLimiterFlexible from "rate-limiter-flexible";

// No Redis in unit tests: swap the Redis-backed limiter for the same library's
// in-memory one (identical consume/reject contract) so the REAL middleware and
// its key derivation run, with real per-key buckets.
vi.mock("ioredis", () => ({
  default: class {
    on(): void {}
  },
}));
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const real = await importOriginal<typeof RateLimiterFlexible>();
  return {
    ...real,
    RateLimiterRedis: class extends real.RateLimiterMemory {
      constructor(o: { keyPrefix: string; points: number; duration: number }) {
        super({ keyPrefix: o.keyPrefix, points: o.points, duration: o.duration });
      }
    },
  };
});

import { rateLimit } from "../../src/middleware/rate-limit.js";
import { onError } from "../../src/middleware/error.js";

const TOKEN = "unit-test-internal-token";
const LIMIT = 2;

let prefixSeq = 0;
function buildApp(): Hono {
  const app = new Hono();
  app.onError(onError);
  // A fresh prefix per app keeps each test's buckets separate.
  app.use("*", rateLimit({ points: LIMIT, durationSeconds: 60, keyPrefix: `t${++prefixSeq}` }));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

async function hit(app: Hono, headers: Record<string, string> = {}): Promise<number> {
  return (await app.request("/", { headers })).status;
}

/** Spend a caller's whole allowance, asserting every request was let through. */
async function exhaust(app: Hono, headers: Record<string, string> = {}): Promise<void> {
  for (let i = 0; i < LIMIT; i++) expect(await hit(app, headers)).toBe(200);
}

describe("rateLimit: per-shopper buckets behind the storefront", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.REDIS_URL = "redis://unused:6379";
    process.env.RATE_LIMIT_DISABLED = "0";
    process.env.INTERNAL_RECONCILE_TOKEN = TOKEN;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  const viaStorefront = (ip: string) => ({ "x-internal-token": TOKEN, "x-shopper-ip": ip });

  it("gives two shoppers behind the storefront separate buckets", async () => {
    const app = buildApp();
    await exhaust(app, viaStorefront("203.0.113.10"));
    expect(await hit(app, viaStorefront("203.0.113.10"))).toBe(429);
    // A second shopper is unaffected by the first one's usage.
    await exhaust(app, viaStorefront("203.0.113.11"));
    expect(await hit(app, viaStorefront("203.0.113.11"))).toBe(429);
  });

  it("accepts an IPv6 shopper address", async () => {
    const app = buildApp();
    await exhaust(app, viaStorefront("2001:db8::1"));
    expect(await hit(app, viaStorefront("2001:db8::1"))).toBe(429);
    expect(await hit(app, viaStorefront("2001:db8::2"))).toBe(200);
  });

  it("ignores a spoofed X-Shopper-IP from an outside caller (no secret)", async () => {
    const app = buildApp();
    // Rotating the header must NOT mint fresh buckets: all three share "anon".
    expect(await hit(app, { "x-shopper-ip": "198.51.100.1" })).toBe(200);
    expect(await hit(app, { "x-shopper-ip": "198.51.100.2" })).toBe(200);
    expect(await hit(app, { "x-shopper-ip": "198.51.100.3" })).toBe(429);
  });

  it("ignores X-Shopper-IP when the secret is wrong", async () => {
    const app = buildApp();
    const forged = (ip: string) => ({ "x-internal-token": "guess", "x-shopper-ip": ip });
    expect(await hit(app, forged("198.51.100.1"))).toBe(200);
    expect(await hit(app, forged("198.51.100.2"))).toBe(200);
    expect(await hit(app, forged("198.51.100.3"))).toBe(429);
  });

  it("is off by default: with no secret configured the header is never trusted", async () => {
    delete process.env.INTERNAL_RECONCILE_TOKEN;
    const app = buildApp();
    const empty = (ip: string) => ({ "x-internal-token": "", "x-shopper-ip": ip });
    expect(await hit(app, empty("198.51.100.1"))).toBe(200);
    expect(await hit(app, { "x-shopper-ip": "198.51.100.2" })).toBe(200);
    expect(await hit(app, empty("198.51.100.3"))).toBe(429);
  });

  it("still limits anonymous direct callers, keyed as before", async () => {
    const app = buildApp();
    await exhaust(app); // no headers at all → the shared "anon" bucket
    expect(await hit(app)).toBe(429);
    // A direct caller with a proxy-supplied X-Forwarded-For keeps its own bucket.
    await exhaust(app, { "x-forwarded-for": "192.0.2.7" });
    expect(await hit(app, { "x-forwarded-for": "192.0.2.7" })).toBe(429);
  });

  it("an outside caller cannot drain a shopper's bucket by forging X-Forwarded-For", async () => {
    const app = buildApp();
    await exhaust(app, { "x-forwarded-for": "203.0.113.10" });
    expect(await hit(app, { "x-forwarded-for": "203.0.113.10" })).toBe(429);
    // The real shopper at that address, coming through the storefront, is fine.
    expect(await hit(app, viaStorefront("203.0.113.10"))).toBe(200);
  });

  it("falls back to the old key when the storefront sends no usable address", async () => {
    const app = buildApp();
    const junk = { "x-internal-token": TOKEN, "x-shopper-ip": "not-an-ip" };
    await exhaust(app, junk);
    expect(await hit(app, junk)).toBe(429);
    expect(await hit(app, { "x-internal-token": TOKEN })).toBe(429); // same "anon" bucket
  });
});
