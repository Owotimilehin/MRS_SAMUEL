import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADS_TEMPORARY_CODES,
  adCreativeText,
  addDays,
  adsGraph,
  classifyAdsError,
  dayInZone,
  fetchAdInsights,
  latestAdsUsage,
  listAdAccounts,
  listAdObjectsPaged,
  readAdsUsage,
  resetAdsUsage,
} from "./ads.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test that calls out stubs fetch. The token is an obvious fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
type Call = { url: string; method: string; auth: string | null };
function stub(handler: (c: Call, n: number) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>)?.authorization ?? null };
      calls.push(call);
      return handler(call, calls.length);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAdsUsage();
});

describe("readAdsUsage", () => {
  it("parses the three headers; malformed headers give nulls", () => {
    const h = new Headers({
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 41.5, reset_time_duration: 120, ads_api_access_tier: "development_access" }),
      "x-business-use-case-usage": JSON.stringify({
        "1234500001": [
          { type: "ads_management", call_count: 12, total_cputime: 30, total_time: 85, estimated_time_to_regain_access: 5 },
          { type: "ads_insights", call_count: 3, total_cputime: 1, total_time: 2, estimated_time_to_regain_access: 0 },
        ],
        "999": [{ call_count: 100, total_cputime: 100, total_time: 100 }],
      }),
      "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 10, acc_id_util_pct: 55, ads_api_access_tier: "development_access" }),
    });
    expect(readAdsUsage(h, "act_1234500001")).toEqual({ accountPct: 55, businessPct: 85, regainSeconds: 300, tier: "development_access" });
    expect(readAdsUsage(new Headers(), "1234500001")).toEqual({ accountPct: null, businessPct: null, regainSeconds: null, tier: null });
    const bad = new Headers({ "x-ad-account-usage": "{not json", "x-business-use-case-usage": "[]", "x-fb-ads-insights-throttle": "42" });
    expect(readAdsUsage(bad, "1234500001")).toEqual({ accountPct: null, businessPct: null, regainSeconds: null, tier: null });
  });
});

describe("adsGraph", () => {
  it("remembers the latest usage per ad account and keeps the token out of the address", async () => {
    const calls = stub(() => json({ id: "act_1234500001" }, 200, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 82 }) }));
    await adsGraph(cfg, "GET", "act_1234500001?fields=id");
    expect(latestAdsUsage("act_1234500001")?.accountPct).toBe(82);
    expect(latestAdsUsage("1234500001")?.accountPct).toBe(82);
    expect(latestAdsUsage("act_777")).toBeNull();
    expect(calls[0]!.url).not.toContain("SYSTEM-USER-TEST");
    expect(calls[0]!.auth).toBe("Bearer SYSTEM-USER-TEST");
  });
});

