import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  ADS_SETTINGS_DEFAULT,
  ADS_SETTINGS_KEY,
  adAccountLink,
  adActionLog,
  adCampaignCache,
  adDraft,
  adOrderAttribution,
  adRule,
  adTouch,
  appSetting,
  branch,
  createDbClient,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  outboxEvent,
  payment,
  saleOrder,
  type AdsSettingsValue,
  type DbClient,
} from "@ms/db";
import { resetAdsUsage } from "@ms/domain";
import { runAdAttribution, runAdGuard, runAdPurchaseReports, runAdSyncIfDue, runAdTouchScan } from "../src/jobs/ads.js";
import { format } from "../src/outbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");
const log = { info: () => {}, warn: () => {}, error: () => {} };
// An obvious fake; every request is answered by the stub below and none leaves the process.
const cfg = { token: "itest-token", graphVersion: "v23.0" };
const ACT = "act_1234500001";
const WABA = "100200300400500";
const DATASET = "900000000000001";

interface Call {
  method: string;
  edge: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

/**
 * THE RULE THIS FILE GUARDS (suite spec 12, rule 21; foundation C6):
 * code that runs without a person may PAUSE an advert and nothing else.
 * A write from a worker job is allowed only if it is
 *   - POST /<object id> with a body of exactly { "status": "PAUSED" }, or
 *   - the purchase report (POST /<WABA>/dataset, POST /<dataset>/events),
 *     which changes no advert and is behind its own owner switch.
 * Anything else (a create, a budget, ACTIVE, targeting, a delete) fails the test.
 */
function forbiddenWrites(calls: Call[]): Call[] {
  return calls.filter((c) => {
    if (c.method === "GET") return false;
    if (c.method !== "POST") return true;
    if (c.edge === `${WABA}/dataset` || c.edge === `${DATASET}/events`) return false;
    const isObject = /^\d+$/.test(c.edge);
    const body = c.body ?? {};
    const pauseOnly = Object.keys(body).length === 1 && body.status === "PAUSED";
    return !(isObject && pauseOnly);
  });
}

describe("ads jobs in the worker (suite spec 12)", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let lineId: string;
  let branchId: string;
  const realFetch = globalThis.fetch;
  let calls: Call[] = [];
  // The pretend ad account.
  let objects: Map<string, Record<string, unknown>>;
  let todaySpend = 0;
  let campaignInsights: Map<string, Record<string, unknown>>;
  let events: unknown[] = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!href.startsWith("https://graph.facebook.com/")) throw new Error(`no network in this test: ${href}`);
      const url = new URL(href);
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        edge: url.pathname.replace(/^\/v\d+\.\d+\//, ""),
        query: url.searchParams,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      calls.push(call);
      const list = (level: string) => [...objects.values()].filter((o) => o.level === level);
      if (call.method === "GET") {
        if (call.edge === ACT) return json({ id: ACT, account_id: "1234500001", name: "Test Ads", currency: "NGN", timezone_name: "Africa/Lagos", timezone_offset_hours_utc: 1, account_status: 1, min_daily_budget: 50000 });
        if (call.edge === `${ACT}/campaigns`) return json({ data: list("campaign") });
        if (call.edge === `${ACT}/adsets`) return json({ data: list("adset") });
        if (call.edge === `${ACT}/ads`) return json({ data: list("ad") });
        if (call.edge === `${ACT}/insights`) {
          if (call.query.get("date_preset") === "today") return json({ data: [{ spend: todaySpend.toFixed(2) }] });
          return json({ data: [] });
        }
        const [id, sub] = call.edge.split("/");
        if (sub === "insights") return json({ data: campaignInsights.has(id!) ? [campaignInsights.get(id!)] : [] });
        if (objects.has(id!)) return json(objects.get(id!));
        return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
      }
      if (call.method === "POST") {
        if (call.edge === `${WABA}/dataset`) return json({ id: DATASET });
        if (call.edge === `${DATASET}/events`) {
          events.push(call.body);
          return json({ events_received: 1 });
        }
        const o = objects.get(call.edge);
        if (o) {
          // The pretend account does whatever it is told, so a forbidden write would really "happen" here.
          Object.assign(o, call.body);
          return json({ success: true });
        }
        if (call.edge.startsWith(`${ACT}/`)) return json({ id: String(Date.now()) });
      }
      return json({ error: { message: "Unsupported request", code: 100 } }, 400);
    }) as typeof fetch;

    const [b] = await db.insert(branch).values({ name: "Ads Branch", code: "ADSW" }).returning();
    branchId = b!.id;
    const [line] = await db.insert(inboxPhoneNumber).values({ e164: "+2348035520001", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: "1098765400" }).returning();
    lineId = line!.id;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container.stop();
  });

  beforeEach(async () => {
    calls = [];
    events = [];
    objects = new Map();
    campaignInsights = new Map();
    todaySpend = 0;
    resetAdsUsage();
    await db.delete(adOrderAttribution);
    await db.delete(adTouch);
    await db.delete(inboxMessage);
    await db.delete(inboxConversation);
    await db.delete(saleOrder);
    await db.delete(adDraft);
    await db.delete(adRule);
    await db.delete(adCampaignCache);
    await db.delete(adAccountLink);
    await db.delete(outboxEvent);
    await db.delete(appSetting);
  });

  const setSettings = (patch: Partial<AdsSettingsValue>) =>
    db
      .insert(appSetting)
      .values({ key: ADS_SETTINGS_KEY, value: { ...ADS_SETTINGS_DEFAULT, ...patch } })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: { ...ADS_SETTINGS_DEFAULT, ...patch } } });
  const link = (over: Partial<typeof adAccountLink.$inferInsert> = {}) =>
    db.insert(adAccountLink).values({ adAccountId: ACT, name: "Test Ads", currency: "NGN", timezoneName: "Africa/Lagos", accountStatus: 1, budgetFactor: 100, ...over });

  /** A campaign with its ad set and ad, at the pretend Meta and in our cache. */
  async function advert(id: number, opts: { status: "ACTIVE" | "PAUSED"; suiteMade: boolean; name: string }) {
    const [c, s, a] = [String(id), String(id + 1), String(id + 2)];
    objects.set(c, { level: "campaign", id: c, name: opts.name, status: opts.status, effective_status: opts.status });
    objects.set(s, { level: "adset", id: s, name: opts.name, campaign_id: c, status: opts.status, daily_budget: "200000", end_time: new Date(Date.now() + 5 * 86400_000).toISOString(), targeting: { geo_locations: { countries: ["NG"] } } });
    objects.set(a, { level: "ad", id: a, name: opts.name, adset_id: s, campaign_id: c, status: opts.status });
    await db.insert(adCampaignCache).values([
      { adAccountId: ACT, level: "campaign", externalId: c, campaignExternalId: c, name: opts.name, status: opts.status, createdBySuite: opts.suiteMade },
      { adAccountId: ACT, level: "adset", externalId: s, parentExternalId: c, campaignExternalId: c, name: opts.name, status: opts.status, dailyBudgetUnits: 200000, createdBySuite: opts.suiteMade },
      { adAccountId: ACT, level: "ad", externalId: a, parentExternalId: s, campaignExternalId: c, name: opts.name, status: opts.status, createdBySuite: opts.suiteMade },
    ]);
    return { campaign: c, adset: s, ad: a };
  }

  /** A customer who tapped a WhatsApp advert an hour ago and has paid for an order since. */
  async function paidOrderFromAdvert() {
    const [cust] = await db.insert(customer).values({ name: "Ada Test", phone: `+23480355${Math.floor(10000 + Math.random() * 89999)}`, source: "whatsapp" }).returning();
    const [conv] = await db.insert(inboxConversation).values({ customerId: cust!.id, phoneNumberId: lineId }).returning();
    await db.insert(inboxMessage).values({
      conversationId: conv!.id,
      direction: "in",
      type: "text",
      body: "Hello",
      waMessageId: `wamid.test-${randomUUID()}`,
      status: "received",
      payload: { type: "text", referral: { source_id: "120000000000903", source_type: "ad", headline: "Fresh juice", ctwa_clid: "TESTCLIDbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002" } },
      createdAt: new Date(Date.now() - 3600_000),
    });
    const [o] = await db
      .insert(saleOrder)
      .values({ orderNumber: `ADW-${Date.now()}`, branchId, channel: "online", customerId: cust!.id, status: "paid", subtotalNgn: 9000, deliveryFeeNgn: 1000, totalNgn: 10000, paymentMethod: "transfer", paymentStatus: "paid", createdAtLocal: new Date(), idempotencyKey: randomUUID() })
      .returning();
    await db.insert(payment).values({ saleOrderId: o!.id, method: "transfer", amountNgn: 10000, status: "paid", paidAt: new Date() });
    return o!.id;
  }

  async function runEveryJob(now = new Date()) {
    await runAdTouchScan(db, log, now);
    await runAdAttribution(db, log, now);
    await runAdPurchaseReports(db, log, cfg, now);
    await runAdSyncIfDue(db, log, cfg, now);
    await runAdGuard(db, log, cfg, now);
  }

  it("with every switch at its default, no job sends anything to Meta but reads, and nothing is reported", async () => {
    await link();
    const running = await advert(700000, { status: "ACTIVE", suiteMade: true, name: "Running" });
    await db.insert(adRule).values({ name: "Too dear", metric: "cost_per_conversation", threshold: "1.00", currency: "NGN", lookbackDays: 1, minSpend: "0.00" });
    campaignInsights.set(running.campaign, { spend: "9000.00" });
    todaySpend = 999999;
    await paidOrderFromAdvert();
    await runEveryJob();
    // The chat and the order are still traced: that is our own data.
    expect(await db.select().from(adTouch)).toHaveLength(1);
    const [att] = await db.select().from(adOrderAttribution);
    expect(att).toMatchObject({ valueNgn: 9000, capiStatus: "none" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(events).toEqual([]);
    expect(objects.get(running.campaign)!.status).toBe("ACTIVE");
  });

  it("FAILS IF A WORKER JOB EVER ISSUES A NON-PAUSING WRITE: with every switch on, the only writes are pauses and the purchase report", async () => {
    await link();
    await setSettings({
      manage_enabled: true,
      rules_enabled: true,
      daily_cap: 5000,
      capi_enabled: true,
      capi_privacy_confirmed_by: "owner",
      capi_privacy_confirmed_at: new Date().toISOString(),
      refresh_requested_at: new Date().toISOString(),
    });
    const dear = await advert(710000, { status: "ACTIVE", suiteMade: true, name: "Dear advert" });
    const second = await advert(720000, { status: "ACTIVE", suiteMade: true, name: "Second advert" });
    // Switched off, with wonderful figures: nothing may turn it back on.
    const resting = await advert(730000, { status: "PAUSED", suiteMade: true, name: "Resting advert" });
    // Made in Meta Ads Manager: the suite never touches it by itself.
    const outside = await advert(740000, { status: "ACTIVE", suiteMade: false, name: "Made in Ads Manager" });
    campaignInsights.set(dear.campaign, { spend: "4000.00", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "1" }] });
    campaignInsights.set(second.campaign, { spend: "100.00", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "50" }] });
    campaignInsights.set(resting.campaign, { spend: "100.00", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "500" }] });
    await db.insert(adRule).values({ name: "Too dear", metric: "cost_per_conversation", threshold: "800.00", currency: "NGN", lookbackDays: 3, minSpend: "1000.00" });
    // Drafts in every unfinished state, confirmed: a job must never carry one on.
    const spec = { destination: "whatsapp", account_id: lineId, name: "Unfinished", headline: "h", primary_text: "t", description: null, image_key: `ads/images/2026/11/${randomUUID()}.jpg`, greeting: "g", prefilled_message: null, audience: { area: "nigeria", radius_km: null, age_min: 18, age_max: 65 }, daily_budget: 2000, start_at: new Date(Date.now() + 3600_000).toISOString(), end_at: new Date(Date.now() + 3 * 86400_000).toISOString(), special_category: false } as const;
    for (const status of ["draft", "failed", "needs_check", "creating"]) {
      await db.insert(adDraft).values({ spec, status, confirmedHash: "x".repeat(64), confirmedAt: new Date(), lockedAt: new Date(Date.now() - 3600_000) });
    }
    const orderId = await paidOrderFromAdvert();
    const statusBefore = new Map([...objects].map(([id, o]) => [id, { status: o.status, daily_budget: o.daily_budget, targeting: JSON.stringify(o.targeting ?? null) }]));

    // Rules first (spend under the cap), then the safety stop (spend over it), then everything again.
    todaySpend = 100;
    await runEveryJob();
    todaySpend = 6000;
    await runEveryJob(new Date(Date.now() + 2 * 3600_000));
    await runEveryJob(new Date(Date.now() + 4 * 3600_000));

    const writes = calls.filter((c) => c.method !== "GET");
    // The test is not vacuous: the rule fired, the safety stop fired, and the purchase was reported.
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes.filter((w) => w.edge === dear.campaign)).toHaveLength(1);
    expect(writes.filter((w) => w.edge === second.campaign)).toHaveLength(1);
    expect(events).toHaveLength(1);
    // The rule itself.
    expect(forbiddenWrites(calls)).toEqual([]);
    for (const w of writes.filter((x) => /^\d+$/.test(x.edge) && x.edge !== DATASET)) expect(w.body).toEqual({ status: "PAUSED" });
    expect(writes.some((w) => w.edge.startsWith("act_"))).toBe(false);
    expect(JSON.stringify(writes.map((w) => w.body))).not.toContain("ACTIVE");
    expect(JSON.stringify(writes.filter((w) => w.edge !== `${DATASET}/events`).map((w) => w.body))).not.toMatch(/budget|targeting|bid/);
    // At the pretend Meta: nothing was switched on, no budget or audience moved, nothing was created.
    expect(objects.size).toBe(statusBefore.size);
    for (const [id, o] of objects) {
      const was = statusBefore.get(id)!;
      expect(o.daily_budget).toBe(was.daily_budget);
      expect(JSON.stringify(o.targeting ?? null)).toBe(was.targeting);
      if (was.status === "PAUSED") expect(o.status).toBe("PAUSED");
    }
    expect(objects.get(dear.campaign)!.status).toBe("PAUSED");
    expect(objects.get(second.campaign)!.status).toBe("PAUSED");
    expect(objects.get(resting.campaign)!.status).toBe("PAUSED");
    expect(objects.get(outside.campaign)!.status).toBe("ACTIVE");
    // The drafts were left exactly as they were.
    expect((await db.select().from(adDraft)).map((d) => d.status).sort()).toEqual(["creating", "draft", "failed", "needs_check"]);
    // Every pause is in the log under the rule's or the safety stop's name, never a person's.
    const logged = (await db.select().from(adActionLog)).filter((r) => r.action === "pause" && r.phase === "requested");
    expect(logged.map((r) => r.actorKind).sort()).toEqual(["rule", "safety"]);
    expect(logged.every((r) => r.actorUserId === null)).toBe(true);
    // The purchase report carried only the amount, the time and the click code.
    expect(events[0]).toEqual({
      data: [
        {
          event_name: "Purchase",
          event_time: expect.any(Number),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: { whatsapp_business_account_id: WABA, ctwa_clid: "TESTCLIDbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002" },
          custom_data: { currency: "NGN", value: 9000 },
        },
      ],
    });
    expect((await db.select().from(adOrderAttribution).where(eq(adOrderAttribution.saleOrderId, orderId)))[0]!.capiStatus).toBe("sent");
    // The owner is told, in plain words.
    const alerts = await db.select().from(outboxEvent);
    expect(alerts.map((a) => a.eventType).sort()).toEqual(["ads.rule_fired", "ads.safety_stop"]);
    for (const a of alerts) {
      const text = format({ eventType: a.eventType, payload: a.payload }).text;
      expect(text).toContain("/ads");
      expect(text).not.toContain(a.eventType);
    }
  });

  it("the checker itself refuses every other kind of write", () => {
    const bad: Call[] = [
      { method: "POST", edge: "710000", query: new URLSearchParams(), body: { status: "ACTIVE" } },
      { method: "POST", edge: "710001", query: new URLSearchParams(), body: { daily_budget: 900000 } },
      { method: "POST", edge: "710001", query: new URLSearchParams(), body: { status: "PAUSED", daily_budget: 900000 } },
      { method: "POST", edge: "710001", query: new URLSearchParams(), body: { status: "PAUSED", targeting: {} } },
      { method: "POST", edge: `${ACT}/campaigns`, query: new URLSearchParams(), body: { status: "PAUSED", name: "x" } },
      { method: "POST", edge: `${ACT}/adsets`, query: new URLSearchParams(), body: { status: "PAUSED" } },
      { method: "POST", edge: `${ACT}/ads`, query: new URLSearchParams(), body: { status: "PAUSED" } },
      { method: "POST", edge: `${ACT}/adimages`, query: new URLSearchParams(), body: { bytes: "AAAA" } },
      { method: "DELETE", edge: "710000", query: new URLSearchParams(), body: null },
      { method: "POST", edge: "710000", query: new URLSearchParams(), body: null },
    ];
    expect(forbiddenWrites(bad)).toHaveLength(bad.length);
    const fine: Call[] = [
      { method: "GET", edge: `${ACT}/campaigns`, query: new URLSearchParams(), body: null },
      { method: "POST", edge: "710000", query: new URLSearchParams(), body: { status: "PAUSED" } },
      { method: "POST", edge: `${WABA}/dataset`, query: new URLSearchParams(), body: {} },
      { method: "POST", edge: `${DATASET}/events`, query: new URLSearchParams(), body: { data: [] } },
    ];
    expect(forbiddenWrites(fine)).toEqual([]);
  });

  it("the jobs file cannot reach the functions that create, turn on or re-budget an advert", () => {
    const src = [
      fs.readFileSync(path.resolve(__dirname, "../src/jobs/ads.ts"), "utf8"),
      fs.readFileSync(path.resolve(__dirname, "../src/inbox-loop.ts"), "utf8"),
    ];
    // Only the import lists and code matter, so drop the comments (which name these functions to forbid them).
    const code = src.map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
    for (const banned of ["createAdFromDraft", "turnOnAdvert", "changeDailyBudget", "turnOnPreview", "budgetPreview", "adsGraph", "pauseObject", "graph(", "graphRaw", "fetch("]) {
      expect(code, banned).not.toContain(banned);
    }
    expect(code).toContain("safetyBrake");
    expect(code).toContain("evaluateRules");
    // No other job file in the worker touches ads at all.
    const jobsDir = path.resolve(__dirname, "../src/jobs");
    for (const f of fs.readdirSync(jobsDir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts") && x !== "ads.ts")) {
      const other = fs.readFileSync(path.join(jobsDir, f), "utf8");
      for (const banned of ["createAdFromDraft", "turnOnAdvert", "changeDailyBudget", "ads-manage"]) expect(other, `${f}: ${banned}`).not.toContain(banned);
    }
  });

  it("the sync runs once a day from 7 am Lagos time, or when asked, and never twice within 10 minutes", async () => {
    await link();
    // 05:30 in Lagos: too early.
    expect(await runAdSyncIfDue(db, log, cfg, new Date("2026-11-20T04:30:00Z"))).toBeNull();
    expect(calls).toEqual([]);
    // 07:05 in Lagos.
    expect(await runAdSyncIfDue(db, log, cfg, new Date("2026-11-20T06:05:00Z"))).not.toBeNull();
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    // Later the same day: nothing.
    expect(await runAdSyncIfDue(db, log, cfg, new Date("2026-11-20T12:00:00Z"))).toBeNull();
    // Someone presses "Refresh figures" two minutes after a sync: it waits.
    const [l] = await db.select().from(adAccountLink);
    await setSettings({ last_sync_day: "2026-11-20", refresh_requested_at: new Date(l!.lastSyncedAt!.getTime() + 60_000).toISOString() });
    expect(await runAdSyncIfDue(db, log, cfg, new Date(l!.lastSyncedAt!.getTime() + 2 * 60_000))).toBeNull();
    expect(await runAdSyncIfDue(db, log, cfg, new Date(l!.lastSyncedAt!.getTime() + 11 * 60_000))).not.toBeNull();
    expect(calls.length).toBeGreaterThan(first);
    // With no ad account linked, or Meta not set up, the jobs do nothing.
    await db.update(adAccountLink).set({ isActive: false });
    calls = [];
    expect(await runAdSyncIfDue(db, log, cfg, new Date("2026-11-21T08:00:00Z"))).toBeNull();
    expect(await runAdGuard(db, log, cfg)).toBeNull();
    expect(await runAdGuard(db, log, null)).toBeNull();
    expect(await runAdPurchaseReports(db, log, null)).toBe(0);
    expect(calls).toEqual([]);
  });
});
