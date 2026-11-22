import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaHealthValue } from "@ms/shared";
import {
  classifyCheckError,
  classifyNumber,
  classifyPageLine,
  classifyToken,
  classifyWaba,
  collectMetaHealth,
  mergeMetaHealth,
  neededScopes,
  parseMetaHealthValue,
  REALERT_AFTER_MS,
  type HealthLine,
  type HealthOutcome,
} from "./meta-health.js";
import { MetaApiError, type MetaConfig } from "./meta.js";

const NOW = new Date("2026-11-22T10:00:00.000Z");
const TOKEN = "unit-test-system-token-SECRET";
const cfg: MetaConfig = { token: TOKEN, graphVersion: "v23.0" };
const unix = (ms: number): number => Math.floor(ms / 1000);

function line(over: Partial<HealthLine>): HealthLine {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "phone",
    label: "Main line",
    channels: "both",
    wabaId: "104857600123456",
    waPhoneNumberId: "900100200300",
    webhookCheckedAt: null,
    webhookSubscribedAt: null,
    problemText: null,
    problemAt: null,
    ...over,
  };
}

const ALL_SCOPES = ["whatsapp_business_messaging", "whatsapp_business_management", "pages_messaging", "instagram_manage_messages"];

describe("classifyToken", () => {
  it("is ok for a valid key that never runs out with the permissions it needs", () => {
    const v = classifyToken({ is_valid: true, expires_at: 0, scopes: ALL_SCOPES }, NOW, ["whatsapp_business_messaging"]);
    expect(v.status).toBe("ok");
  });
  it("is broken when Meta says the key is not valid, or says nothing", () => {
    expect(classifyToken({ is_valid: false }, NOW, []).status).toBe("broken");
    expect(classifyToken(null, NOW, []).status).toBe("broken");
    expect(classifyToken({ is_valid: false }, NOW, []).impact).toMatch(/not getting replies/);
  });
  it("is broken once it has run out, and a warning in the last 7 days", () => {
    expect(classifyToken({ is_valid: true, expires_at: unix(NOW.getTime() - 1000), scopes: ALL_SCOPES }, NOW, []).status).toBe("broken");
    const soon = classifyToken({ is_valid: true, expires_at: unix(NOW.getTime() + 2.5 * 86400_000), scopes: ALL_SCOPES }, NOW, []);
    expect(soon.status).toBe("warning");
    expect(soon.reason).toContain("3 days");
    expect(classifyToken({ is_valid: true, expires_at: unix(NOW.getTime() + 30 * 86400_000) }, NOW, []).status).toBe("ok");
  });
  it("warns about a missing permission, also counting granular scopes", () => {
    const v = classifyToken({ is_valid: true, scopes: ["whatsapp_business_management"] }, NOW, ["whatsapp_business_messaging"]);
    expect(v.status).toBe("warning");
    expect(v.reason).toContain("whatsapp_business_messaging");
    expect(
      classifyToken({ is_valid: true, granular_scopes: [{ scope: "whatsapp_business_messaging" }] }, NOW, ["whatsapp_business_messaging"]).status,
    ).toBe("ok");
  });
  it("never puts the token in the reason", () => {
    const v = classifyToken({ is_valid: false }, NOW, []);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });
});

describe("neededScopes", () => {
  it("asks only for what the connected channels use", () => {
    expect(neededScopes([line({ channels: "voice" })])).toEqual([]);
    expect(neededScopes([line({}), line({ kind: "instagram", waPhoneNumberId: null })])).toEqual([
      "instagram_manage_messages",
      "whatsapp_business_management",
      "whatsapp_business_messaging",
    ]);
  });
});

describe("classifyNumber", () => {
  it.each([
    ["CONNECTED", "GREEN", "ok"],
    ["CONNECTED", "YELLOW", "ok"],
    ["CONNECTED", "RED", "warning"],
    ["FLAGGED", "RED", "warning"],
    ["RESTRICTED", "GREEN", "warning"],
    ["RATE_LIMITED", "GREEN", "warning"],
    ["PENDING", undefined, "warning"],
    ["BANNED", undefined, "broken"],
    ["DISCONNECTED", undefined, "broken"],
    ["DELETED", undefined, "broken"],
    ["MIGRATED", undefined, "broken"],
    [undefined, undefined, "warning"],
  ] as const)("status %s, quality %s → %s", (status, quality, expected) => {
    const info = { ...(status ? { status } : {}), ...(quality ? { quality_rating: quality } : {}) };
    expect(classifyNumber(info, "Main line").status).toBe(expected);
  });
  it("names the line in what it means for customers", () => {
    expect(classifyNumber({ status: "BANNED" }, "Main line").impact).toBe("Customers on WhatsApp (Main line) are not getting replies");
  });
});