describe("reads", () => {
  it("every read is a GET, and paging is followed only on the Graph API's own address", async () => {
    const calls = stub((c, n) => {
      if (n === 1) return json({ data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/v23.0/act_1/campaigns?after=abc" } });
      if (n === 2) return json({ data: [{ id: "2" }], paging: { next: "https://elsewhere.invalid/steal?after=abc" } });
      return json({ data: [{ id: "never" }] });
    });
    const res = await listAdObjectsPaged(cfg, "act_1", "campaign");
    expect(res.rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.includes("elsewhere.invalid"))).toBe(false);
  });
  it("says so when the list was cut short at 20 pages", async () => {
    stub(() => json({ data: [{ id: "x" }], paging: { next: "https://graph.facebook.com/v23.0/act_1/adsets?after=more" } }));
    const res = await listAdObjectsPaged(cfg, "act_1", "adset");
    expect(res.rows).toHaveLength(20);
    expect(res.complete).toBe(false);
  });
  it("listAdAccounts asks for the accounts the token can use", async () => {
    const calls = stub(() =>
      json({ data: [{ id: "act_1234500001", account_id: "1234500001", name: "Test Ads", currency: "NGN", timezone_name: "Africa/Lagos", timezone_offset_hours_utc: 1, account_status: 1 }] }),
    );
    const list = await listAdAccounts(cfg);
    expect(list[0]).toMatchObject({ id: "act_1234500001", currency: "NGN", account_status: 1 });
    expect(calls[0]!.url).toContain("/me/adaccounts?fields=");
    expect(calls[0]!.method).toBe("GET");
  });
  it("listAdAccounts falls back to the system user's assigned accounts when Meta refuses me/adaccounts", async () => {
    const calls = stub((c) => {
      if (c.url.includes("/me/adaccounts")) return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
      if (c.url.includes("/me?fields=id")) return json({ id: "61500000000001" });
      if (c.url.includes("/61500000000001/assigned_ad_accounts")) return json({ data: [{ id: "act_1234500001", account_id: "1234500001", name: "Test Ads", currency: "NGN" }] });
      return json({ error: { message: "nope", code: 100 } }, 400);
    });
    expect((await listAdAccounts(cfg)).map((a) => a.id)).toEqual(["act_1234500001"]);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("listAdAccounts does not hide a token or permission problem behind the fallback", async () => {
    const calls = stub(() => json({ error: { message: "Invalid OAuth access token", code: 190 } }, 401));
    await expect(listAdAccounts(cfg)).rejects.toMatchObject({ code: "190" });
    expect(calls).toHaveLength(1);
  });
  it("fetchAdInsights asks day by day with the account's attribution setting", async () => {
    const calls = stub(() => json({ data: [] }));
    await fetchAdInsights(cfg, "act_1", "ad", "2026-11-01", "2026-11-08");
    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain("act_1/insights?level=ad&time_increment=1");
    expect(url).toContain('time_range={"since":"2026-11-01","until":"2026-11-08"}');
    expect(url).toContain("use_unified_attribution_setting=true");
    expect(url).toContain("ad_id");
    await fetchAdInsights(cfg, "act_1", "account", "2026-11-01", "2026-11-08");
    expect(decodeURIComponent(calls[1]!.url)).not.toContain("ad_id");
  });
});

describe("classifyAdsError", () => {
  const err = (code: string | null, status = 400, delivery: "not_sent" | "unknown" = "not_sent") => new MetaApiError("x", status, code, false, delivery);
  it("token and permission codes are configuration", () => {
    for (const c of ["190", "10", "200", "299", "283"]) expect(classifyAdsError(err(c))).toBe("config");
  });
  it("rate limits are temporary, including the Marketing API's own codes", () => {
    for (const c of ["4", "17", "32", "613", "80000", "80003", "80004", "80014"]) {
      expect(ADS_TEMPORARY_CODES.has(c)).toBe(true);
      expect(classifyAdsError(err(c))).toBe("temporary");
    }
    expect(classifyAdsError(err(null, 429))).toBe("temporary");
  });
  it("no answer is unknown, never a refusal", () => {
    expect(classifyAdsError(err(null, 0, "unknown"))).toBe("unknown");
    expect(classifyAdsError(err(null, 502, "unknown"))).toBe("unknown");
  });
  it("anything else is a refusal", () => {
    expect(classifyAdsError(err("100"))).toBe("refusal");
    expect(classifyAdsError(new Error("boom"))).toBe("refusal");
  });
});

describe("small helpers", () => {
  it("dayInZone and addDays", () => {
    const at = new Date("2026-11-19T23:30:00Z");
    expect(dayInZone(at, "Africa/Lagos")).toBe("2026-11-20");
    expect(dayInZone(at, "America/Los_Angeles")).toBe("2026-11-19");
    expect(dayInZone(at, "Not/AZone")).toBe("2026-11-19");
    expect(addDays("2026-11-20", -89)).toBe("2026-08-23");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("adCreativeText keeps the words and never a picture link", () => {
    const t = adCreativeText({ id: "9", title: null, body: null, image_url: "https://example.invalid/a.jpg", object_story_spec: { link_data: { name: "Fresh juice", message: "Cold today", picture: "https://example.invalid/b.jpg" } } });
    expect(t).toEqual({ title: "Fresh juice", body: "Cold today" });
    expect(adCreativeText(null)).toBeNull();
  });
});
