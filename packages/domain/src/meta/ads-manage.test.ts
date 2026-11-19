import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdDraftSpec } from "@ms/db";
import { BudgetUnitError, nameTag } from "@ms/shared";
import {
  AdWriteForbiddenError,
  assertWriteAllowed,
  buildAdBody,
  buildAdSummary,
  buildAdsetBody,
  buildCampaignBody,
  buildCreativeBody,
  calibrationFactor,
  draftFingerprint,
  lagosDateTime,
  type PauseActor,
} from "./ads-manage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");

const DRAFT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const tag = nameTag(DRAFT_ID);
const spec: AdDraftSpec = {
  destination: "whatsapp",
  account_id: "0b0e5f0a-0000-4000-8000-000000000001",
  name: "November juice",
  headline: "Fresh juice, delivered today",
  primary_text: "Cold-pressed in Lagos this morning.",
  description: null,
  image_key: "ads/images/2026/11/0b0e5f0a-0000-4000-8000-000000000002.jpg",
  greeting: "Hello! How can we help?",
  prefilled_message: null,
  audience: { area: "nigeria", radius_km: null, age_min: 18, age_max: 65 },
  daily_budget: 5000,
  // 9:00 am in Lagos (UTC+1)
  start_at: "2026-11-23T08:00:00.000Z",
  end_at: "2026-11-30T08:00:00.000Z",
  special_category: false,
};
const kobo = { currency: "NGN", budgetFactor: 100 };
const adsetCtx = { campaignId: "120001", pageId: "100000000000001", whatsappNumber: "+2348030000001", account: kobo, shop: null };
const creativeCtx = { pageId: "100000000000001", instagramAccountId: "17841400000000001", imageHash: "abc123hash" };

function everyBody(s: AdDraftSpec) {
  return [
    buildCampaignBody(s, tag),
    buildAdsetBody(s, adsetCtx, tag),
    buildCreativeBody(s, creativeCtx, tag),
    buildAdBody(s, { adsetId: "120002", creativeId: "120003" }, tag),
  ];
}

