import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BROADCAST_SETTINGS } from "@ms/shared";
import { buildSendPayload, buildTemplateComponents, sendMessage, type MetaConfig } from "../inbox/meta.js";
import { decideAudience, type AudienceFacts } from "../contacts/audience.js";
import {
  broadcastFingerprint,
  classifyBroadcastError,
  getMmStatus,
  safetyVerdict,
  uploadWaMedia,
  type SafetyFacts,
} from "./broadcasts.js";

/**
 * Suite spec 14, Phase B: the pure rules of the broadcast engine. No test here reaches Meta:
 * every Graph call goes to a stubbed fetch, and the token is a made-up value.
 */
const cfg: MetaConfig = { token: "test-token-not-real", graphVersion: "v23.0", baseUrl: "https://graph.test" };
const NOW = new Date("2026-11-20T11:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyBroadcastError", () => {
  it("131026/131049/131050 are recipient results; 130429/131056/80007/429 temporary", () => {
    for (const c of ["131026", "131049", "131050", "130472", "131062"]) expect(classifyBroadcastError(c).cls).toBe("recipient");
    for (const c of ["130429", "131056", "80007", "4", "2", "131057", "131000"]) expect(classifyBroadcastError(c).cls).toBe("temporary");
    expect(classifyBroadcastError(null, 429).cls).toBe("temporary");
    expect(classifyBroadcastError("1", 503).cls).toBe("temporary");
    // We never reached Meta (refused connection): not sent, try again later.
    expect(classifyBroadcastError("ECONNREFUSED", 0).cls).toBe("temporary");
    // Anything not listed is that person's result, never retried.
    expect(classifyBroadcastError("999999", 400).cls).toBe("recipient");
    expect(classifyBroadcastError(null, 400).cls).toBe("recipient");
  });
  it("131042, 368, 131031, 132015, 132016, 190 stop with the right reason", () => {
    expect(classifyBroadcastError("131042")).toEqual({ cls: "stop", stopReason: "payment" });
    expect(classifyBroadcastError("368")).toEqual({ cls: "stop", stopReason: "account" });
    expect(classifyBroadcastError("131031")).toEqual({ cls: "stop", stopReason: "account" });
    expect(classifyBroadcastError("131064")).toEqual({ cls: "stop", stopReason: "account" });
    expect(classifyBroadcastError("131048")).toEqual({ cls: "stop", stopReason: "quality" });
    expect(classifyBroadcastError("132001")).toEqual({ cls: "stop", stopReason: "template" });
    expect(classifyBroadcastError("132015")).toEqual({ cls: "stop", stopReason: "template" });
    expect(classifyBroadcastError("132016")).toEqual({ cls: "stop", stopReason: "template" });
    for (const c of ["132000", "132012", "131008", "135000"]) expect(classifyBroadcastError(c)).toEqual({ cls: "stop", stopReason: "blanks" });
    for (const c of ["190", "10", "200", "299", "283"]) expect(classifyBroadcastError(c, 400)).toEqual({ cls: "stop", stopReason: "config" });
  });
});

describe("meta.ts changes for broadcasts", () => {
  const tpl = { type: "template" as const, name: "promo", language: "en" };
  it("buildSendPayload adds biz_opaque_callback_data only when given", () => {
    expect(buildSendPayload("2347005550001", tpl)).not.toHaveProperty("biz_opaque_callback_data");
    expect(buildSendPayload("2347005550001", tpl, "bc:11111111-1111-1111-1111-111111111111")).toMatchObject({
      biz_opaque_callback_data: "bc:11111111-1111-1111-1111-111111111111",
      to: "2347005550001",
      type: "template",
    });
  });
  it("buildTemplateComponents sends a header picture by id when id is set, by link otherwise", () => {
    expect(buildTemplateComponents({ ...tpl, headerMedia: { type: "image", id: "media-1" } })).toEqual([
      { type: "header", parameters: [{ type: "image", image: { id: "media-1" } }] },
    ]);
    expect(buildTemplateComponents({ ...tpl, headerMedia: { type: "image", link: "https://files.example/p.jpg" } })).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://files.example/p.jpg" } }] },
    ]);
  });
  it("sendMessage posts to marketing_messages only when asked", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ messages: [{ id: "wamid.T1" }] }), { status: 200 });
      }),
    );
    await sendMessage(cfg, "PN1", "2347005550001", tpl);
    await sendMessage(cfg, "PN1", "2347005550001", tpl, { endpoint: "marketing_messages" });
    await sendMessage(cfg, "PN1", "2347005550001", tpl, { callbackData: "bc:x" });
    expect(urls).toEqual([
      "https://graph.test/v23.0/PN1/messages",
      "https://graph.test/v23.0/PN1/marketing_messages",
      "https://graph.test/v23.0/PN1/messages",
    ]);
  });
  it("uploadWaMedia posts the file to {phone number id}/media and returns Meta's id, never the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id: "media-42" }), { status: 200 });
      }),
    );
    const id = await uploadWaMedia(cfg, "PN1", { bytes: new Uint8Array([1, 2, 3]), mime: "image/png", filename: "p.png" });
    expect(id).toBe("media-42");
    expect(calls[0]!.url).toBe("https://graph.test/v23.0/PN1/media");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect((calls[0]!.init.body as FormData).get("messaging_product")).toBe("whatsapp");
    expect(JSON.stringify(id)).not.toContain(cfg.token);
  });
  it("getMmStatus reads the onboarding status and is null on any error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ marketing_messages_onboarding_status: "ONBOARDED" }), { status: 200 })));
    expect(await getMmStatus(cfg, "WABA1")).toBe("ONBOARDED");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 100, message: "Unknown field" } }), { status: 400 })));
    expect(await getMmStatus(cfg, "WABA1")).toBeNull();
  });
});

