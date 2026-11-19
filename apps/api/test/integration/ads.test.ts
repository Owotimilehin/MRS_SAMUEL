import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { asc, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  adAccountLink,
  adActionLog,
  adCampaignCache,
  adDraft,
  adInsightDaily,
  adOrderAttribution,
  adRule,
  adTouch,
  adminUser,
  appSetting,
  auditLog,
  inboxConversation,
  inboxMessage,
  inboxUserNumberAccess,
  saleOrder,
  type AdsSettingsValue,
  type DbClient,
} from "@ms/db";
import { attributeOrders, patchAdsSettings, resetAdsUsage, scanAdTouches } from "@ms/domain";
import { authOwner, makeTestApp, seedUser } from "./helpers.js";
import { clearInboxViewerCache } from "../../src/routes/inbox.js";
import { adImageSource } from "../../src/routes/ads.js";
import {
  ACT,
  CLID,
  FAKE_TOKEN,
  FakeAds,
  exampleSpec,
  resetSeedState,
  seedAdMessage,
  seedConversation,
  seedCustomer,
  seedOrder,
  seedPage,
  seedWaLine,
} from "./ads-fake.js";

/**
 * /v1/ads (suite spec 12). Meta is the pretend account in ads-fake.ts: no test
 * reaches the real Graph API, and the token is an obvious fake.
 */
const fake = new FakeAds();
const DAY = 24 * 3600_000;