describe("build*Body", () => {
  it("no body contains \"ACTIVE\"; special_ad_categories is []", () => {
    for (const destination of ["whatsapp", "messenger", "instagram"] as const) {
      const bodies = everyBody({ ...spec, destination });
      for (const b of bodies) expect(JSON.stringify(b)).not.toContain("ACTIVE");
      expect(bodies[0]).toMatchObject({ status: "PAUSED", special_ad_categories: [], objective: "OUTCOME_ENGAGEMENT", buying_type: "AUCTION" });
      expect(bodies[1]!.status).toBe("PAUSED");
      expect(bodies[3]!.status).toBe("PAUSED");
    }
  });
  it("every name ends with the draft's tag", () => {
    for (const b of everyBody(spec)) expect(String(b.name).endsWith(" [ms-1a2b3c4d]")).toBe(true);
  });
  it("the ad set carries the budget in Meta's unit, an end date, and nothing that could widen spending", () => {
    const b = buildAdsetBody(spec, adsetCtx, tag);
    expect(b).toMatchObject({
      campaign_id: "120001",
      destination_type: "WHATSAPP",
      optimization_goal: "CONVERSATIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      daily_budget: 500000,
      start_time: "2026-11-23T08:00:00.000Z",
      end_time: "2026-11-30T08:00:00.000Z",
      promoted_object: { page_id: "100000000000001", whatsapp_phone_number: "2348030000001" },
      targeting: { geo_locations: { countries: ["NG"] }, age_min: 18, age_max: 65 },
    });
    expect(b).not.toHaveProperty("lifetime_budget");
    expect(b).not.toHaveProperty("bid_amount");
    expect(buildAdsetBody(spec, { ...adsetCtx, account: { currency: "NGN", budgetFactor: 1 } }, tag).daily_budget).toBe(5000);
  });
  it("the ad set refuses a dollar account or an unchecked unit instead of guessing", () => {
    expect(() => buildAdsetBody(spec, { ...adsetCtx, account: { currency: "USD", budgetFactor: 100 } }, tag)).toThrow(BudgetUnitError);
    expect(() => buildAdsetBody(spec, { ...adsetCtx, account: { currency: "NGN", budgetFactor: null } }, tag)).toThrow(BudgetUnitError);
  });
  it("people near the shop: a radius around the shop's position, or a refusal when the position is not set", () => {
    const near: AdDraftSpec = { ...spec, audience: { area: "near_shop", radius_km: 12, age_min: 21, age_max: 50 } };
    const b = buildAdsetBody(near, { ...adsetCtx, shop: { lat: 6.5, lng: 3.4 } }, tag);
    expect(b.targeting).toEqual({
      geo_locations: { custom_locations: [{ latitude: 6.5, longitude: 3.4, radius: 12, distance_unit: "kilometer" }] },
      age_min: 21,
      age_max: 50,
    });
    expect(() => buildAdsetBody(near, adsetCtx, tag)).toThrow(/shop's position/);
  });
});

describe("buildCreativeBody", () => {
  it("WhatsApp uses WHATSAPP_MESSAGE and the autofill welcome message", () => {
    const b = buildCreativeBody({ ...spec, prefilled_message: "I want to order" }, creativeCtx, tag) as {
      object_story_spec: { page_id: string; link_data: Record<string, unknown> };
      degrees_of_freedom_spec: unknown;
    };
    const link = b.object_story_spec.link_data;
    expect(b.object_story_spec.page_id).toBe("100000000000001");
    expect(link.link).toBe("https://api.whatsapp.com/send");
    expect(link.name).toBe("Fresh juice, delivered today");
    expect(link.message).toBe("Cold-pressed in Lagos this morning.");
    expect(link.image_hash).toBe("abc123hash");
    expect(link.call_to_action).toEqual({ type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } });
    expect(JSON.parse(String(link.page_welcome_message))).toEqual({
      type: "VISUAL_EDITOR",
      version: 2,
      landing_screen_type: "welcome_message",
      media_type: "text",
      text_format: {
        customer_action_type: "autofill_message",
        message: { autofill_message: { content: "I want to order" }, text: "Hello! How can we help?" },
      },
    });
    expect(b.degrees_of_freedom_spec).toEqual({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } });
    const plain = buildCreativeBody(spec, creativeCtx, tag) as { object_story_spec: { link_data: { page_welcome_message: string } } };
    expect(JSON.parse(plain.object_story_spec.link_data.page_welcome_message).text_format.message.autofill_message.content).toBe(
      "Hello! Can I get more info on this?",
    );
  });
  it("Messenger and Instagram bodies follow the spec (built, but not switched on until checked with Meta)", () => {
    const m = buildCreativeBody({ ...spec, destination: "messenger" }, creativeCtx, tag) as { object_story_spec: { link_data: Record<string, unknown> } };
    expect(m.object_story_spec.link_data.call_to_action).toEqual({ type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } });
    expect(m.object_story_spec.link_data.link).toBe("https://m.me/100000000000001");
    expect(m.object_story_spec.link_data.page_welcome_message).toBe("Hello! How can we help?");
    const i = buildCreativeBody({ ...spec, destination: "instagram" }, creativeCtx, tag) as { object_story_spec: Record<string, unknown> & { link_data: Record<string, unknown> } };
    expect(i.object_story_spec.instagram_actor_id).toBe("17841400000000001");
    expect(i.object_story_spec.link_data.call_to_action).toEqual({ type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } });
  });
});

describe("buildAdSummary", () => {
  it("lines and total for the example in 7.10", () => {
    const s = buildAdSummary(spec, { accountLabel: "Main line", adAccountName: "Mrs Samuel Ads", currency: "NGN", shopName: "Mrs Samuel" });
    expect(s.lines).toEqual([
      "This creates an advert on Facebook and Instagram that opens a WhatsApp chat with Mrs Samuel — Main line.",
      'Headline: "Fresh juice, delivered today". Main text: "Cold-pressed in Lagos this morning.".',
      "Shown to: people aged 18 to 65 in Nigeria.",
      "Budget: up to ₦5,000 a day, from Mon 23 Nov 2026 9:00 am to Mon 30 Nov 2026 9:00 am (7 days).",
      "**The most this advert can spend: ₦35,000.**",
      'Meta takes the money from the ad account "Mrs Samuel Ads" using the payment method saved there.',
      "It will be created **switched off**. Nothing is spent until you turn it on.",
      "You have confirmed it is not about jobs, housing, loans or financial services, politics, or gambling.",
    ]);
    expect(s.maxSpend).toBe(35000);
    expect(s.confirmText).toBe("35000");
  });
  it("a part day counts as a whole day in the total", () => {
    const s = buildAdSummary({ ...spec, daily_budget: 2000, end_at: "2026-11-24T09:00:00.000Z" }, { accountLabel: "Main line", adAccountName: "A", currency: "NGN", shopName: "Mrs Samuel" });
    expect(s.maxSpend).toBe(4000);
    expect(s.confirmText).toBe("4000");
  });
  it("lagosDateTime", () => {
    expect(lagosDateTime(new Date("2026-11-23T08:00:00Z"))).toBe("Mon 23 Nov 2026 9:00 am");
    expect(lagosDateTime(new Date("2026-11-23T20:05:00Z"))).toBe("Mon 23 Nov 2026 9:05 pm");
  });
});

