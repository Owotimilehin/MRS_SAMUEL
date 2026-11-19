import { afterEach, describe, expect, it, vi } from "vitest";
import { adSourceText, fetchAdSource } from "./ad-source.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the 'came from an advert' line (suite spec 12, 7.8)", () => {
  it("says the headline and the Lagos day", () => {
    expect(adSourceText({ touched_at: "2026-11-19T10:00:00Z", channel: "whatsapp", headline: "Fresh juice, delivered today", ad_name: null })).toBe(
      'Came from an advert: "Fresh juice, delivered today" · Thu 19 Nov',
    );
  });
  it("without a headline, only the day; the day is the Lagos day", () => {
    expect(adSourceText({ touched_at: "2026-11-19T23:30:00Z", channel: "messenger", headline: null, ad_name: null })).toBe("Came from an advert · Fri 20 Nov");
    expect(adSourceText({ touched_at: "2026-11-19T10:00:00Z", channel: "whatsapp", headline: "   ", ad_name: null })).toBe("Came from an advert · Thu 19 Nov");
    expect(adSourceText({ touched_at: "not a date", channel: "whatsapp", headline: null, ad_name: null })).toBe("Came from an advert");
  });
});

describe("fetchAdSource stays silent on any error", () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  it("returns the source when the server has one", async () => {
    const f = answer(200, { data: { touched_at: "2026-11-19T10:00:00Z", channel: "whatsapp", headline: "Zobo is back", ad_name: null } });
    vi.stubGlobal("fetch", f);
    expect(await fetchAdSource("c1")).toEqual({ touched_at: "2026-11-19T10:00:00Z", channel: "whatsapp", headline: "Zobo is back", ad_name: null });
    // One request, to the ads route, and no second try.
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("/v1/ads/conversations/c1/source");
  });
  it("null when the conversation did not come from an advert", async () => {
    vi.stubGlobal("fetch", answer(200, { data: null }));
    expect(await fetchAdSource("c1")).toBeNull();
  });
  it("null, with no retry, for a missing route, no permission, a server error, a bad body or no network", async () => {
    for (const f of [answer(404, { error: { code: "not_found" } }), answer(403, {}), answer(401, {}), answer(500, "oops"), answer(502, "bad gateway"), answer(200, "<html>"), answer(200, { data: { headline: "x" } })]) {
      vi.stubGlobal("fetch", f);
      expect(await fetchAdSource("c1")).toBeNull();
      expect(f).toHaveBeenCalledTimes(1);
    }
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", down);
    expect(await fetchAdSource("c1")).toBeNull();
    expect(down).toHaveBeenCalledTimes(1);
  });
});