describe("classifyWaba", () => {
  it("is ok when Meta says the account can send", () => {
    expect(classifyWaba({ health_status: { can_send_message: "AVAILABLE" }, account_review_status: "APPROVED" }, null).status).toBe("ok");
  });
  it("is a warning when limited, with Meta's explanation", () => {
    const v = classifyWaba(
      {
        health_status: {
          can_send_message: "LIMITED",
          entities: [
            { entity_type: "BUSINESS", can_send_message: "AVAILABLE" },
            {
              entity_type: "WABA",
              can_send_message: "LIMITED",
              errors: [{ error_code: 141006, error_description: "There is an error with the payment method." }],
            },
          ],
        },
      },
      null,
    );
    expect(v.status).toBe("warning");
    expect(v.reason).toBe("Meta is limiting what the WhatsApp account can send: There is an error with the payment method.");
  });
  it("is broken when blocked or rejected in review", () => {
    expect(classifyWaba({ health_status: { can_send_message: "BLOCKED" } }, null).status).toBe("broken");
    expect(classifyWaba({ account_review_status: "REJECTED" }, null).status).toBe("broken");
    expect(classifyWaba({ account_review_status: "PENDING" }, null).status).toBe("warning");
  });
  it("is broken when the account_update webhook recorded a block, even if the health read looks fine", () => {
    const v = classifyWaba({ health_status: { can_send_message: "AVAILABLE" } }, { event: "ACCOUNT_RESTRICTION", detail: null });
    expect(v.status).toBe("broken");
    expect(v.reason).toContain("ACCOUNT_RESTRICTION");
  });
});

describe("classifyPageLine", () => {
  const page = (over: Partial<HealthLine>) =>
    line({ kind: "messenger", label: "Facebook Page", waPhoneNumberId: null, wabaId: null, ...over });
  const hourAgo = new Date(NOW.getTime() - 3600_000);
  it("is ok after a recent good check", () => {
    expect(classifyPageLine(page({ webhookSubscribedAt: hourAgo, webhookCheckedAt: hourAgo }), NOW).status).toBe("ok");
  });
  it("is broken when a problem is newer than the last good check, and clears after the next good check", () => {
    const broken = page({ webhookSubscribedAt: hourAgo, webhookCheckedAt: hourAgo, problemText: "Meta refused.", problemAt: NOW });
    expect(classifyPageLine(broken, NOW)).toMatchObject({ status: "broken", reason: "Meta refused." });
    const cleared = page({ webhookSubscribedAt: hourAgo, webhookCheckedAt: NOW, problemText: "Meta refused.", problemAt: hourAgo });
    expect(classifyPageLine(cleared, NOW).status).toBe("ok");
  });
  it("warns when never subscribed or not checked for over 3 hours", () => {
    expect(classifyPageLine(page({}), NOW).status).toBe("warning");
    const stale = new Date(NOW.getTime() - 5 * 3600_000);
    const v = classifyPageLine(page({ webhookSubscribedAt: stale, webhookCheckedAt: stale }), NOW);
    expect(v.status).toBe("warning");
    expect(v.reason).toContain("5 hours");
  });
  it("says Instagram for an Instagram row", () => {
    expect(classifyPageLine(page({ kind: "instagram", label: "IG" }), NOW).impact).toContain("Instagram (IG)");
  });
});

describe("classifyCheckError", () => {
  it("leaves a temporary failure to the next run", () => {
    expect(classifyCheckError(new MetaApiError("No answer from Meta", 0, null, true, "unknown"), "x are not y")).toBeNull();
    expect(classifyCheckError(new Error("boom"), "x")).toBeNull();
  });
  it("calls an expired key broken, a permission refusal broken, anything else a warning", () => {
    expect(classifyCheckError(new MetaApiError("expired", 401, "190", false), "Customers are not getting replies")?.status).toBe("broken");
    expect(classifyCheckError(new MetaApiError("no", 400, "100", false, "not_sent", "33"), "x")?.status).toBe("broken");
    const w = classifyCheckError(new MetaApiError("odd", 400, "803", false), "Customers are not getting replies");
    expect(w).toMatchObject({ status: "warning", impact: "Customers may not be getting replies" });
    expect(w?.reason).toContain("803");
  });
});