describe("draftFingerprint", () => {
  it("is stable whatever order the keys arrive in, and changes when anything changes", () => {
    const shuffled = Object.fromEntries(Object.entries(spec).reverse()) as unknown as AdDraftSpec;
    expect(draftFingerprint(shuffled)).toBe(draftFingerprint(spec));
    expect(draftFingerprint(spec)).toMatch(/^[0-9a-f]{64}$/);
    expect(draftFingerprint({ ...spec, daily_budget: 5001 })).not.toBe(draftFingerprint(spec));
    expect(draftFingerprint({ ...spec, end_at: "2026-12-01T08:00:00.000Z" })).not.toBe(draftFingerprint(spec));
    expect(draftFingerprint({ ...spec, audience: { ...spec.audience, age_max: 64 } })).not.toBe(draftFingerprint(spec));
  });
});

describe("calibrationFactor", () => {
  it("accepts exactly 1 or exactly 100 and nothing else", () => {
    expect(calibrationFactor(2000, 2000)).toBe(1);
    expect(calibrationFactor(200000, 2000)).toBe(100);
    expect(calibrationFactor(200000, 20)).toBeNull();
    expect(calibrationFactor(2000, 20)).toBe(100);
    expect(calibrationFactor(2000, 2001)).toBeNull();
    expect(calibrationFactor(0, 0)).toBeNull();
    expect(calibrationFactor(2000, -2000)).toBeNull();
    expect(calibrationFactor(1999.5 as number, 1999.5)).toBeNull();
  });
});

