import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Redis that is permanently offline — the production failure mode
// ("Stream isn't writeable and enableOfflineQueue options is false").
vi.mock("ioredis", () => {
  class OfflineRedis {
    on() { return this; }
    get() { return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false")); }
    set() { return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false")); }
  }
  return { default: OfflineRedis };
});
vi.mock("../env.js", () => ({ env: { REDIS_URL: "redis://offline:6379" } }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn() } }));

const graphPost = {
  id: "1",
  caption: "Fresh zobo pressed this morning in Lagos",
  media_type: "IMAGE",
  media_url: "https://cdn.example/1.jpg",
  permalink: "https://www.instagram.com/p/abc/",
  timestamp: "2026-11-15T08:00:00+0000",
};

describe("GET /feed", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.IG_BUSINESS_ACCOUNT_ID = "123";
    process.env.IG_ACCESS_TOKEN = "test-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.IG_BUSINESS_ACCOUNT_ID;
    delete process.env.IG_ACCESS_TOKEN;
  });

  it("still serves posts from Instagram when Redis is down", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [graphPost] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { publicInstagramRoutes } = await import("./public-instagram.js");
    const app = publicInstagramRoutes();

    const res = await app.request("/feed");
    const body = (await res.json()) as { data: { caption: string; permalink: string }[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.caption).toContain("Fresh zobo");

    // Second call is served from the in-memory cache — no extra Graph call.
    await app.request("/feed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("soft-fails without leaking internal error text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("token expired", { status: 400 })));
    const { publicInstagramRoutes } = await import("./public-instagram.js");
    const res = await publicInstagramRoutes().request("/feed");
    const body = (await res.json()) as { data: unknown[]; error?: string };
    expect(body.data).toEqual([]);
    expect(body.error).toBe("feed unavailable");
    expect(JSON.stringify(body)).not.toContain("token");
  });
});