describe("/v1/ads", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;
  let owner: Record<string, string>;
  let admin: Record<string, string>;
  /** An admin the owner has given ads.manage. */
  let adsAdmin: Record<string, string>;
  let adsAdminId: string;
  let manager: Record<string, string>;
  /** Inbox access to a different line only, plus ads.view. */
  let agent: Record<string, string>;
  let lineId: string;
  let otherLineId: string;
  /** Every response body returned by the routes in this file, for the secrets check at the end. */
  const seenBodies: string[] = [];

  async function login(email: string): Promise<Record<string, string>> {
    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "userpassword123" }),
    });
    if (!res.ok) throw new Error(`login failed ${res.status}`);
    return { cookie: res.headers.get("set-cookie") ?? "" };
  }

  async function call(who: Record<string, string>, method: string, path: string, body?: unknown) {
    const res = await app.request(`/v1/ads${path}`, {
      method,
      headers: { ...who, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    seenBodies.push(text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies differ per route; each test asserts the shape it expects
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  beforeAll(async () => {
    const t = await makeTestApp();
    ({ app, db, container } = t);
    resetSeedState();
    process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    delete process.env.ADS_SHOP_LAT;
    delete process.env.ADS_SHOP_LNG;
    fake.install();
    lineId = await seedWaLine(db, "Main line");
    otherLineId = await seedWaLine(db, "Second line");
    await seedPage(db);
    await seedUser(db, { email: "admin@example.com", role: "admin" });
    adsAdminId = (await seedUser(db, { email: "adsadmin@example.com", role: "admin", granted: ["ads.manage"] })).id;
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    const a = await seedUser(db, { email: "agent@example.com", role: "manager", granted: ["ads.view"] });
    await db.insert(inboxUserNumberAccess).values({ userId: a.id, phoneNumberId: otherLineId });
    owner = await authOwner(app);
    admin = await login("admin@example.com");
    adsAdmin = await login("adsadmin@example.com");
    manager = await login("manager@example.com");
    agent = await login("agent@example.com");
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    fake.reset();
    resetAdsUsage();
    clearInboxViewerCache();
    await db.delete(adOrderAttribution);
    await db.delete(adTouch);
    await db.delete(inboxMessage);
    await db.delete(inboxConversation);
    await db.delete(saleOrder);
    await db.delete(adDraft);
    await db.delete(adRule);
    await db.delete(adCampaignCache);
    await db.delete(adInsightDaily);
    await db.delete(adAccountLink);
    await db.delete(appSetting);
    await db.delete(auditLog);
  });

  async function linked(over: Partial<typeof adAccountLink.$inferInsert> = {}) {
    const [row] = await db
      .insert(adAccountLink)
      .values({ adAccountId: ACT, name: "Test Ads", currency: "NGN", timezoneName: "Africa/Lagos", accountStatus: 1, budgetFactor: 100, minDailyBudgetUnits: 50000, ...over })
      .returning();
    return row!;
  }
  const settings = (patch: Partial<AdsSettingsValue>) => db.transaction((tx) => patchAdsSettings(tx, patch));
  const managing = (cap = 10000) => settings({ manage_enabled: true, daily_cap: cap });
  const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
  const logRows = () => db.select().from(adActionLog).orderBy(asc(adActionLog.at), asc(adActionLog.phase));
  const logSince = async (t: Date) => (await logRows()).filter((r) => r.at.getTime() >= t.getTime());
  const uploadToken = (userId: string, key: string) =>
    crypto.createHmac("sha256", process.env.JWT_SIGNING_KEY!).update(`ads-upload:${userId}:${key}`).digest("base64url");
  const ownerUserId = async () => (await db.select({ id: adminUser.id }).from(adminUser).where(eq(adminUser.email, "owner@example.com")))[0]!.id;

  /** A saved draft, made through the route as the owner. */
  async function draft(over: Parameters<typeof exampleSpec>[1] = {}, who = owner, userId?: string) {
    const spec = exampleSpec(lineId, over);
    const res = await call(who, "POST", "/drafts", { spec, image_token: uploadToken(userId ?? (await ownerUserId()), spec.image_key) });
    expect(res.status).toBe(201);
    return res.json.data as { id: string; status: string; spec: typeof spec };
  }
  /** A draft row with an advert already created at the pretend Meta, switched off. */
  async function created(over: Parameters<typeof exampleSpec>[1] = {}) {
    const d = await draft(over);
    const p = await call(owner, "POST", `/drafts/${d.id}/preview`);
    expect(p.status).toBe(200);
    // The picture comes from our own storage, which the tests do not have: stand in for it.
    const res = await withImage(() => call(owner, "POST", `/drafts/${d.id}/create`, { content_hash: p.json.data.content_hash, typed: p.json.data.confirm_text }));
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("created");
    return res.json.data as { id: string; campaign_external_id: string; adset_external_id: string; ad_external_id: string };
  }
  /** Run with the advert picture read from memory: the tests have no file storage. */
  async function withImage<T>(fn: () => Promise<T>): Promise<T> {
    const original = adImageSource.load;
    adImageSource.load = async () => new Uint8Array([1, 2, 3, 4]);
    try {
      return await fn();
    } finally {
      adImageSource.load = original;
    }
  }

  // ── Who may do what ────────────────────────────────────────────────────────

  it("403 without ads.view; Phase B routes 403 without ads.manage", async () => {
    await linked();
    await managing();
    for (const path of ["/status", "/overview", "/adverts", "/chats", "/log", "/export.csv"]) {
      expect((await call(manager, "GET", path)).status, path).toBe(403);
      expect((await call(admin, "GET", path)).status, path).toBe(200);
    }
    expect((await call(manager, "POST", "/refresh")).status).toBe(403);
    expect((await app.request("/v1/ads/status")).status).toBe(401);
    // An admin sees figures but has no ads.manage by default: every route that can change an advert refuses.
    const phaseB: [string, string, unknown?][] = [
      ["POST", "/uploads", { content_type: "image/jpeg", size_bytes: 1000 }],
      ["POST", "/drafts", { spec: exampleSpec(lineId) }],
      ["GET", "/drafts"],
      ["GET", "/drafts/00000000-0000-4000-8000-000000000001"],
      ["PATCH", "/drafts/00000000-0000-4000-8000-000000000001", { spec: exampleSpec(lineId) }],
      ["DELETE", "/drafts/00000000-0000-4000-8000-000000000001"],
      ["POST", "/drafts/00000000-0000-4000-8000-000000000001/preview"],
      ["POST", "/drafts/00000000-0000-4000-8000-000000000001/create", { content_hash: "x", typed: "1" }],
      ["POST", "/drafts/00000000-0000-4000-8000-000000000001/continue"],
      ["GET", "/adverts/120000000000001/turn-on-preview"],
      ["POST", "/adverts/120000000000001/turn-on", { typed: "1" }],
      ["POST", "/objects/campaign/120000000000001/pause"],
      ["POST", "/adsets/120000000000001/budget-preview", { daily_budget: 1000 }],
      ["POST", "/adsets/120000000000001/budget", { daily_budget: 1000, typed: "1000" }],
      ["GET", "/rules"],
      ["POST", "/rules", { name: "x", threshold: 1, lookback_days: 1, min_spend: 0, scope_campaign_external_id: null, is_active: true }],
      ["PATCH", "/rules/00000000-0000-4000-8000-000000000001", { is_active: false }],
      ["DELETE", "/rules/00000000-0000-4000-8000-000000000001"],
      ["POST", "/chats/00000000-0000-4000-8000-000000000001/block-reporting"],
      ["POST", "/chats/00000000-0000-4000-8000-000000000001/unblock-reporting"],
      ["GET", "/destinations"],
    ];
    for (const [method, path, body] of phaseB) {
      for (const who of [admin, manager]) {
        const res = await call(who, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect(fake.calls).toEqual([]);
  });

  it("admin with ads.manage granted still cannot change settings, link, or calibrate (owner only)", async () => {
    await linked({ budgetFactor: null });
    const tries: [string, string, unknown?][] = [
      ["GET", "/settings"],
      ["PUT", "/settings", { daily_cap: 999999 }],
      ["PUT", "/settings", { manage_enabled: true }],
      ["GET", "/accounts/available"],
      ["POST", "/accounts/link", { ad_account_id: ACT }],
      ["POST", "/accounts/unlink"],
      ["GET", "/calibration"],
      ["POST", "/calibration", { adset_external_id: "120000000000001", amount_in_ads_manager: 2000 }],
    ];
    for (const [method, path, body] of tries) {
      const res = await call(adsAdmin, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.error.message).toBe("Only the owner can change this");
    }
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(appSetting)).toEqual([]);
    expect((await db.select().from(adAccountLink))[0]!.budgetFactor).toBeNull();
  });

  it("the daily cap: only the owner changes it, and the change is audited and logged", async () => {
    await linked();
    const before = (await call(owner, "GET", "/settings")).json.data;
    expect(before).toMatchObject({ manage_enabled: false, daily_cap: 0, rules_enabled: false, capi_enabled: false });
    const t0 = new Date();
    for (const who of [admin, adsAdmin, manager]) expect((await call(who, "PUT", "/settings", { daily_cap: 50000 })).status).toBe(403);
    expect((await call(owner, "PUT", "/settings", { daily_cap: -1 })).status).toBe(400);
    expect((await call(owner, "PUT", "/settings", { daily_cap: 1500.5 })).status).toBe(400);
    const res = await call(owner, "PUT", "/settings", { daily_cap: 10000 });
    expect(res.status).toBe(200);
    expect(res.json.data.daily_cap).toBe(10000);
    const a = await audits("ads.settings_update");
    expect(a).toHaveLength(1);
    expect((a[0]!.beforeJson as { daily_cap: number }).daily_cap).toBe(0);
    expect((a[0]!.afterJson as { daily_cap: number }).daily_cap).toBe(10000);
    const rows = (await logSince(t0)).filter((r) => r.action === "settings_change");
    expect(rows.map((r) => r.phase)).toEqual(["requested", "result"]);
    expect(rows[0]!.summary).toBe("Changed the ads settings: daily cap ₦0 → ₦10,000.");
    expect(rows[0]!.actorKind).toBe("person");
  });

  it("the master switch is off by default and can only be turned on for a linked, checked, naira account", async () => {
    expect((await call(owner, "PUT", "/settings", { manage_enabled: true })).status).toBe(409);
    await linked({ budgetFactor: null });
    const notChecked = await call(owner, "PUT", "/settings", { manage_enabled: true });
    expect(notChecked.status).toBe(409);
    expect(notChecked.json.error.message).toBe("Link the ad account and check the budget unit first");
    await db.update(adAccountLink).set({ budgetFactor: 100, currency: "USD" });
    const dollars = await call(owner, "PUT", "/settings", { manage_enabled: true });
    expect(dollars.status).toBe(409);
    expect(dollars.json.error.message).toBe("The suite can only manage adverts for an ad account in naira.");
    await db.update(adAccountLink).set({ currency: "NGN" });
    expect((await call(owner, "PUT", "/settings", { manage_enabled: true })).json.data.manage_enabled).toBe(true);
  });

  // ── Linking ────────────────────────────────────────────────────────────────

  it("link: only an account Meta lists can be linked; a second link replaces the first", async () => {
    const empty = await call(owner, "GET", "/status");
    expect(empty.json.data.account).toBeNull();
    const available = await call(owner, "GET", "/accounts/available");
    expect(available.json.data.map((a: { id: string }) => a.id)).toEqual([ACT]);
    expect((await call(owner, "POST", "/accounts/link", { ad_account_id: "act_999" })).status).toBe(400);
    expect((await call(owner, "POST", "/accounts/link", { ad_account_id: "999" })).status).toBe(400);
    const first = await call(owner, "POST", "/accounts/link", { ad_account_id: ACT });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ ad_account_id: ACT, name: "Test Ads", currency: "NGN", budget_calibrated: false });
    expect(await audits("ads.account_link")).toHaveLength(1);
    // The owner had switched creation on for the first account…
    await db.update(adAccountLink).set({ budgetFactor: 100 });
    await managing();
    // …then links a different one.
    const second = { id: "act_7770002", account_id: "7770002", name: "Second Ads", currency: "NGN", timezone_name: "Africa/Lagos", timezone_offset_hours_utc: 1, account_status: 1 };
    fake.listed = [fake.account, second];
    expect((await call(owner, "POST", "/accounts/link", { ad_account_id: "act_7770002" })).status).toBe(200);
    const links = await db.select().from(adAccountLink).orderBy(asc(adAccountLink.linkedAt));
    expect(links.map((l) => [l.adAccountId, l.isActive])).toEqual([
      [ACT, false],
      ["act_7770002", true],
    ]);
    // A different purse: creating adverts goes back to off, and the new account's unit is unchecked.
    const status = (await call(owner, "GET", "/status")).json.data;
    expect(status.settings.manage_enabled).toBe(false);
    expect(status.account).toMatchObject({ ad_account_id: "act_7770002", budget_calibrated: false });
    // Linking only reads.
    expect(fake.writes()).toEqual([]);
    expect((await call(owner, "POST", "/accounts/unlink")).status).toBe(200);
    expect((await call(owner, "GET", "/status")).json.data.account).toBeNull();
    // A Meta refusal is said in plain words.
    fake.override = () => fake.refuse(190, "Invalid OAuth access token", 401);
    const refused = await call(owner, "GET", "/accounts/available");
    expect(refused.status).toBe(502);
    expect(refused.json.error.message).toContain("We could not ask Meta for your ad accounts: Meta would not let the suite see them");
  });

  it("refresh: asks for a sync, at most every 10 minutes", async () => {
    expect((await call(admin, "POST", "/refresh")).status).toBe(404);
    await linked();
    expect((await call(admin, "POST", "/refresh")).status).toBe(200);
    const again = await call(admin, "POST", "/refresh");
    expect(again.status).toBe(429);
    expect(again.json.error.message).toBe("Figures were refreshed a few minutes ago. Try again shortly.");
    expect(fake.calls).toEqual([]);
  });

  // ── Figures ────────────────────────────────────────────────────────────────

  it("overview: totals, null for missing days, orders by Lagos day", async () => {
    await linked();
    await db.insert(adInsightDaily).values([
      { adAccountId: ACT, level: "account", externalId: ACT, day: "2026-11-10", dayZone: "Africa/Lagos", currency: "NGN", spend: "4000.00", impressions: 900, clicks: 40, conversationsStarted: 5 },
      { adAccountId: ACT, level: "account", externalId: ACT, day: "2026-11-12", dayZone: "Africa/Lagos", currency: "NGN", spend: "6000.00", impressions: 1100, clicks: 60, conversationsStarted: 5 },
    ]);
    const cust = await seedCustomer(db);
    const conv = await seedConversation(db, cust, lineId);
    // 23:30 UTC on the 10th is 00:30 on the 11th in Lagos.
    const orderAt = new Date("2026-11-10T23:30:00Z");
    await seedAdMessage(db, conv, { at: new Date(orderAt.getTime() - DAY) });
    await scanAdTouches(db, new Date(orderAt.getTime() - DAY + 60_000));
    await seedOrder(db, cust, { at: orderAt, subtotal: 12500, delivery: 1500 });
    const cancelled = await seedOrder(db, cust, { at: orderAt, subtotal: 9000 });
    await attributeOrders(db, 28, new Date(orderAt.getTime() + DAY));
    expect(await db.select().from(adOrderAttribution)).toHaveLength(2);
    const res = await call(admin, "GET", "/overview?from=2026-11-10&to=2026-11-12");
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.currency).toBe("NGN");
    expect(d.day_zone).toBe("Africa/Lagos");
    expect(d.totals).toMatchObject({ spend: 10000, impressions: 2000, clicks: 100, conversations_started: 10, cost_per_conversation: 1000, orders: 2, order_value_ngn: 21500, cost_per_order: 5000 });
    // A missing day is a gap, not a zero.
    expect(d.per_day).toEqual([
      { day: "2026-11-10", spend: 4000, impressions: 900, clicks: 40, conversations_started: 5 },
      { day: "2026-11-11", spend: null, impressions: null, clicks: null, conversations_started: null },
      { day: "2026-11-12", spend: 6000, impressions: 1100, clicks: 60, conversations_started: 5 },
    ]);
    expect(d.orders_per_day).toEqual([{ day: "2026-11-11", orders: 2, value_ngn: 21500 }]);
    // Cancelling an order removes it from the figures without touching its row.
    await db.update(saleOrder).set({ status: "cancelled" }).where(eq(saleOrder.id, cancelled.id));
    const after = (await call(admin, "GET", "/overview?from=2026-11-10&to=2026-11-12")).json.data;
    expect(after.totals).toMatchObject({ orders: 1, order_value_ngn: 12500, cost_per_order: 10000 });
    expect(await db.select().from(adOrderAttribution)).toHaveLength(2);
    // A dollar account never gets a cost per order (we do not convert).
    await db.update(adAccountLink).set({ currency: "USD" });
    expect((await call(admin, "GET", "/overview?from=2026-11-10&to=2026-11-12")).json.data.totals.cost_per_order).toBeNull();
    expect((await call(admin, "GET", "/overview?from=2026-11-12&to=2026-11-10")).status).toBe(400);
    expect((await call(admin, "GET", "/overview?from=2024-01-01&to=2026-11-10")).status).toBe(400);
    expect((await call(admin, "GET", "/overview?from=yesterday&to=2026-11-10")).status).toBe(400);
  });

  it("adverts, one advert, and the spreadsheet", async () => {
    await linked();
    await db.insert(adCampaignCache).values([
      { adAccountId: ACT, level: "campaign", externalId: "5001", campaignExternalId: "5001", name: "Camp A", status: "ACTIVE", effectiveStatus: "ACTIVE" },
      { adAccountId: ACT, level: "adset", externalId: "5002", parentExternalId: "5001", campaignExternalId: "5001", name: "Set A", destinationType: "WHATSAPP", dailyBudgetUnits: 200000, endTime: new Date("2026-12-01T08:00:00Z") },
      { adAccountId: ACT, level: "ad", externalId: "5003", parentExternalId: "5002", campaignExternalId: "5001", name: "Ad A", status: "ACTIVE", effectiveStatus: "ACTIVE", creative: { title: "Fresh juice", body: "Cold today" } },
      { adAccountId: ACT, level: "ad", externalId: "5004", parentExternalId: "5002", campaignExternalId: "5001", name: "Ad with nothing", status: "PAUSED", effectiveStatus: "PAUSED" },
    ]);
    await db.insert(adInsightDaily).values({ adAccountId: ACT, level: "ad", externalId: "5003", day: "2026-11-10", dayZone: "Africa/Lagos", currency: "NGN", spend: "4000.00", impressions: 900, clicks: 40, conversationsStarted: 5 });
    const cust = await seedCustomer(db);
    const conv = await seedConversation(db, cust, lineId);
    const at = new Date("2026-11-10T10:00:00Z");
    await seedAdMessage(db, conv, { at, adId: "5003" });
    await scanAdTouches(db, new Date(at.getTime() + 60_000));
    await seedOrder(db, cust, { at: new Date(at.getTime() + 3600_000), subtotal: 12500 });
    await attributeOrders(db, 7, new Date(at.getTime() + DAY));
    const list = await call(admin, "GET", "/adverts?from=2026-11-01&to=2026-11-30");
    expect(list.json.data).toEqual([
      {
        ad_external_id: "5003",
        name: "Ad A",
        campaign_name: "Camp A",
        destination: "whatsapp",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        created_by_suite: false,
        spend: 4000,
        impressions: 900,
        clicks: 40,
        conversations_started: 5,
        cost_per_conversation: 800,
        chats_seen: 1,
        orders: 1,
        order_value_ngn: 12500,
      },
    ]);
    const one = await call(admin, "GET", "/adverts/5003?from=2026-11-09&to=2026-11-11");
    expect(one.json.data).toMatchObject({ name: "Ad A", creative: { title: "Fresh juice", body: "Cold today" }, budget: { daily: 2000 }, campaign_external_id: "5001", adset_external_id: "5002" });
    expect(one.json.data.per_day.map((d: { spend: number | null }) => d.spend)).toEqual([null, 4000, null]);
    expect((await call(admin, "GET", "/adverts/999999")).status).toBe(404);
    const csv = await call(admin, "GET", "/export.csv?from=2026-11-01&to=2026-11-30");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const lines = csv.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe("day,day_time_zone,campaign,advert,destination,currency,spend,impressions,clicks,chats_started_meta,chats_seen_suite,orders,order_value_ngn");
    expect(lines[1]).toBe("2026-11-10,Africa/Lagos,Camp A,Ad A,whatsapp,NGN,4000.00,900,40,5,1,1,12500");
    expect(await audits("ads.export")).toHaveLength(1);
  });

  it("chats: hides the customer for a viewer who cannot see the conversation", async () => {
    await linked();
    const cust = await seedCustomer(db, "Ada Test");
    const conv = await seedConversation(db, cust, lineId);
    await seedAdMessage(db, conv, { adId: "5003" });
    await scanAdTouches(db);
    const order = await seedOrder(db, cust, { subtotal: 12500 });
    await attributeOrders(db, 7);
    const mine = await call(owner, "GET", "/chats");
    expect(mine.json.data).toHaveLength(1);
    expect(mine.json.data[0]).toMatchObject({
      channel: "whatsapp",
      ad_external_id: "5003",
      headline: "Fresh juice, delivered today",
      conversation_id: conv,
      customer_name: "Ada Test",
      order: { order_number: order.orderNumber, value_ngn: 12500, reported: "none" },
      reporting_blocked: false,
    });
    // The agent has ads.view but only works the second line: the row still counts, the customer is hidden.
    const theirs = await call(agent, "GET", "/chats");
    expect(theirs.status).toBe(200);
    expect(theirs.json.data).toHaveLength(1);
    expect(theirs.json.data[0]).toMatchObject({ conversation_id: null, customer_name: null, ad_external_id: "5003" });
    expect(theirs.text).not.toContain("Ada Test");
    // The click code is never returned to anyone.
    expect(mine.text).not.toContain(CLID);
    expect(mine.text).not.toContain("ctwa");
    expect((await call(owner, "GET", "/chats?ad=5003")).json.data).toHaveLength(1);
    expect((await call(owner, "GET", "/chats?ad=777")).json.data).toHaveLength(0);
  });

  it("conversation source: needs inbox.view and visibility, not ads.view", async () => {
    const cust = await seedCustomer(db);
    const conv = await seedConversation(db, cust, lineId);
    await seedAdMessage(db, conv, { adId: "5003", headline: "Zobo is back" });
    await scanAdTouches(db);
    const plain = await seedConversation(db, await seedCustomer(db), lineId);
    // A manager has inbox.view (their own lines) but no ads.view. Give this one the main line.
    const m = (await db.select({ id: adminUser.id }).from(adminUser).where(eq(adminUser.email, "manager@example.com")))[0]!;
    await db.insert(inboxUserNumberAccess).values({ userId: m.id, phoneNumberId: lineId }).onConflictDoNothing();
    await db.update(inboxConversation).set({ assigneeId: m.id }).where(eq(inboxConversation.id, conv));
    clearInboxViewerCache();
    const res = await call(manager, "GET", `/conversations/${conv}/source`);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ channel: "whatsapp", headline: "Zobo is back", ad_name: null });
    expect(res.text).not.toContain(CLID);
    // The agent has ads.view but cannot see this conversation: 404, as the inbox itself answers.
    expect((await call(agent, "GET", `/conversations/${conv}/source`)).status).toBe(404);
    // A conversation that did not come from an advert.
    expect((await call(owner, "GET", `/conversations/${plain}/source`)).json.data).toBeNull();
    expect((await call(owner, "GET", "/conversations/not-a-uuid/source")).status).toBe(404);
    await db.delete(inboxUserNumberAccess).where(eq(inboxUserNumberAccess.userId, m.id));
  });

  it("erase removes a customer's advert taps and click codes; merge carries them to the kept contact", async () => {
    const a = await seedCustomer(db, "Erase Me");
    const convA = await seedConversation(db, a, lineId);
    await seedAdMessage(db, convA);
    const b = await seedCustomer(db, "Merge From");
    const convB = await seedConversation(db, b, lineId);
    await seedAdMessage(db, convB, { adId: "8800" });
    const kept = await seedCustomer(db, "Kept Contact");
    await seedConversation(db, kept, lineId);
    await scanAdTouches(db);
    // A tap with no thread at all (a Messenger referral before the first message).
    await db.insert(adTouch).values({ sourceKey: "evt:test:0", channel: "messenger", customerId: a, sourceType: "ad", touchedAt: new Date() });
    const orderA = await seedOrder(db, a);
    await attributeOrders(db, 7);
    expect(await db.select().from(adTouch)).toHaveLength(3);
    const [custA] = (await db.execute(sql`select phone from customer where id = ${a}`)) as unknown as { phone: string }[];
    const erase = await app.request(`/v1/inbox/contacts/${a}/erase`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ confirm: custA!.phone }) });
    expect(erase.status).toBe(200);
    const left = await db.select().from(adTouch);
    expect(left.map((t) => t.customerId)).toEqual([b]);
    expect(await db.select().from(adOrderAttribution)).toHaveLength(0);
    // The shop's order itself is untouched.
    expect(await db.select().from(saleOrder).where(eq(saleOrder.id, orderA.id))).toHaveLength(1);
    // Merge b into kept: both have a live thread on the line, so b's thread is folded in and deleted.
    const merge = await app.request(`/v1/inbox/contacts/${b}/merge`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ into_customer_id: kept }) });
    expect(merge.status).toBe(200);
    const [moved] = await db.select().from(adTouch);
    expect(moved).toMatchObject({ customerId: kept, adExternalId: "8800" });
    expect(moved!.conversationId).not.toBe(convB);
    expect(moved!.conversationId).not.toBeNull();
    // An order the kept contact now places is still traced to the advert.
    await seedOrder(db, kept, { at: new Date(Date.now() + 1000) });
    expect(await attributeOrders(db, 7, new Date(Date.now() + 5000))).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  // ── Purchase reporting switch ──────────────────────────────────────────────

  it("settings: capi_enabled is refused without the privacy tick", async () => {
    expect((await call(owner, "GET", "/settings")).json.data.capi_enabled).toBe(false);
    const refused = await call(owner, "PUT", "/settings", { capi_enabled: true });
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toBe("Tick the privacy statement first");
    expect((await call(owner, "PUT", "/settings", { capi_enabled: true, capi_privacy_confirmed: false })).status).toBe(400);
    expect((await call(owner, "GET", "/settings")).json.data.capi_enabled).toBe(false);
    const ok = await call(owner, "PUT", "/settings", { capi_enabled: true, capi_privacy_confirmed: true });
    expect(ok.json.data).toMatchObject({ capi_enabled: true, capi_privacy_confirmed: true });
    const stored = (await db.select().from(appSetting))[0]!.value as AdsSettingsValue;
    expect(stored.capi_privacy_confirmed_by).toBe(await ownerUserId());
    expect(stored.capi_privacy_confirmed_at).not.toBeNull();
    // Un-ticking the statement also switches reporting off.
    const off = await call(owner, "PUT", "/settings", { capi_privacy_confirmed: false });
    expect(off.json.data).toMatchObject({ capi_enabled: false, capi_privacy_confirmed: false });
    expect((await call(owner, "PUT", "/settings", { attribution_window_days: 29 })).status).toBe(400);
    expect((await call(owner, "PUT", "/settings", { datasets: { x: "y" } })).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("do not report this customer: needs ads.manage, is audited, and can be undone", async () => {
    const cust = await seedCustomer(db);
    const conv = await seedConversation(db, cust, lineId);
    await seedAdMessage(db, conv);
    await scanAdTouches(db);
    const [t] = await db.select().from(adTouch);
    expect((await call(admin, "POST", `/chats/${t!.id}/block-reporting`)).status).toBe(403);
    expect((await call(owner, "POST", `/chats/${t!.id}/block-reporting`)).status).toBe(200);
    expect((await db.select().from(adTouch))[0]!.reportingBlockedAt).not.toBeNull();
    expect((await call(owner, "GET", "/chats")).json.data[0].reporting_blocked).toBe(true);
    expect((await call(owner, "POST", `/chats/${t!.id}/unblock-reporting`)).status).toBe(200);
    expect((await db.select().from(adTouch))[0]!.reportingBlockedAt).toBeNull();
    expect(await audits("ads.reporting_block")).toHaveLength(1);
    expect(await audits("ads.reporting_unblock")).toHaveLength(1);
  });

  // ── Phase B: creating an advert ────────────────────────────────────────────

  it("create: with manage_enabled off is 409 and calls nothing", async () => {
    await linked();
    // A draft and a finished advert left over from when the switch was on.
    await managing();
    const d = await draft();
    const done = await created();
    await settings({ manage_enabled: false, rules_enabled: true });
    fake.calls = [];
    const OFF = "Creating and changing adverts is switched off. The owner can turn it on in Ads → Settings.";
    const spec = exampleSpec(lineId);
    const tries: [string, string, unknown?][] = [
      ["POST", "/uploads", { content_type: "image/jpeg", size_bytes: 1000 }],
      ["POST", "/drafts", { spec, image_token: uploadToken(await ownerUserId(), spec.image_key) }],
      ["PATCH", `/drafts/${d.id}`, { spec: { ...d.spec, daily_budget: 9000 } }],
      ["POST", `/drafts/${d.id}/preview`],
      ["POST", `/drafts/${d.id}/create`, { content_hash: "anything", typed: "6000" }],
      ["POST", `/drafts/${done.id}/continue`],
      ["GET", `/adverts/${done.campaign_external_id}/turn-on-preview`],
      ["POST", `/adverts/${done.campaign_external_id}/turn-on`, { typed: "6000" }],
      ["POST", `/adsets/${done.adset_external_id}/budget-preview`, { daily_budget: 3000 }],
      ["POST", `/adsets/${done.adset_external_id}/budget`, { daily_budget: 3000, typed: "9000" }],
      ["POST", "/rules", { name: "x", threshold: 1, lookback_days: 1, min_spend: 0, scope_campaign_external_id: null, is_active: true }],
      ["PATCH", "/rules/00000000-0000-4000-8000-000000000001", { is_active: true }],
      ["GET", "/drafts"],
      ["GET", `/drafts/${d.id}`],
      ["DELETE", `/drafts/${d.id}`],
    ];
    for (const [method, path, body] of tries) {
      const res = await call(owner, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.json.error.message, `${method} ${path}`).toBe(OFF);
      expect(res.json.error.details.reason).toBe("off");
    }
    // Not one request reached Meta: not a write, not even a read.
    expect(fake.calls).toEqual([]);
    for (const o of [...fake.campaigns.values(), ...fake.adsets.values(), ...fake.ads.values()]) expect(o.status).toBe("PAUSED");
    expect((await db.select().from(adDraft).where(eq(adDraft.id, d.id)))[0]!.spec.daily_budget).toBe(2000);
  });

  it("create: wrong typed total is 400; stale hash is 409; over cap is 409 and logs blocked", async () => {
    await linked();
    await managing(5000);
    const d = await draft();
    const p = (await call(owner, "POST", `/drafts/${d.id}/preview`)).json.data;
    // ₦2,000 a day for 3 days (2 days and 1 hour counts as 3).
    expect(p.max_spend).toBe(6000);
    expect(p.confirm_text).toBe("6000");
    expect(p.lines[4]).toBe("**The most this advert can spend: ₦6,000.**");
    expect(p.lines[6]).toBe("It will be created **switched off**. Nothing is spent until you turn it on.");
    expect(p.cap).toEqual({ ok: true, cap: 5000, already_committed: 0, requested: 2000, room: 5000 });
    expect(p.min_daily).toBe(500);
    fake.calls = [];
    // The wrong total, a total the browser made up, and no total.
    for (const typed of ["6001", "1", "", "six thousand"]) {
      const res = await call(owner, "POST", `/drafts/${d.id}/create`, { content_hash: p.content_hash, typed });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toBe("Type the total exactly as shown to confirm.");
    }
    expect(fake.calls).toEqual([]);
    // The server works the total out itself: figures sent by the browser change nothing.
    const lying = await call(owner, "POST", `/drafts/${d.id}/create`, { content_hash: p.content_hash, typed: "1", max_spend: 1, confirm_text: "1", daily_budget: 1 });
    expect(lying.status).toBe(400);
    // The draft changed after the summary was shown.
    const edited = await call(owner, "PATCH", `/drafts/${d.id}`, { spec: { ...d.spec, daily_budget: 2500 } });
    expect(edited.status).toBe(200);
    const stale = await call(owner, "POST", `/drafts/${d.id}/create`, { content_hash: p.content_hash, typed: "6000" });
    expect(stale.status).toBe(409);
    expect(stale.json.error.message).toBe("This advert changed while you were looking at it. Check it again.");
    // Over the owner's cap.
    await call(owner, "PATCH", `/drafts/${d.id}`, { spec: { ...d.spec, daily_budget: 6000 } });
    const p2 = (await call(owner, "POST", `/drafts/${d.id}/preview`)).json.data;
    expect(p2.cap.ok).toBe(false);
    fake.calls = [];
    const t0 = new Date();
    const over = await call(owner, "POST", `/drafts/${d.id}/create`, { content_hash: p2.content_hash, typed: p2.confirm_text });
    expect(over.status).toBe(409);
    expect(over.json.error.message).toBe("This would take live daily budgets to ₦6,000, over your cap of ₦5,000. Lower the amount, pause another advert, or ask the owner to raise the cap.");
    expect(over.json.error.details).toMatchObject({ reason: "over_cap", cap: 5000, already_committed: 0, requested: 6000 });
    expect(fake.calls).toEqual([]);
    const rows = (await logSince(t0)).filter((r) => r.action === "create_advert");
    expect(rows.map((r) => r.outcome)).toEqual([null, "blocked"]);
    // Under Meta's minimum.
    await call(owner, "PATCH", `/drafts/${d.id}`, { spec: { ...d.spec, daily_budget: 300 } });
    const p3 = (await call(owner, "POST", `/drafts/${d.id}/preview`)).json.data;
    fake.calls = [];
    const small = await call(owner, "POST", `/drafts/${d.id}/create`, { content_hash: p3.content_hash, typed: p3.confirm_text });
    expect(small.status).toBe(400);
    expect(small.json.error.message).toBe("Meta's minimum for this account is ₦500 a day.");
    // None of these refusals sent anything to Meta, and nothing was created.
    expect(fake.calls).toEqual([]);
    expect(fake.campaigns.size).toBe(0);
    expect((await db.select().from(adDraft))[0]!.status).toBe("draft");
  });

  it("create: everything is made switched off; turning on is a separate, typed, capped action; pausing always works", async () => {
    await linked();
    await managing(5000);
    const t0 = new Date();
    const done = await created();
    // Created: one campaign, ad set and ad, all PAUSED, and no body ever said ACTIVE.
    expect(fake.adWrites().map((w) => w.edge)).toEqual([`${ACT}/adimages`, `${ACT}/campaigns`, `${ACT}/adsets`, `${ACT}/adcreatives`, `${ACT}/ads`]);
    for (const w of fake.adWrites()) expect(JSON.stringify(w.body)).not.toContain("ACTIVE");
    for (const o of [...fake.campaigns.values(), ...fake.adsets.values(), ...fake.ads.values()]) expect(o.status).toBe("PAUSED");
    expect(fake.adsets.get(done.adset_external_id)!.daily_budget).toBe("200000");
    const audit = await audits("ads.advert_create");
    expect(audit).toHaveLength(1);
    expect((audit[0]!.afterJson as { max_spend: number; lines: string[] }).max_spend).toBe(6000);
    expect((audit[0]!.afterJson as { lines: string[] }).lines[4]).toBe("**The most this advert can spend: ₦6,000.**");
    // A draft that has been sent can no longer be edited or deleted.
    expect((await call(owner, "PATCH", `/drafts/${done.id}`, { spec: exampleSpec(lineId) })).status).toBe(409);
    expect((await call(owner, "DELETE", `/drafts/${done.id}`)).status).toBe(409);
    // A second "create" of the same draft does nothing.
    fake.calls = [];
    expect((await call(owner, "POST", `/drafts/${done.id}/create`, { content_hash: "x", typed: "6000" })).status).toBe(409);
    expect(fake.calls).toEqual([]);

    // Turn on: the dialog's figures come from the server.
    const preview = await call(owner, "GET", `/adverts/${done.campaign_external_id}/turn-on-preview`);
    expect(preview.json.data).toMatchObject({ daily: 2000, remaining_max: 6000, confirm_text: "6000", cap: { ok: true, cap: 5000, already_committed: 0, requested: 2000 } });
    fake.calls = [];
    const wrong = await call(owner, "POST", `/adverts/${done.campaign_external_id}/turn-on`, { typed: "2000" });
    expect(wrong.status).toBe(400);
    expect(fake.writes()).toEqual([]);
    const on = await call(owner, "POST", `/adverts/${done.campaign_external_id}/turn-on`, { typed: "6,000" });
    expect(on.status).toBe(200);
    expect(fake.adWrites().map((w) => [w.edge, w.body])).toEqual([
      [done.ad_external_id, { status: "ACTIVE" }],
      [done.adset_external_id, { status: "ACTIVE" }],
      [done.campaign_external_id, { status: "ACTIVE" }],
    ]);
    expect(await audits("ads.advert_turn_on")).toHaveLength(1);

    // A second advert at ₦4,000 a day cannot be turned on while the first runs: ₦6,000 is over the ₦5,000 cap.
    const second = await created({ daily_budget: 4000, name: "Second advert" });
    fake.calls = [];
    const blocked = await call(owner, "POST", `/adverts/${second.campaign_external_id}/turn-on`, { typed: "12000" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details).toMatchObject({ reason: "over_cap", cap: 5000, already_committed: 2000, requested: 4000 });
    expect(fake.writes()).toEqual([]);
    expect(fake.campaigns.get(second.campaign_external_id)!.status).toBe("PAUSED");

    // Pause the first, with the master switch off: pausing must always be possible.
    await settings({ manage_enabled: false });
    fake.calls = [];
    const pause = await call(owner, "POST", `/objects/campaign/${done.campaign_external_id}/pause`);
    expect(pause.status).toBe(200);
    expect(fake.adWrites().map((w) => [w.edge, w.body])).toEqual([[done.campaign_external_id, { status: "PAUSED" }]]);
    expect(fake.campaigns.get(done.campaign_external_id)!.status).toBe("PAUSED");
    expect(await audits("ads.pause")).toHaveLength(1);

    // Everything above is in the activity log, with the person's name, newest first.
    const logRes = await call(owner, "GET", "/log");
    const actions = logRes.json.data.map((l: { action: string; outcome: string }) => `${l.action}:${l.outcome}`);
    expect(actions.slice(0, 3)).toEqual(["pause:ok", "turn_on:blocked", "create_ad:ok"]);
    expect(actions).toContain("turn_on:ok");
    expect(actions).toContain("create_adset:ok");
    expect(logRes.json.data.every((l: { actor_kind: string }) => l.actor_kind === "person")).toBe(true);
    expect(logRes.json.data[0].actor_name).toBe("owner");
    expect(logRes.json.data[0].request).toBeDefined();
    // Someone with ads.view sees the log without the request bodies.
    const adminLog = await call(admin, "GET", "/log");
    expect(adminLog.json.data[0].summary).toContain("Paused");
    expect(adminLog.json.data[0].request).toBeUndefined();
    expect((await logSince(t0)).length).toBeGreaterThan(20);
  });

  it("pause works with manage_enabled off", async () => {
    await linked();
    // The switch has never been on, and this advert was made in Meta Ads Manager.
    const camp = fake.addCampaign({ status: "ACTIVE", name: "Made in Ads Manager" });
    const res = await call(owner, "POST", `/objects/campaign/${camp}/pause`);
    expect(res.status).toBe(200);
    expect(fake.adWrites().map((w) => [w.edge, w.body])).toEqual([[camp, { status: "PAUSED" }]]);
    // An admin given ads.manage may pause too; one without it may not.
    fake.campaigns.get(camp)!.status = "ACTIVE";
    expect((await call(adsAdmin, "POST", `/objects/campaign/${camp}/pause`)).status).toBe(200);
    expect((await call(admin, "POST", `/objects/campaign/${camp}/pause`)).status).toBe(403);
    // Something that is not in the linked account is not touched.
    fake.calls = [];
    expect((await call(owner, "POST", "/objects/campaign/99999999/pause")).status).toBe(404);
    expect((await call(owner, "POST", "/objects/account/99999999/pause")).status).toBe(400);
    expect(fake.writes()).toEqual([]);
    // With no ad account linked there is nothing to pause.
    await db.update(adAccountLink).set({ isActive: false });
    expect((await call(owner, "POST", `/objects/campaign/${camp}/pause`)).status).toBe(409);
  });

  it("a permission taken away after sign-in stops the next action, whatever the session says", async () => {
    await linked();
    await managing();
    const spec = exampleSpec(lineId);
    const made = await call(adsAdmin, "POST", "/drafts", { spec, image_token: uploadToken(adsAdminId, spec.image_key) });
    expect(made.status).toBe(201);
    const p = (await call(adsAdmin, "POST", `/drafts/${made.json.data.id}/preview`)).json.data;
    // The owner removes ads.manage; the admin's session cookie still carries it.
    await db.update(adminUser).set({ permissionOverrides: { granted: [], revoked: [] } }).where(eq(adminUser.id, adsAdminId));
    fake.calls = [];
    const res = await call(adsAdmin, "POST", `/drafts/${made.json.data.id}/create`, { content_hash: p.content_hash, typed: p.confirm_text });
    expect(res.status).toBe(403);
    expect(res.json.error.message).toBe("You do not have permission to manage adverts.");
    const camp = fake.addCampaign({ status: "ACTIVE" });
    expect((await call(adsAdmin, "POST", `/objects/campaign/${camp}/pause`)).status).toBe(403);
    expect(fake.writes()).toEqual([]);
    await db.update(adminUser).set({ permissionOverrides: { granted: ["ads.manage"], revoked: [] } }).where(eq(adminUser.id, adsAdminId));
  });

  it("drafts: special subjects, other destinations, pictures from elsewhere and bad dates are refused", async () => {
    await linked();
    await managing();
    const me = await ownerUserId();
    const good = exampleSpec(lineId);
    const post = (spec: unknown, token?: string) => call(owner, "POST", "/drafts", { spec, image_token: token ?? uploadToken(me, good.image_key) });
    for (const special of [true, "false", null, undefined, 0]) {
      const res = await post({ ...good, special_category: special });
      expect(res.status).toBe(422);
      expect(res.json.error.message).toBe("Create adverts on these subjects in Meta Ads Manager.");
    }
    for (const destination of ["messenger", "instagram"]) {
      const res = await post({ ...good, destination });
      expect(res.status).toBe(422);
      expect(res.json.error.message).toContain("only create adverts that open a WhatsApp chat");
    }
    expect((await post({ ...good, daily_budget: 2000.5 })).status).toBe(422);
    expect((await post({ ...good, lifetime_budget: 100000 })).status).toBe(422);
    expect((await post({ ...good, end_at: undefined })).status).toBe(422);
    expect((await post({ ...good, end_at: new Date(new Date(good.start_at).getTime() + 31 * DAY).toISOString() })).status).toBe(422);
    expect((await post({ ...good, audience: { ...good.audience, area: "near_shop", radius_km: 10 } })).status).toBe(422);
    expect((await post({ ...good, account_id: "00000000-0000-4000-8000-000000000009" })).status).toBe(422);
    // A picture key this person did not upload.
    expect((await post(good, "not-the-token")).status).toBe(422);
    expect((await post(good, uploadToken(adsAdminId, good.image_key))).status).toBe(422);
    expect(await db.select().from(adDraft)).toHaveLength(0);
    expect((await post(good)).status).toBe(201);
    const list = await call(owner, "GET", "/drafts");
    expect(list.json.data).toHaveLength(1);
    expect((await call(owner, "DELETE", `/drafts/${list.json.data[0].id}`)).status).toBe(200);
    expect(await db.select().from(adDraft)).toHaveLength(0);
    const dest = await call(owner, "GET", "/destinations");
    expect(dest.json.data.map((d: { destination: string }) => d.destination)).toEqual(["whatsapp"]);
    expect(dest.json.data[0].accounts.map((a: { label: string }) => a.label).sort()).toEqual(["Main line", "Second line"]);
    expect(fake.calls).toEqual([]);
  });

  it("budget change: typed total, cap and audit", async () => {
    await linked();
    await managing(5000);
    const done = await created();
    fake.calls = [];
    const preview = await call(owner, "POST", `/adsets/${done.adset_external_id}/budget-preview`, { daily_budget: 3000 });
    expect(preview.json.data).toMatchObject({ current_daily: 2000, new_daily: 3000, remaining_max: 9000, confirm_text: "9000", live: false });
    expect((await call(owner, "POST", `/adsets/${done.adset_external_id}/budget`, { daily_budget: 3000, typed: "6000" })).status).toBe(400);
    const over = await call(owner, "POST", `/adsets/${done.adset_external_id}/budget`, { daily_budget: 6000, typed: "18000" });
    expect(over.status).toBe(409);
    expect(over.json.error.details.reason).toBe("over_cap");
    expect(fake.writes()).toEqual([]);
    const ok = await call(owner, "POST", `/adsets/${done.adset_external_id}/budget`, { daily_budget: 3000, typed: "9000" });
    expect(ok.status).toBe(200);
    expect(fake.adWrites().map((w) => [w.edge, w.body])).toEqual([[done.adset_external_id, { daily_budget: 300000 }]]);
    const a = await audits("ads.budget_change");
    expect(a).toHaveLength(1);
    expect(a[0]!.beforeJson).toEqual({ daily_budget: 2000 });
    expect(a[0]!.afterJson).toEqual({ daily_budget: 3000 });
  });

  it("calibration: the owner checks the budget unit against a number they can see", async () => {
    await linked({ budgetFactor: null });
    const camp = fake.addCampaign({});
    const aset = fake.addAdset({ campaign_id: camp, name: "Unit check", daily_budget: "200000" });
    fake.addAdset({ campaign_id: camp, name: "No daily budget", lifetime_budget: "900000" });
    const list = await call(owner, "GET", "/calibration");
    expect(list.json.data.adsets).toEqual([{ external_id: aset, name: "Unit check", daily_budget_units: 200000 }]);
    const wrong = await call(owner, "POST", "/calibration", { adset_external_id: aset, amount_in_ads_manager: 20 });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.message).toBe("That does not match what Meta reports for this ad set. Check the amount in Meta Ads Manager and try again.");
    expect((await db.select().from(adAccountLink))[0]!.budgetFactor).toBeNull();
    const ok = await call(owner, "POST", "/calibration", { adset_external_id: aset, amount_in_ads_manager: 2000 });
    expect(ok.status).toBe(200);
    expect(ok.json.data.budget_factor).toBe(100);
    const [l] = await db.select().from(adAccountLink);
    expect(l).toMatchObject({ budgetFactor: 100, budgetFactorConfirmedBy: await ownerUserId() });
    expect(await audits("ads.calibrate")).toHaveLength(1);
    // A dollar account is not calibrated at all.
    await db.update(adAccountLink).set({ currency: "USD", budgetFactor: null });
    expect((await call(owner, "POST", "/calibration", { adset_external_id: aset, amount_in_ads_manager: 2000 })).status).toBe(409);
    // Checking the unit only reads.
    expect(fake.writes()).toEqual([]);
  });

  it("rules: made by someone with ads.manage, in the account's currency, and deleted for real", async () => {
    await linked();
    await managing();
    const body = { name: "Too dear", threshold: 800, lookback_days: 3, min_spend: 1000, scope_campaign_external_id: null, is_active: true };
    expect((await call(owner, "POST", "/rules", { ...body, lookback_days: 2 })).status).toBe(400);
    expect((await call(owner, "POST", "/rules", { ...body, threshold: 0 })).status).toBe(400);
    expect((await call(owner, "POST", "/rules", { ...body, action: "turn_on" })).status).toBe(400);
    const made = await call(adsAdmin, "POST", "/rules", body);
    expect(made.status).toBe(201);
    expect(made.json.data).toMatchObject({ name: "Too dear", metric: "cost_per_conversation", threshold: 800, currency: "NGN", lookback_days: 3, min_spend: 1000 });
    const list = await call(owner, "GET", "/rules");
    expect(list.json.data).toHaveLength(1);
    expect(list.json.rules_enabled).toBe(false);
    expect((await call(owner, "PATCH", `/rules/${made.json.data.id}`, { is_active: false })).json.data.is_active).toBe(false);
    expect((await call(owner, "DELETE", `/rules/${made.json.data.id}`)).status).toBe(200);
    expect(await db.select().from(adRule)).toHaveLength(0);
    expect((await audits("ads.rule_create")).length + (await audits("ads.rule_update")).length + (await audits("ads.rule_delete")).length).toBe(3);
    expect(fake.calls).toEqual([]);
  });

  // ── The log, and secrets ───────────────────────────────────────────────────

  it("ad_action_log: UPDATE and DELETE raise", async () => {
    await linked();
    await call(owner, "PUT", "/settings", { daily_cap: 1234 });
    const before = await logRows();
    expect(before.length).toBeGreaterThan(0);
    const id = before[0]!.id;
    const message = async (p: Promise<unknown>) => {
      try {
        await p;
        return "no error";
      } catch (e) {
        return String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message);
      }
    };
    expect(await message(db.update(adActionLog).set({ summary: "rewritten" }).where(eq(adActionLog.id, id)))).toContain("ad_action_log is append-only");
    expect(await message(db.update(adActionLog).set({ outcome: "ok" }))).toContain("ad_action_log is append-only");
    expect(await message(db.delete(adActionLog).where(eq(adActionLog.id, id)))).toContain("ad_action_log is append-only");
    expect(await message(db.delete(adActionLog))).toContain("ad_action_log is append-only");
    const after = await logRows();
    expect(after).toEqual(before);
    // Deleting the staff account that did it neither fails nor changes the log.
    const temp = await seedUser(db, { email: `temp-${Date.now()}@example.com`, role: "admin" });
    await db.execute(sql`insert into ad_action_log (request_id, phase, actor_kind, actor_user_id, actor_name, action, summary) values (gen_random_uuid(), 'requested', 'person', ${temp.id}, 'Temp', 'test', 'kept')`);
    await db.insert(adDraft).values({ spec: exampleSpec(lineId), createdBy: temp.id, confirmedBy: temp.id });
    await db.delete(adminUser).where(eq(adminUser.id, temp.id));
    const kept = (await logRows()).find((r) => r.summary === "kept")!;
    expect(kept).toMatchObject({ actorUserId: temp.id, actorName: "Temp" });
    expect((await db.select().from(adDraft))[0]).toMatchObject({ createdBy: null, confirmedBy: null });
  });

  it("no response or log row contains \"itest-token\" or a full ctwa_clid", async () => {
    // Make sure there is something to look at: a chat from an advert, and a Meta refusal that echoes what it was sent.
    await linked();
    await managing();
    const cust = await seedCustomer(db);
    const conv = await seedConversation(db, cust, lineId);
    await seedAdMessage(db, conv);
    await scanAdTouches(db);
    await call(owner, "GET", "/chats");
    await call(owner, "GET", `/conversations/${conv}/source`);
    fake.override = () => fake.refuse(100, "Invalid parameter");
    await call(owner, "GET", "/accounts/available");
    fake.override = null;
    await call(owner, "GET", "/log");
    await call(owner, "GET", "/export.csv");
    await call(owner, "GET", "/status");
    expect(seenBodies.length).toBeGreaterThan(5);
    for (const body of seenBodies) {
      expect(body).not.toContain(FAKE_TOKEN);
      expect(body).not.toContain(CLID);
    }
    const stored = JSON.stringify([await logRows(), await db.select().from(auditLog), await db.select().from(adDraft), await db.select().from(appSetting)]);
    expect(stored).not.toContain(FAKE_TOKEN);
    expect(stored).not.toContain(CLID);
    // The token only ever travelled in the Authorization header, never in an address.
    expect(fake.calls.every((c) => c.auth === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(fake.calls.every((c) => !c.path.includes(FAKE_TOKEN) && !c.query.toString().includes(FAKE_TOKEN))).toBe(true);
  });
});
