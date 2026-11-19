import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pageAccessToken, clearPageTokenCache, listConnectablePages, withPageToken, describePage } from "./accounts.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test stubs fetch. Tokens here are obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearPageTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pageAccessToken", () => {
  it("pageAccessToken fetches once and serves the cache for an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
    fetchMock.mockImplementation(async () => json({ access_token: "PAGE-TOKEN-1", id: "111" }));

    expect(await pageAccessToken(cfg, "111")).toBe("PAGE-TOKEN-1");
    expect(await pageAccessToken(cfg, "111")).toBe("PAGE-TOKEN-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/111?fields=access_token");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer SYSTEM-USER-TEST");

    vi.setSystemTime(new Date("2026-11-19T10:59:59Z"));
    await pageAccessToken(cfg, "111");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-19T11:00:01Z"));
    fetchMock.mockImplementation(async () => json({ access_token: "PAGE-TOKEN-2", id: "111" }));
    expect(await pageAccessToken(cfg, "111")).toBe("PAGE-TOKEN-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pageAccessToken makes one request for concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async () => {
      await gate;
      return json({ access_token: "PAGE-TOKEN-C" });
    });
    const calls = Array.from({ length: 10 }, () => pageAccessToken(cfg, "222"));
    release();
    expect(await Promise.all(calls)).toEqual(Array(10).fill("PAGE-TOKEN-C"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pageAccessToken throws no_page_token when Meta returns no token, and does not cache the failure", async () => {
    fetchMock.mockImplementationOnce(async () => json({ id: "333" }));
    const err = await pageAccessToken(cfg, "333").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe("no_page_token");
    expect((err as MetaApiError).retryable).toBe(false);

    fetchMock.mockImplementationOnce(async () => json({ access_token: "PAGE-TOKEN-3" }));
    expect(await pageAccessToken(cfg, "333")).toBe("PAGE-TOKEN-3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a Meta refusal either", async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: { message: "Invalid token", code: 190 } }, 400));
    await expect(pageAccessToken(cfg, "444")).rejects.toMatchObject({ code: "190" });
    fetchMock.mockImplementationOnce(async () => json({ access_token: "PAGE-TOKEN-4" }));
    expect(await pageAccessToken(cfg, "444")).toBe("PAGE-TOKEN-4");
  });

  it("clearPageTokenCache forces a new fetch", async () => {
    fetchMock.mockImplementation(async () => json({ access_token: "PAGE-TOKEN-5" }));
    await pageAccessToken(cfg, "555");
    await pageAccessToken(cfg, "666");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clearPageTokenCache("555");
    await pageAccessToken(cfg, "555");
    await pageAccessToken(cfg, "666");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clearPageTokenCache();
    await pageAccessToken(cfg, "666");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("withPageToken returns the config with the Page token", async () => {
    fetchMock.mockImplementation(async () => json({ access_token: "PAGE-TOKEN-6" }));
    expect(await withPageToken(cfg, "777")).toEqual({ ...cfg, token: "PAGE-TOKEN-6" });
  });
});

describe("listConnectablePages", () => {
  it("listConnectablePages maps tasks, canMessage and the Instagram account, and follows paging", async () => {
    fetchMock
      .mockImplementationOnce(async () =>
        json({
          data: [
            {
              id: "1001",
              name: "Mrs Samuel fruit juice",
              tasks: ["ANALYZE", "MESSAGING", "MODERATE"],
              instagram_business_account: { id: "1784000", username: "mrs_samuelfruitjuice" },
            },
          ],
          paging: { next: "https://graph.facebook.com/v23.0/me/accounts?after=CURSOR" },
        }),
      )
      .mockImplementationOnce(async () => json({ data: [{ id: "1002", name: "Other Page", tasks: ["ANALYZE"] }], paging: {} }));

    const pages = await listConnectablePages(cfg);
    expect(pages).toEqual([
      {
        pageId: "1001",
        name: "Mrs Samuel fruit juice",
        tasks: ["ANALYZE", "MESSAGING", "MODERATE"],
        canMessage: true,
        instagram: { id: "1784000", username: "mrs_samuelfruitjuice" },
      },
      { pageId: "1002", name: "Other Page", tasks: ["ANALYZE"], canMessage: false, instagram: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://graph.facebook.com/v23.0/me/accounts?fields=name,tasks,instagram_business_account{id,username}&limit=100",
    );
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("https://graph.facebook.com/v23.0/me/accounts?after=CURSOR");
  });

  it("stops after ten pages", async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: [{ id: "1", name: "P" }], paging: { next: "https://graph.facebook.com/v23.0/me/accounts?after=X" } }),
    );
    const pages = await listConnectablePages(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(pages).toHaveLength(10);
  });
});

describe("describePage", () => {
  it("assumes messaging rights and reads the Instagram account", async () => {
    fetchMock.mockImplementation(async () =>
      json({ id: "1001", name: "Mrs Samuel fruit juice", instagram_business_account: { id: "1784000", username: "ms" } }),
    );
    expect(await describePage(cfg, "1001")).toEqual({
      pageId: "1001",
      name: "Mrs Samuel fruit juice",
      tasks: [],
      canMessage: true,
      instagram: { id: "1784000", username: "ms" },
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://graph.facebook.com/v23.0/1001?fields=name,instagram_business_account{id,username}",
    );
  });
});