describe("assertWriteAllowed: the hard rules every write to Meta passes", () => {
  const person: PauseActor = { kind: "person", userId: "u1", name: "Owner" };
  const rule: PauseActor = { kind: "rule", userId: null, name: "Too dear" };
  const safety: PauseActor = { kind: "safety", userId: null, name: "Safety stop" };
  const pause = { action: "pause" as const, externalId: "120001", path: "120001", body: { status: "PAUSED" } };

  it("a rule or the safety stop may pause an existing object", () => {
    expect(() => assertWriteAllowed({ actor: rule, ...pause })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: safety, ...pause })).not.toThrow();
  });
  it("a rule or the safety stop may do NOTHING else: no create, no turn on, no budget, no targeting", () => {
    const forbidden: Parameters<typeof assertWriteAllowed>[0][] = [];
    for (const actor of [rule, safety, { kind: "system", userId: null, name: "x" } as unknown as PauseActor]) {
      forbidden.push(
        { actor, action: "turn_on", externalId: "120001", path: "120001", body: { status: "ACTIVE" } },
        { actor, action: "pause", externalId: "120001", path: "120001", body: { status: "ACTIVE" } },
        { actor, action: "pause", externalId: "120001", path: "120001", body: { status: "PAUSED", daily_budget: 900000 } },
        { actor, action: "pause", externalId: "120001", path: "120001", body: { status: "PAUSED", targeting: {} } },
        { actor, action: "pause", externalId: "120001", path: "act_1/campaigns", body: { status: "PAUSED" } },
        { actor, action: "pause", externalId: null, path: "act_1/campaigns", body: { status: "PAUSED" } },
        { actor, action: "budget_change", externalId: "120002", path: "120002", body: { daily_budget: 900000 } },
        { actor, action: "create_campaign", externalId: null, path: "act_1/campaigns", body: buildCampaignBody(spec, tag) },
        { actor, action: "create_adset", externalId: null, path: "act_1/adsets", body: buildAdsetBody(spec, adsetCtx, tag) },
        { actor, action: "create_ad", externalId: null, path: "act_1/ads", body: buildAdBody(spec, { adsetId: "1", creativeId: "2" }, tag) },
        { actor, action: "upload_image", externalId: null, path: "act_1/adimages", body: { bytes: "AAAA" } },
      );
    }
    expect(forbidden).toHaveLength(33);
    for (const w of forbidden) expect(() => assertWriteAllowed(w)).toThrow(AdWriteForbiddenError);
  });
  it("a person's creates must be PAUSED and carry no ACTIVE, lifetime budget or bid cap", () => {
    expect(() => assertWriteAllowed({ actor: person, action: "create_campaign", externalId: null, path: "act_1/campaigns", body: buildCampaignBody(spec, tag) })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "create_adset", externalId: null, path: "act_1/adsets", body: buildAdsetBody(spec, adsetCtx, tag) })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "create_creative", externalId: null, path: "act_1/adcreatives", body: buildCreativeBody(spec, creativeCtx, tag) })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "create_ad", externalId: null, path: "act_1/ads", body: buildAdBody(spec, { adsetId: "1", creativeId: "2" }, tag) })).not.toThrow();
    const bad = [
      { ...buildCampaignBody(spec, tag), status: "ACTIVE" },
      { ...buildCampaignBody(spec, tag), status: undefined },
      { ...buildCampaignBody(spec, tag), daily_budget: 500000 },
      { ...buildAdsetBody(spec, adsetCtx, tag), lifetime_budget: 9000000 },
      { ...buildAdsetBody(spec, adsetCtx, tag), bid_amount: 100 },
      { ...buildAdBody(spec, { adsetId: "1", creativeId: "2" }, tag), status: "ACTIVE" },
    ];
    for (const body of bad) {
      const action = "campaign_id" in body ? "create_adset" : "adset_id" in body ? "create_ad" : "create_campaign";
      expect(() => assertWriteAllowed({ actor: person, action, externalId: null, path: "act_1/x", body })).toThrow(AdWriteForbiddenError);
    }
  });
  it("an advert whose name, headline or text is the word ACTIVE is allowed; a status of ACTIVE anywhere in a create is not (review F15 iv)", () => {
    // Words the owner typed are not status fields.
    const shouting: AdDraftSpec = { ...spec, name: "ACTIVE", headline: "ACTIVE", primary_text: "ACTIVE", description: "ACTIVE", greeting: "ACTIVE", prefilled_message: "ACTIVE" };
    const creative = buildCreativeBody(shouting, creativeCtx, tag);
    expect(JSON.stringify(creative)).toContain('"ACTIVE"');
    expect(() => assertWriteAllowed({ actor: person, action: "create_campaign", externalId: null, path: "act_1/campaigns", body: { ...buildCampaignBody(shouting, tag), name: "ACTIVE" } })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "create_adset", externalId: null, path: "act_1/adsets", body: { ...buildAdsetBody(shouting, adsetCtx, tag), name: "ACTIVE" } })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "create_creative", externalId: null, path: "act_1/adcreatives", body: creative })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "create_ad", externalId: null, path: "act_1/ads", body: { ...buildAdBody(shouting, { adsetId: "1", creativeId: "2" }, tag), name: "ACTIVE" } })).not.toThrow();

    // Any status field set to ACTIVE, at any depth, in a list, in any letter case, is still refused.
    const campaign = buildCampaignBody(spec, tag);
    const sneaky: [Parameters<typeof assertWriteAllowed>[0]["action"], Record<string, unknown>][] = [
      ["create_campaign", { ...campaign, status: "ACTIVE" }],
      ["create_campaign", { ...campaign, status: "active" }],
      ["create_campaign", { ...campaign, configured_status: "ACTIVE" }],
      ["create_campaign", { ...campaign, effective_status: "ACTIVE" }],
      ["create_campaign", { ...campaign, adsets: [{ name: "x", status: "ACTIVE" }] }],
      ["create_campaign", { ...campaign, anything: { deep: { adset_status: ["PAUSED", "ACTIVE"] } } }],
      ["create_creative", { ...buildCreativeBody(spec, creativeCtx, tag), status: "ACTIVE" }],
      ["create_creative", { ...buildCreativeBody(spec, creativeCtx, tag), object_story_spec: { link_data: { status: " Active " } } }],
      ["create_ad", { ...buildAdBody(spec, { adsetId: "1", creativeId: "2" }, tag), creative: { creative_id: "2", status: "ACTIVE" } }],
    ];
    for (const [action, body] of sneaky) {
      expect(() => assertWriteAllowed({ actor: person, action, externalId: null, path: "act_1/x", body }), JSON.stringify(body).slice(0, 80)).toThrow(AdWriteForbiddenError);
    }
  });
  it("turning on and a budget change each carry exactly one field", () => {
    expect(() => assertWriteAllowed({ actor: person, action: "turn_on", externalId: "9", path: "9", body: { status: "ACTIVE" } })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "turn_on", externalId: "9", path: "9", body: { status: "ACTIVE", daily_budget: 1 } })).toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "budget_change", externalId: "9", path: "9", body: { daily_budget: 200000 } })).not.toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "budget_change", externalId: "9", path: "9", body: { daily_budget: 200000, status: "ACTIVE" } })).toThrow();
    expect(() => assertWriteAllowed({ actor: person, action: "budget_change", externalId: "9", path: "9", body: { daily_budget: 12.5 } })).toThrow();
  });
});