// ── collectMetaHealth with Meta mocked ──────────────────────────────────────

type Answer = { status: number; body: unknown } | "network";
let answers: Record<string, Answer>;
let calls: { method: string; url: string; auth: string | null }[];

beforeEach(() => {
  answers = {};
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected network call: ${url}`);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+\//, "");
    calls.push({ method: init?.method ?? "GET", url, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const a = answers[path];
    if (a === "network") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (!a) return new Response(JSON.stringify({ error: { message: `no stub for ${path}`, code: 100 } }), { status: 400 });
    return new Response(JSON.stringify(a.body), { status: a.status });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const WA = line({});
const IG = line({
  id: "22222222-2222-2222-2222-222222222222",
  kind: "instagram",
  label: "Instagram",
  wabaId: null,
  waPhoneNumberId: null,
  webhookSubscribedAt: new Date(NOW.getTime() - 3600_000),
  webhookCheckedAt: new Date(NOW.getTime() - 3600_000),
});
const okToken = { status: 200, body: { data: { is_valid: true, expires_at: 0, scopes: ALL_SCOPES } } };

describe("collectMetaHealth (Meta mocked)", () => {
  it("reads the token, the number and the account; reads Pages from the row only; only GETs", async () => {
    answers["debug_token"] = okToken;
    answers["900100200300"] = { status: 200, body: { status: "CONNECTED", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" } };
    answers["104857600123456"] = { status: 200, body: { health_status: { can_send_message: "AVAILABLE" }, account_review_status: "APPROVED" } };
    const r = await collectMetaHealth(cfg, [WA, IG], NOW);
    expect(r.outcomes.map((o) => [o.key, "status" in o ? o.status : "unchecked"])).toEqual([
      ["token", "ok"],
      [`line:${WA.id}`, "ok"],
      ["waba:104857600123456", "ok"],
      [`line:${IG.id}`, "ok"],
    ]);
    expect(r.numberInfo.get(WA.id)?.messaging_limit_tier).toBe("TIER_1K");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls).toHaveLength(3);
    // The token goes only to Meta, in the header and as input_token.
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(new URL(calls[0]!.url).searchParams.get("input_token")).toBe(TOKEN);
    expect(JSON.stringify(r.outcomes)).not.toContain(TOKEN);
  });

  it("stops after a revoked token (code 190) and leaves the other items unchecked", async () => {
    answers["debug_token"] = { status: 401, body: { error: { message: "Error validating access token", code: 190 } } };
    const r = await collectMetaHealth(cfg, [WA, IG], NOW);
    expect(r.outcomes[0]).toMatchObject({ key: "token", status: "broken" });
    expect(r.outcomes.filter((o) => "unchecked" in o).map((o) => o.key)).toEqual([`line:${WA.id}`, "waba:104857600123456"]);
    expect(calls).toHaveLength(1);
  });

  it("treats is_valid=false the same way", async () => {
    answers["debug_token"] = { status: 200, body: { data: { is_valid: false } } };
    const r = await collectMetaHealth(cfg, [WA], NOW);
    expect(r.outcomes[0]).toMatchObject({ status: "broken" });
    expect(calls).toHaveLength(1);
  });

  it("leaves an item unchecked when Meta does not answer, and keeps going", async () => {
    answers["debug_token"] = okToken;
    answers["900100200300"] = "network";
    answers["104857600123456"] = { status: 200, body: { health_status: { can_send_message: "BLOCKED" } } };
    const r = await collectMetaHealth(cfg, [WA], NOW);
    expect(r.outcomes.find((o) => o.key === `line:${WA.id}`)).toMatchObject({ unchecked: true });
    expect(r.outcomes.find((o) => o.key === "waba:104857600123456")).toMatchObject({ status: "broken" });
  });

  it("keeps a recorded account block when the account read fails", async () => {
    answers["debug_token"] = okToken;
    answers["900100200300"] = { status: 200, body: { status: "CONNECTED" } };
    answers["104857600123456"] = "network";
    const r = await collectMetaHealth(cfg, [WA], NOW, { accountBlocks: { "104857600123456": { event: "DISABLED_UPDATE" } } });
    expect(r.outcomes.find((o) => o.key === "waba:104857600123456")).toMatchObject({ status: "broken" });
  });

  it("skips a calls-only line", async () => {
    answers["debug_token"] = okToken;
    const r = await collectMetaHealth(cfg, [line({ channels: "voice" })], NOW);
    expect(r.outcomes.map((o) => o.key)).toEqual(["token"]);
    // A calls-only line gets no dot from the access key either.
    expect(r.outcomes[0]!.line_ids).toEqual([]);
  });
});

// ── mergeMetaHealth: since and the alert rule ───────────────────────────────

const out = (over: Partial<Extract<HealthOutcome, { status: unknown }>> = {}): HealthOutcome => ({
  key: "line:a",
  kind: "whatsapp_number",
  label: "WhatsApp Main line",
  line_ids: ["a"],
  status: "ok",
  reason: "Connected to WhatsApp.",
  impact: "Customers are getting replies",
  ...over,
});
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

describe("mergeMetaHealth", () => {
  it("alerts once when an item goes from ok to broken, not again while it stays broken", () => {
    const first = mergeMetaHealth(null, [out()], NOW);
    expect(first.newlyBroken).toEqual([]);
    const broke = mergeMetaHealth(first.value, [out({ status: "broken", reason: "Meta has banned this number." })], later(3600_000));
    expect(broke.newlyBroken.map((i) => i.key)).toEqual(["line:a"]);
    expect(broke.value.items["line:a"]!.alerted_at).toBe(later(3600_000).toISOString());
    expect(broke.value.items["line:a"]!.since).toBe(later(3600_000).toISOString());
    const still = mergeMetaHealth(broke.value, [out({ status: "broken", reason: "Meta has banned this number." })], later(2 * 3600_000));
    expect(still.newlyBroken).toEqual([]);
    expect(still.value.items["line:a"]!.since).toBe(later(3600_000).toISOString());
  });

  it("alerts for an item that is broken on its very first check", () => {
    expect(mergeMetaHealth(null, [out({ status: "broken" })], NOW).newlyBroken).toHaveLength(1);
  });

  it("alerts when a warning becomes broken, but not for a warning", () => {
    const w = mergeMetaHealth(null, [out({ status: "warning" })], NOW);
    expect(w.newlyBroken).toEqual([]);
    expect(mergeMetaHealth(w.value, [out({ status: "broken" })], later(3600_000)).newlyBroken).toHaveLength(1);
  });

  it("does not re-alert an item flapping within 6 hours, but does after", () => {
    const a = mergeMetaHealth(null, [out({ status: "broken" })], NOW);
    const ok = mergeMetaHealth(a.value, [out()], later(3600_000));
    expect(ok.value.items["line:a"]!.alerted_at).toBe(NOW.toISOString());
    expect(mergeMetaHealth(ok.value, [out({ status: "broken" })], later(2 * 3600_000)).newlyBroken).toEqual([]);
    expect(mergeMetaHealth(ok.value, [out({ status: "broken" })], later(REALERT_AFTER_MS + 1)).newlyBroken).toHaveLength(1);
  });

  it("never alerts for a Page (ensureMetaSubscriptions already alerts for those)", () => {
    expect(mergeMetaHealth(null, [out({ kind: "page", status: "broken" })], NOW).newlyBroken).toEqual([]);
  });

  it("keeps the stored record for an unchecked item, and leaves out an unchecked item never seen", () => {
    const a = mergeMetaHealth(null, [out({ status: "broken" })], NOW);
    const u = mergeMetaHealth(
      a.value,
      [
        { key: "line:a", kind: "whatsapp_number", label: "WhatsApp Main line", line_ids: ["a"], unchecked: true },
        { key: "line:new", kind: "whatsapp_number", label: "WhatsApp New", line_ids: ["new"], unchecked: true },
      ],
      later(3600_000),
    );
    expect(u.value.items["line:a"]).toEqual(a.value.items["line:a"]);
    expect(u.value.items["line:new"]).toBeUndefined();
    expect(u.newlyBroken).toEqual([]);
  });

  it("drops items for lines that are no longer checked", () => {
    const a = mergeMetaHealth(null, [out(), out({ key: "line:gone", line_ids: ["gone"] })], NOW);
    expect(Object.keys(mergeMetaHealth(a.value, [out()], later(1)).value.items)).toEqual(["line:a"]);
  });
});

describe("parseMetaHealthValue", () => {
  it("reads a stored value and skips junk", () => {
    const stored: MetaHealthValue = mergeMetaHealth(null, [out()], NOW).value;
    expect(parseMetaHealthValue(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(parseMetaHealthValue(null)).toBeNull();
    expect(parseMetaHealthValue({ items: { x: { status: "weird" }, y: null } })).toEqual({ checked_at: null, items: {} });
  });
});