describe("broadcastFingerprint", () => {
  const base = {
    templateId: "t1",
    components: [{ type: "BODY", text: "Hi {{1}}" }],
    blanks: { body: [{ from: "first_name" as const, fallback: "there" }] },
    headerMediaKey: null,
    phoneNumberId: "line1",
  };
  it("is the same for the same message, whatever the key order, and changes when anything that decides the message changes", () => {
    const a = broadcastFingerprint(base);
    expect(broadcastFingerprint({ ...base, blanks: { body: [{ fallback: "there", from: "first_name" as const }] } })).toBe(a);
    expect(broadcastFingerprint({ ...base, blanks: { body: [{ from: "first_name", fallback: "friend" }] } })).not.toBe(a);
    expect(broadcastFingerprint({ ...base, headerMediaKey: "inbox/outgoing/x.jpg" })).not.toBe(a);
    expect(broadcastFingerprint({ ...base, phoneNumberId: "line2" })).not.toBe(a);
    expect(broadcastFingerprint({ ...base, components: [{ type: "BODY", text: "Hello {{1}}" }] })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("safetyVerdict (R55)", () => {
  const ok: SafetyFacts = {
    enabled: true,
    lineQuality: "GREEN",
    lineStatus: "CONNECTED",
    template: { status: "APPROVED", qualityScore: "GREEN" },
    accountBlocked: null,
    lastResults: [],
    optedOut: 0,
    deliveredOrRead: 0,
    headerMediaKey: null,
    headerMediaUploadedAt: null,
    startedAt: new Date(NOW.getTime() - 3600_000),
  };
  const stopOf = (f: Partial<SafetyFacts>) => safetyVerdict({ ...ok, ...f }, NOW)?.stop ?? null;

  it("nothing stops a healthy broadcast", () => expect(stopOf({})).toBeNull());
  it("the switch going off", () => expect(stopOf({ enabled: false })).toBe("switched_off"));
  it("a RED quality rating, or a flagged or restricted number", () => {
    expect(stopOf({ lineQuality: "red" })).toBe("quality");
    expect(stopOf({ lineStatus: "FLAGGED" })).toBe("quality");
    expect(stopOf({ lineStatus: "RESTRICTED" })).toBe("quality");
  });
  it("a paused, removed or RED template", () => {
    expect(stopOf({ template: { status: "PAUSED", qualityScore: "GREEN" } })).toBe("template");
    expect(stopOf({ template: null })).toBe("template");
    expect(stopOf({ template: { status: "APPROVED", qualityScore: "RED" } })).toBe("template");
  });
  it("an account_update restriction", () => expect(stopOf({ accountBlocked: { event: "ACCOUNT_RESTRICTION", detail: null } })).toBe("account"));
  it("a failure rate of 30% over the last 50 stops it; 131026 and 131050 failures do not count; fewer than 20 results never stop it", () => {
    const sent = (n: number) => Array.from({ length: n }, () => ({ state: "sent", errorCode: null }));
    const failed = (n: number, code: string) => Array.from({ length: n }, () => ({ state: "failed", errorCode: code }));
    expect(stopOf({ lastResults: [...sent(35), ...failed(15, "131049")] })).toBe("failure_spike");
    expect(stopOf({ lastResults: [...sent(36), ...failed(14, "131049")] })).toBeNull();
    expect(stopOf({ lastResults: [...sent(20), ...failed(30, "131026")] })).toBeNull();
    expect(stopOf({ lastResults: [...sent(20), ...failed(30, "131050")] })).toBeNull();
    expect(stopOf({ lastResults: failed(19, "131049") })).toBeNull();
  });
  it("many people asking to stop", () => {
    expect(stopOf({ optedOut: 5, deliveredOrRead: 100 })).toBe("optout_spike");
    expect(stopOf({ optedOut: 4, deliveredOrRead: 10 })).toBeNull();
    expect(stopOf({ optedOut: 5, deliveredOrRead: 101 })).toBeNull();
  });
  it("a picture older than 25 days, and a broadcast running 14 days", () => {
    expect(stopOf({ headerMediaKey: "k", headerMediaUploadedAt: new Date(NOW.getTime() - 26 * 86_400_000) })).toBe("media_expired");
    expect(stopOf({ headerMediaKey: "k", headerMediaUploadedAt: new Date(NOW.getTime() - 24 * 86_400_000) })).toBeNull();
    expect(stopOf({ startedAt: new Date(NOW.getTime() - 15 * 86_400_000) })).toBe("too_long");
  });
});

describe("decideAudience (R47)", () => {
  let n = 0;
  const fact = (f: Partial<AudienceFacts>): AudienceFacts => ({
    customerId: `c${++n}`,
    name: "Ada Obi",
    phone: "07005550001",
    createdAt: new Date(NOW.getTime() - (1000 - n) * 60_000),
    waExternalId: null,
    consent: "granted",
    waUnreachable: false,
    lastOrderAt: null,
    ordersCount: 0,
    recentPromotion: false,
    heldBack: false,
    ...f,
  });
  const decide = (facts: AudienceFacts[], category = "MARKETING", settings = DEFAULT_BROADCAST_SETTINGS) =>
    decideAudience(facts, { category, settings, now: NOW }).map((r) => r.reason);

  it("each skip reason in turn, in the documented order", () => {
    expect(
      decide([
        fact({ phone: null }),
        fact({ phone: "07005550002", consent: "withdrawn", waUnreachable: true }),
        fact({ phone: "07005550003", waUnreachable: true, consent: null }),
        fact({ phone: "07005550004", consent: null }),
        fact({ phone: "07005550005" }),
        fact({ phone: "07005550005" }),
        fact({ phone: "07005550006", recentPromotion: true, heldBack: true }),
        fact({ phone: "07005550007", heldBack: true }),
        fact({ phone: "07005550008" }),
      ]),
    ).toEqual([
      "no_phone",
      "opted_out",
      "not_whatsapp",
      "no_consent",
      null,
      "duplicate_number",
      "recent",
      "held_back",
      null,
    ]);
  });
  it("the number goes to the WhatsApp identity first, then the phone", () => {
    const rows = decideAudience([fact({ phone: "07005550010", waExternalId: "2347005550099" })], { category: "MARKETING", settings: DEFAULT_BROADCAST_SETTINGS, now: NOW });
    expect(rows[0]!.toWa).toBe("2347005550099");
    const byPhone = decideAudience([fact({ phone: "0700 555 0011" })], { category: "MARKETING", settings: DEFAULT_BROADCAST_SETTINGS, now: NOW });
    expect(byPhone[0]!.toWa).toBe("2347005550011");
  });
  it("consent_only leaves out a customer with orders but no recorded consent; consent_or_recent_customer includes them", () => {
    const customer = () => fact({ phone: "07005550020", consent: null, ordersCount: 3, lastOrderAt: new Date(NOW.getTime() - 30 * 86_400_000) });
    expect(decide([customer()])).toEqual(["no_consent"]);
    expect(decide([customer()], "MARKETING", { ...DEFAULT_BROADCAST_SETTINGS, audience_rule: "consent_or_recent_customer" })).toEqual([null]);
    const old = fact({ phone: "07005550021", consent: null, ordersCount: 1, lastOrderAt: new Date(NOW.getTime() - 400 * 86_400_000) });
    expect(decide([old], "MARKETING", { ...DEFAULT_BROADCAST_SETTINGS, audience_rule: "consent_or_recent_customer" })).toEqual(["no_consent"]);
  });
  it("a utility template skips people who asked to stop but not people with no marketing consent; a stranger is left out", () => {
    expect(
      decide(
        [
          fact({ phone: "07005550030", consent: "withdrawn", ordersCount: 2 }),
          fact({ phone: "07005550031", consent: null, ordersCount: 2 }),
          fact({ phone: "07005550032", consent: null, waExternalId: "2347005550032" }),
          fact({ phone: "07005550033", consent: null }),
          fact({ phone: "07005550034", recentPromotion: true, ordersCount: 1 }),
        ],
        "UTILITY",
      ),
    ).toEqual(["opted_out", null, null, "no_consent", null]);
  });
  it("a number whose older owner asked to stop is not sent to under a newer record", () => {
    expect(decide([fact({ phone: "07005550040", consent: "withdrawn" }), fact({ phone: "07005550040" })])).toEqual(["opted_out", "duplicate_number"]);
  });
  it("a gap of 0 days turns the recent rule off", () => {
    expect(decide([fact({ phone: "07005550050", recentPromotion: true })], "MARKETING", { ...DEFAULT_BROADCAST_SETTINGS, min_days_between: 0 })).toEqual([null]);
  });
});