// ── Source checks: structure that must not quietly change ───────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("the action log is append-only in the code as well as in the database", () => {
  const files = [
    ...sourceFiles(path.join(repo, "packages/domain/src")),
    ...sourceFiles(path.join(repo, "packages/db/src")),
    ...sourceFiles(path.join(repo, "apps/api/src")),
    ...sourceFiles(path.join(repo, "apps/worker/src")),
  ];
  it("looks at the real source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join("meta", "ads.ts")))).toBe(true);
  });
  it("no file updates or deletes ad_action_log rows", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (/\.(update|delete)\(\s*adActionLog\b/.test(src)) offenders.push(f);
      if (/(update|delete\s+from|truncate)\s+"?ad_action_log"?/i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
  it("only writeAdLog inserts into it", () => {
    const inserters = files.filter((f) => /\.insert\(\s*adActionLog\b/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(repo, f));
    expect(inserters).toEqual([path.join("packages", "domain", "src", "meta", "ads.ts")]);
  });
});

describe("one door for writes to Meta's ad objects", () => {
  const manage = fs.readFileSync(path.join(here, "ads-manage.ts"), "utf8");
  const read = fs.readFileSync(path.join(here, "ads.ts"), "utf8");
  it("ads-manage.ts sends a POST from exactly one place, metaWrite, which checks the rules first", () => {
    const posts = manage.match(/adsGraph(<[^>]*>)?\(\s*cfg,\s*"POST"/g) ?? [];
    expect(posts).toHaveLength(1);
    expect(manage).not.toMatch(/"DELETE"/);
    const body = manage.slice(manage.indexOf("async function metaWrite"));
    expect(body.indexOf("assertWriteAllowed(w)")).toBeGreaterThan(0);
    expect(body.indexOf("assertWriteAllowed(w)")).toBeLessThan(body.indexOf('phase: "requested"'));
    expect(body.indexOf('phase: "requested"')).toBeLessThan(body.indexOf('"POST", w.path'));
  });
  it("the Phase A file never sends anything but a GET", () => {
    expect(read.match(/adsGraph(<[^>]*>)?\(\s*cfg,\s*"(POST|DELETE)"/g)).toBeNull();
    expect(read).not.toMatch(/graph(<[^>]*>)?\(\s*cfg,\s*"(POST|DELETE)"/);
  });
  it("no route, job or screen calls the Graph API for ads except through @ms/domain", () => {
    const outside = [...sourceFiles(path.join(repo, "apps/api/src")), ...sourceFiles(path.join(repo, "apps/worker/src"))].filter((f) =>
      /[\\/]ads\.ts$/.test(f),
    );
    expect(outside.length).toBeGreaterThan(0);
    for (const f of outside) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/\badsGraph\(/);
      expect(src).not.toMatch(/\bgraph(Raw)?\(/);
      expect(src).not.toMatch(/graph\.facebook\.com/);
    }
  });
});
