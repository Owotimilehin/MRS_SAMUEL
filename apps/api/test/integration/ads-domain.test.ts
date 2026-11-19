import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  ADS_SETTINGS_DEFAULT,
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
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxWebhookEvent,
  outboxEvent,
  saleOrder,
  type AdsSettingsValue,
  type DbClient,
} from "@ms/db";
import {
  AdsManageError,
  assertCanManage,
  attributeOrders,
  changeDailyBudget,
  checkCap,
  createAdFromDraft,
  draftFingerprint,
  evaluateRules,
  getAdsSettings,
  patchAdsSettings,
  pauseObject,
  queuePurchaseReports,
  resetAdsUsage,
  safetyBrake,
  scanAdTouches,
  sendPurchaseReports,
  syncAdAccount,
  turnOnAdvert,
  type PersonActor,
} from "@ms/domain";
import { nameTag } from "@ms/shared";
import { seedOwner, seedUser, setupTestDb } from "./helpers.js";
import {
  ACT,
  CLID,
  FAKE_TOKEN,
  FakeAds,
  PAGE_ID,
  WABA,
  exampleSpec,
  noAnswer,
  resetSeedState,
  seedAdMessage,
  seedConversation,
  seedCustomer,
  seedOrder,
  seedPage,
  seedWaLine,
} from "./ads-fake.js";

/**
 * The ads rules that need a database (suite spec 12, section 9): sync, advert
 * taps, order attribution, purchase reports, the cap, creating an advert,
 * turning on, budgets, rules and the safety stop. Meta is the pretend account
 * in ads-fake.ts; nothing leaves the process.
 */
const cfg = { token: FAKE_TOKEN, graphVersion: "v23.0" };
const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 24 * 3600_000;
const fake = new FakeAds();

describe("ads: domain rules with a database", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let owner: PersonActor;
  let lineId: string;

  beforeAll(async () => {
    const t = await setupTestDb();
    ({ db, container } = t);
    resetSeedState();
    const o = await seedOwner(db);
    owner = { kind: "person", userId: o.id, name: "Owner" };
    fake.install();
    lineId = await seedWaLine(db);
    await seedPage(db);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    fake.reset();
    resetAdsUsage();
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
    await db.delete(outboxEvent);
    await db.delete(appSetting);
  });

  async function link(over: Partial<typeof adAccountLink.$inferInsert> = {}) {
    const [row] = await db
      .insert(adAccountLink)
      .values({ adAccountId: ACT, name: "Test Ads", currency: "NGN", timezoneName: "Africa/Lagos", accountStatus: 1, budgetFactor: 100, minDailyBudgetUnits: 50000, ...over })
      .returning();
    return row!;
  }
  const settings = (patch: Partial<AdsSettingsValue>) => db.transaction((tx) => patchAdsSettings(tx, patch));
  const managing = (cap = 10000) => settings({ manage_enabled: true, daily_cap: cap });
  const logRows = () => db.select().from(adActionLog).orderBy(asc(adActionLog.at), asc(adActionLog.phase));
  const logSince = async (t: Date) => (await logRows()).filter((r) => r.at.getTime() >= t.getTime());

  // ── Sync ───────────────────────────────────────────────────────────────────

  describe("syncAdAccount", () => {
    it("first run asks for 90 days, later runs for 8", async () => {
      await link();
      const now = new Date("2026-11-19T10:00:00Z");
      await syncAdAccount(db, cfg, log, now);
      const first = fake.calls.filter((c) => c.edge === `${ACT}/insights`).map((c) => JSON.parse(c.query.get("time_range")!));
      expect(first).toEqual([
        { since: "2026-08-22", until: "2026-11-19" },
        { since: "2026-08-22", until: "2026-11-19" },
      ]);
      fake.calls = [];
      await syncAdAccount(db, cfg, log, now);
      const second = fake.calls.filter((c) => c.edge === `${ACT}/insights`).map((c) => JSON.parse(c.query.get("time_range")!));
      expect(second[0]).toEqual({ since: "2026-11-12", until: "2026-11-19" });
      // A sync only ever reads.
      expect(fake.writes()).toEqual([]);
      const [l] = await db.select().from(adAccountLink);
      expect(l!.lastSyncedAt).not.toBeNull();
      expect(l!.backfilledAt).not.toBeNull();
      expect(l!.lastErrorCode).toBeNull();
    });

    it("upserts objects and never clears created_by_suite; figures are replaced; gone objects are marked", async () => {
      await link();
      const camp = fake.addCampaign({ name: "Camp A", status: "ACTIVE", effective_status: "ACTIVE" });
      const aset = fake.addAdset({ campaign_id: camp, daily_budget: "200000", end_time: "2026-12-01T08:00:00+0100" });
      const ad = fake.addAd({ adset_id: aset, campaign_id: camp, name: "Ad A", creative: { id: "1", title: "Fresh juice", body: "Cold today", image_url: "https://example.invalid/x.jpg" } });
      const gone = fake.addCampaign({ name: "Old one" });
      fake.insights.account = [{ date_start: "2026-11-18", account_currency: "NGN", spend: "4000.50", impressions: "900", clicks: "40", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "5" }] }];
      fake.insights.ad = [{ date_start: "2026-11-18", ad_id: ad, account_currency: "NGN", spend: "4000.50", impressions: "900", clicks: "40", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "5" }] }];
      await syncAdAccount(db, cfg, log);
      await db.update(adCampaignCache).set({ createdBySuite: true }).where(eq(adCampaignCache.externalId, camp));
      fake.campaigns.get(camp)!.name = "Camp A renamed";
      fake.campaigns.delete(gone);
      fake.insights.account[0]!.spend = "4100.00";
      await syncAdAccount(db, cfg, log);
      const cache = await db.select().from(adCampaignCache);
      const c = cache.find((r) => r.externalId === camp)!;
      expect(c.name).toBe("Camp A renamed");
      expect(c.createdBySuite).toBe(true);
      expect(cache.find((r) => r.externalId === gone)!.goneAt).not.toBeNull();
      expect(cache.find((r) => r.externalId === aset)).toMatchObject({ dailyBudgetUnits: 200000, parentExternalId: camp, destinationType: "WHATSAPP" });
      // Only the words of the advert are kept, never a picture link.
      expect(cache.find((r) => r.externalId === ad)!.creative).toEqual({ title: "Fresh juice", body: "Cold today" });
      const days = await db.select().from(adInsightDaily).where(eq(adInsightDaily.level, "account"));
      expect(days).toHaveLength(1);
      expect(days[0]).toMatchObject({ spend: "4100.00", conversationsStarted: 5, externalId: ACT, dayZone: "Africa/Lagos", currency: "NGN" });
    });

    it("stops at 80% usage and records busy", async () => {
      await link();
      fake.headers = { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 85 }) };
      await syncAdAccount(db, cfg, log);
      // The first call told us Meta is busy; nothing more was asked.
      expect(fake.calls).toHaveLength(1);
      const [l] = await db.select().from(adAccountLink);
      expect(l!.lastErrorCode).toBe("busy");
      expect(l!.lastErrorMessage).toBe("Meta asked us to slow down. The sync will continue on the next run.");
      expect(l!.lastSyncedAt).toBeNull();
    });

    it("code 190 records the problem and raises one alert per day", async () => {
      await link();
      fake.override = () => fake.refuse(190, "Invalid OAuth access token", 401);
      await syncAdAccount(db, cfg, log);
      await syncAdAccount(db, cfg, log);
      const [l] = await db.select().from(adAccountLink);
      expect(l!.lastErrorCode).toBe("190");
      expect(l!.lastErrorMessage).toContain("Meta would not let the suite read this ad account");
      const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "ads.config_error"));
      expect(alerts).toHaveLength(1);
      expect(JSON.stringify(alerts[0]!.payload)).not.toContain(FAKE_TOKEN);
    });

    it("does nothing with no ad account linked", async () => {
      expect(await syncAdAccount(db, cfg, log)).toEqual({ objects: 0, days: 0 });
      expect(fake.calls).toEqual([]);
    });
  });

  // ── Advert taps ────────────────────────────────────────────────────────────

  describe("scanAdTouches", () => {
    it("a WhatsApp message with a referral creates one touch; running twice creates one", async () => {
      const cust = await seedCustomer(db);
      const conv = await seedConversation(db, cust, lineId);
      const msg = await seedAdMessage(db, conv, { adId: "120000000000901" });
      expect(await scanAdTouches(db)).toBe(1);
      expect(await scanAdTouches(db)).toBe(0);
      const touches = await db.select().from(adTouch);
      expect(touches).toHaveLength(1);
      expect(touches[0]).toMatchObject({
        sourceKey: `msg:${msg}`,
        channel: "whatsapp",
        customerId: cust,
        conversationId: conv,
        sourceType: "ad",
        adExternalId: "120000000000901",
        postExternalId: null,
        headline: "Fresh juice, delivered today",
        ctwaClid: CLID,
        accountExternalId: WABA,
      });
      // No call to Meta is ever made to work this out.
      expect(fake.calls).toEqual([]);
    });

    it("a post referral keeps the post, and a Status advert has no click code", async () => {
      const cust = await seedCustomer(db);
      const conv = await seedConversation(db, cust, lineId);
      await seedAdMessage(db, conv, { adId: "555", sourceType: "post", clid: null });
      await scanAdTouches(db);
      const [t] = await db.select().from(adTouch);
      expect(t).toMatchObject({ sourceType: "post", adExternalId: null, postExternalId: "555", ctwaClid: null });
    });

    it("a Messenger event waits until the identity exists", async () => {
      const pageRow = (await db.execute(sql`select id from inbox_phone_number where kind = 'messenger' limit 1`)) as unknown as { id: string }[];
      const [ev] = await db
        .insert(inboxWebhookEvent)
        .values({
          source: "meta",
          // A label made from the first item only; the scan must not rely on it.
          kind: "page.message_reads",
          processedAt: new Date(),
          payload: {
            object: "page",
            entry: [
              {
                id: PAGE_ID,
                messaging: [
                  { sender: { id: "5550009" }, recipient: { id: PAGE_ID }, timestamp: Date.now() - 1000, read: { watermark: 1 } },
                  { sender: { id: "5550009" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), referral: { source: "ADS", type: "OPEN_THREAD", ad_id: "120000000000902", ads_context_data: { ad_title: "Zobo is back" } } },
                ],
              },
            ],
          },
        })
        .returning();
      expect(await scanAdTouches(db)).toBe(0);
      const cust = await seedCustomer(db, "Bola Test");
      await db.insert(inboxIdentity).values({ customerId: cust, channel: "messenger", accountExternalId: PAGE_ID, externalId: "5550009" });
      const conv = await seedConversation(db, cust, pageRow[0]!.id, "messenger");
      expect(await scanAdTouches(db)).toBe(1);
      expect(await scanAdTouches(db)).toBe(0);
      const [t] = await db.select().from(adTouch);
      expect(t).toMatchObject({
        sourceKey: `evt:${ev!.id}:1`,
        channel: "messenger",
        customerId: cust,
        conversationId: conv,
        adExternalId: "120000000000902",
        headline: "Zobo is back",
        senderExternalId: "5550009",
        ctwaClid: null,
      });
      await db.delete(inboxWebhookEvent).where(eq(inboxWebhookEvent.id, ev!.id));
    });
  });

  // ── Orders ─────────────────────────────────────────────────────────────────

  describe("attributeOrders", () => {
    const now = new Date();
    async function touched(daysAgo: number, adId = "120000000000901") {
      const cust = await seedCustomer(db);
      const conv = await seedConversation(db, cust, lineId);
      await seedAdMessage(db, conv, { at: new Date(now.getTime() - daysAgo * DAY), adId });
      await scanAdTouches(db, new Date(now.getTime() - daysAgo * DAY + 60_000));
      return { cust, conv };
    }

    it("paid order within 7 days of a touch is attributed, by the goods total without delivery", async () => {
      const { cust } = await touched(2);
      const order = await seedOrder(db, cust, { at: new Date(now.getTime() - DAY), subtotal: 12500, delivery: 1500 });
      expect(await attributeOrders(db, 7, now)).toBe(1);
      expect(await attributeOrders(db, 7, now)).toBe(0);
      const [a] = await db.select().from(adOrderAttribution);
      expect(a).toMatchObject({ saleOrderId: order.id, rule: "last_touch_7d", valueNgn: 12500, capiStatus: "none" });
    });

    it("order before the touch, or 8 days after, is not", async () => {
      const early = await touched(1);
      await seedOrder(db, early.cust, { at: new Date(now.getTime() - 2 * DAY) });
      const late = await touched(9);
      await seedOrder(db, late.cust, { at: new Date(now.getTime() - 0.5 * DAY) });
      expect(await attributeOrders(db, 7, now)).toBe(0);
      // With a 28-day window the second one counts.
      expect(await attributeOrders(db, 28, now)).toBe(1);
      const [a] = await db.select().from(adOrderAttribution);
      expect(a!.rule).toBe("last_touch_28d");
    });

    it("two touches — the later one wins", async () => {
      const cust = await seedCustomer(db);
      const conv = await seedConversation(db, cust, lineId);
      await seedAdMessage(db, conv, { at: new Date(now.getTime() - 5 * DAY), adId: "111111" });
      await seedAdMessage(db, conv, { at: new Date(now.getTime() - 2 * DAY), adId: "222222" });
      await seedAdMessage(db, conv, { at: new Date(now.getTime() - 0.2 * DAY), adId: "333333" }); // after the order
      await scanAdTouches(db, now);
      await seedOrder(db, cust, { at: new Date(now.getTime() - DAY) });
      expect(await attributeOrders(db, 7, now)).toBe(1);
      const [a] = await db.select().from(adOrderAttribution);
      const [t] = await db.select().from(adTouch).where(eq(adTouch.id, a!.touchId));
      expect(t!.adExternalId).toBe("222222");
    });

    it("unpaid and cancelled orders are ignored", async () => {
      const { cust } = await touched(2);
      await seedOrder(db, cust, { at: new Date(now.getTime() - DAY), paymentStatus: "pending", status: "confirmed" });
      await seedOrder(db, cust, { at: new Date(now.getTime() - DAY), paymentStatus: "paid", status: "cancelled" });
      await seedOrder(db, cust, { at: new Date(now.getTime() - DAY), paymentStatus: "refunded", status: "paid" });
      await seedOrder(db, null, { at: new Date(now.getTime() - DAY) });
      expect(await attributeOrders(db, 7, now)).toBe(0);
    });

    it("follows the conversation's customer after a merge", async () => {
      const { conv } = await touched(2);
      const kept = await seedCustomer(db, "Kept Contact");
      // What the inbox merge does: the thread now belongs to the kept contact.
      await db.update(inboxConversation).set({ customerId: kept }).where(eq(inboxConversation.id, conv));
      await seedOrder(db, kept, { at: new Date(now.getTime() - DAY) });
      expect(await attributeOrders(db, 7, now)).toBe(1);
    });
  });

  // ── Purchase reports ───────────────────────────────────────────────────────

  describe("reporting purchases to Meta", () => {
    const now = new Date();
    const on: Partial<AdsSettingsValue> = { capi_enabled: true, capi_privacy_confirmed_by: "owner", capi_privacy_confirmed_at: now.toISOString() };

    async function attributed(opts: { clid?: string | null; daysAgo?: number } = {}) {
      const cust = await seedCustomer(db);
      const conv = await seedConversation(db, cust, lineId);
      const at = new Date(now.getTime() - (opts.daysAgo ?? 1) * DAY - 3600_000);
      await seedAdMessage(db, conv, { at, ...(opts.clid !== undefined ? { clid: opts.clid } : {}) });
      await scanAdTouches(db, new Date(at.getTime() + 60_000));
      const paidAt = new Date(now.getTime() - (opts.daysAgo ?? 1) * DAY + 5 * 60_000);
      const order = await seedOrder(db, cust, { at: new Date(now.getTime() - (opts.daysAgo ?? 1) * DAY), subtotal: 12500, paidAt });
      await attributeOrders(db, 28, now);
      const [a] = await db.select().from(adOrderAttribution).where(eq(adOrderAttribution.saleOrderId, order.id));
      return { cust, conv, order, attributionId: a!.id, paidAt };
    }
    const status = async (id: string) => (await db.select().from(adOrderAttribution).where(eq(adOrderAttribution.id, id)))[0]!;

    it("nothing is sent when capi_enabled is false", async () => {
      const a = await attributed();
      const off = await getAdsSettings(db);
      expect(off.capi_enabled).toBe(false);
      expect(await queuePurchaseReports(db, off, now)).toBe(0);
      expect(await sendPurchaseReports(db, cfg, off, log, now)).toBe(0);
      // Even a row someone queued by hand is not sent while the switch is off…
      await db.update(adOrderAttribution).set({ capiStatus: "queued" }).where(eq(adOrderAttribution.id, a.attributionId));
      expect(await sendPurchaseReports(db, cfg, off, log, now)).toBe(0);
      // …nor when the caller's copy says on but the database says off…
      expect(await sendPurchaseReports(db, cfg, { ...off, ...on }, log, now)).toBe(0);
      // …nor when the switch is on without the owner's privacy statement.
      await settings({ capi_enabled: true });
      expect(await sendPurchaseReports(db, cfg, await getAdsSettings(db), log, now)).toBe(0);
      expect(fake.calls).toEqual([]);
      expect(fake.events).toEqual([]);
      expect((await status(a.attributionId)).capiStatus).toBe("queued");
    });

    it("sends exactly the amount, the time and the click code, once, and writes the requested log row before calling Meta", async () => {
      const a = await attributed();
      const s = await settings(on);
      expect(await queuePurchaseReports(db, s, now)).toBe(1);
      let requestedRowsWhenMetaWasCalled = -1;
      fake.override = async (call) => {
        if (call.edge.endsWith("/events")) {
          requestedRowsWhenMetaWasCalled = (await db.select().from(adActionLog).where(and(eq(adActionLog.action, "report_purchase"), eq(adActionLog.phase, "requested")))).length;
        }
        return null;
      };
      const before = (await db.select().from(adActionLog).where(eq(adActionLog.action, "report_purchase"))).length;
      expect(await sendPurchaseReports(db, cfg, s, log, now)).toBe(1);
      expect(requestedRowsWhenMetaWasCalled).toBe(before / 2 + 1);
      expect(fake.events).toEqual([
        {
          data: [
            {
              event_name: "Purchase",
              event_time: Math.floor(a.paidAt.getTime() / 1000),
              action_source: "business_messaging",
              messaging_channel: "whatsapp",
              user_data: { whatsapp_business_account_id: WABA, ctwa_clid: CLID },
              custom_data: { currency: "NGN", value: 12500 },
            },
          ],
        },
      ]);
      expect((await status(a.attributionId)).capiStatus).toBe("sent");
      expect((await getAdsSettings(db)).datasets).toEqual({ [WABA]: "900000000000001" });
      // Never twice.
      expect(await queuePurchaseReports(db, s, now)).toBe(0);
      expect(await sendPurchaseReports(db, cfg, await getAdsSettings(db), log, now)).toBe(0);
      expect(fake.events).toHaveLength(1);
      // The log holds only the first 6 characters of the click code.
      const rows = (await db.select().from(adActionLog).where(eq(adActionLog.action, "report_purchase"))).slice(-2);
      expect(JSON.stringify(rows)).toContain("TESTCL…");
      expect(JSON.stringify(rows)).not.toContain(CLID);
      expect(rows.map((r) => r.actorKind)).toEqual(["system", "system"]);
    });

    it("skips when blocked, no click id, not WhatsApp, too old", async () => {
      const s = await settings(on);
      const blocked = await attributed();
      await db.update(adTouch).set({ reportingBlockedAt: new Date() }).where(eq(adTouch.conversationId, blocked.conv));
      const noClid = await attributed({ clid: null });
      const old = await attributed({ daysAgo: 8 });
      const notWa = await attributed();
      await db.update(adTouch).set({ channel: "messenger" }).where(eq(adTouch.conversationId, notWa.conv));
      const removed = await attributed();
      await db.execute(sql`update customer set deleted_at = now() where id = ${removed.cust}`);
      expect(await queuePurchaseReports(db, s, now)).toBe(0);
      expect(await status(blocked.attributionId)).toMatchObject({ capiStatus: "skipped", capiNote: "A staff member chose not to report this customer." });
      expect(await status(noClid.attributionId)).toMatchObject({ capiStatus: "skipped", capiNote: "This advert tap had no click code (for example a WhatsApp Status advert)." });
      expect(await status(old.attributionId)).toMatchObject({ capiStatus: "skipped", capiNote: "Too old to report." });
      expect(await status(notWa.attributionId)).toMatchObject({ capiStatus: "skipped", capiNote: "Only WhatsApp purchases are reported." });
      expect(await status(removed.attributionId)).toMatchObject({ capiStatus: "skipped", capiNote: "This customer record was removed." });
      expect(await sendPurchaseReports(db, cfg, s, log, now)).toBe(0);
      expect(fake.writes()).toEqual([]);
    });

    it("a 'do not report' pressed after queueing still stops the send", async () => {
      const s = await settings(on);
      const a = await attributed();
      expect(await queuePurchaseReports(db, s, now)).toBe(1);
      await db.update(adTouch).set({ reportingBlockedAt: new Date() }).where(eq(adTouch.conversationId, a.conv));
      expect(await sendPurchaseReports(db, cfg, s, log, now)).toBe(0);
      expect(fake.writes()).toEqual([]);
      expect((await status(a.attributionId)).capiStatus).toBe("skipped");
    });

    it("a timeout leaves unknown and is not retried", async () => {
      const s = await settings({ ...on, datasets: { [WABA]: "900000000000001" } });
      const a = await attributed();
      await queuePurchaseReports(db, s, now);
      fake.override = (call) => (call.edge.endsWith("/events") ? noAnswer() : null);
      expect(await sendPurchaseReports(db, cfg, s, log, now)).toBe(0);
      expect((await status(a.attributionId)).capiStatus).toBe("unknown");
      fake.override = null;
      expect(await queuePurchaseReports(db, s, now)).toBe(0);
      expect(await sendPurchaseReports(db, cfg, s, log, now)).toBe(0);
      expect(fake.writes().filter((c) => c.edge.endsWith("/events"))).toHaveLength(1);
      const last = (await db.select().from(adActionLog).where(eq(adActionLog.action, "report_purchase"))).filter((r) => r.phase === "result").pop()!;
      expect(last.outcome).toBe("unknown");
    });

    it("a permission refusal fails the row in plain words and tells the owner once", async () => {
      const s = await settings({ ...on, datasets: { [WABA]: "900000000000001" } });
      const a = await attributed();
      await queuePurchaseReports(db, s, now);
      fake.override = (call) => (call.edge.endsWith("/events") ? fake.refuse(200, "Requires whatsapp_business_manage_events", 403) : null);
      await sendPurchaseReports(db, cfg, s, log, now);
      expect(await status(a.attributionId)).toMatchObject({ capiStatus: "failed", capiNote: "Meta has not given the suite permission to report purchases." });
      expect(await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "ads.config_error"))).toHaveLength(1);
    });
  });

  // ── Phase B: the gates ─────────────────────────────────────────────────────

  describe("assertCanManage", () => {
    const code = async () => {
      try {
        await assertCanManage(db);
        return "ok";
      } catch (e) {
        return (e as AdsManageError).code;
      }
    };
    it("each of the five refusals, in order", async () => {
      // Nothing set up at all: the switch is off by default.
      expect((await getAdsSettings(db)).manage_enabled).toBe(false);
      expect(ADS_SETTINGS_DEFAULT.manage_enabled).toBe(false);
      expect(await code()).toBe("off");
      await link({ accountStatus: 2, budgetFactor: null, currency: "USD" });
      expect(await code()).toBe("off");
      await settings({ manage_enabled: true });
      await db.update(adAccountLink).set({ isActive: false });
      expect(await code()).toBe("no_account");
      await db.update(adAccountLink).set({ isActive: true });
      expect(await code()).toBe("account_not_active");
      await db.update(adAccountLink).set({ accountStatus: 1 });
      expect(await code()).toBe("not_calibrated");
      await db.update(adAccountLink).set({ budgetFactor: 100 });
      // A dollar account is refused, not converted.
      expect(await code()).toBe("currency");
      await db.update(adAccountLink).set({ currency: "NGN" });
      expect(await code()).toBe("ok");
      // Anything but exactly true is off.
      await db.update(appSetting).set({ value: { ...ADS_SETTINGS_DEFAULT, manage_enabled: "yes" } });
      expect(await code()).toBe("off");
    });
  });

  describe("checkCap", () => {
    it("counts live ad sets made outside the suite, and only live ones", async () => {
      const l = await link();
      const s = await managing(10000);
      const liveCamp = fake.addCampaign({ status: "ACTIVE" });
      fake.addAdset({ campaign_id: liveCamp, status: "ACTIVE", daily_budget: "300000" }); // ₦3,000, made in Ads Manager
      fake.addAdset({ campaign_id: liveCamp, status: "PAUSED", daily_budget: "900000" }); // off: not counted
      const offCamp = fake.addCampaign({ status: "PAUSED" });
      fake.addAdset({ campaign_id: offCamp, status: "ACTIVE", daily_budget: "900000" }); // campaign off: not counted
      const cboCamp = fake.addCampaign({ status: "ACTIVE", daily_budget: "250000" }); // campaign holds ₦2,500
      fake.addAdset({ campaign_id: cboCamp, status: "ACTIVE" });
      fake.addAdset({ campaign_id: cboCamp, status: "ACTIVE" });
      const lifeCamp = fake.addCampaign({ status: "ACTIVE" });
      const now = new Date("2026-11-20T08:00:00Z");
      fake.addAdset({ campaign_id: lifeCamp, status: "ACTIVE", lifetime_budget: "1000000", end_time: "2026-11-24T08:00:00Z" }); // ₦10,000 over 4 days
      const r = await checkCap(cfg, l, s, { requestedDaily: 2000, now });
      expect(r).toEqual({ ok: true, cap: 10000, alreadyCommitted: 3000 + 2500 + 2500, requested: 2000, room: 2000 });
      expect((await checkCap(cfg, l, s, { requestedDaily: 2001, now })).ok).toBe(false);
      // Read fresh from Meta, never written.
      expect(fake.writes()).toEqual([]);
      expect(fake.calls.some((c) => c.edge === `${ACT}/adsets`)).toBe(true);
    });

    it("leaves out the ad set being changed", async () => {
      const l = await link();
      const s = await managing(5000);
      const camp = fake.addCampaign({ status: "ACTIVE" });
      const mine = fake.addAdset({ campaign_id: camp, status: "ACTIVE", daily_budget: "400000" });
      expect((await checkCap(cfg, l, s, { requestedDaily: 4500 })).ok).toBe(false);
      expect((await checkCap(cfg, l, s, { requestedDaily: 4500, excludeAdsetExternalId: mine })).ok).toBe(true);
    });

    it("refuses when Meta cannot be read", async () => {
      const l = await link();
      const s = await managing(10000);
      for (const failure of [() => fake.refuse(17, "User request limit reached"), () => noAnswer(), () => fake.refuse(190, "bad token", 401)]) {
        fake.override = failure;
        await expect(checkCap(cfg, l, s, { requestedDaily: 1 })).rejects.toMatchObject({
          code: "cap_unknown",
          staffMessage: "We could not check current budgets with Meta, so nothing was changed. Try again in a few minutes.",
        });
      }
      // A live ad set with no budget we can read is also "unknown", never zero.
      fake.override = null;
      const camp = fake.addCampaign({ status: "ACTIVE" });
      fake.addAdset({ campaign_id: camp, status: "ACTIVE" });
      await expect(checkCap(cfg, l, s, { requestedDaily: 1 })).rejects.toMatchObject({ code: "cap_unknown" });
    });

    it("a cap of 0 lets nothing through", async () => {
      const l = await link();
      const s = await settings({ manage_enabled: true, daily_cap: 0 });
      expect((await checkCap(cfg, l, s, { requestedDaily: 1 })).ok).toBe(false);
    });
  });

  // ── Phase B: creating ──────────────────────────────────────────────────────

  const deps = { loadImage: async () => new Uint8Array([1, 2, 3, 4]), shop: null };

  async function confirmedDraft(over: Parameters<typeof exampleSpec>[1] = {}) {
    const spec = exampleSpec(lineId, over);
    const [d] = await db
      .insert(adDraft)
      .values({ spec, confirmedBy: owner.userId, confirmedAt: new Date(), confirmedHash: draftFingerprint(spec), createdBy: owner.userId })
      .returning();
    return d!;
  }

  describe("createAdFromDraft", () => {
    it("creates campaign, ad set, creative and ad, every one switched off, each logged before and after", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      const out = await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(out).toMatchObject({ status: "created", step: "done", imageHash: "testhash0001" });
      const writes = fake.adWrites();
      expect(writes.map((w) => w.edge)).toEqual([`${ACT}/adimages`, `${ACT}/campaigns`, `${ACT}/adsets`, `${ACT}/adcreatives`, `${ACT}/ads`]);
      for (const w of writes) expect(JSON.stringify(w.body)).not.toContain("ACTIVE");
      expect(writes[1]!.body).toMatchObject({ status: "PAUSED", special_ad_categories: [] });
      expect(writes[2]!.body).toMatchObject({ status: "PAUSED", daily_budget: 200000, promoted_object: { page_id: PAGE_ID } });
      expect(writes[4]!.body).toMatchObject({ status: "PAUSED" });
      for (const w of writes.slice(1)) expect(String(w.body!.name).endsWith(nameTag(d.id))).toBe(true);
      // At Meta, nothing is on.
      for (const o of [...fake.campaigns.values(), ...fake.adsets.values(), ...fake.ads.values()]) expect(o.status).toBe("PAUSED");
      const cache = await db.select().from(adCampaignCache);
      expect(cache).toHaveLength(3);
      expect(cache.every((c) => c.createdBySuite && c.status === "PAUSED")).toBe(true);
      // Five writes, each with a requested row and a result row, by the named person.
      const rows = await logRows();
      const mine = rows.filter((r) => ["upload_image", "create_campaign", "create_adset", "create_creative", "create_ad"].includes(r.action) && r.at >= d.createdAt);
      expect(mine.filter((r) => r.phase === "requested")).toHaveLength(5);
      expect(mine.filter((r) => r.phase === "result" && r.outcome === "ok")).toHaveLength(5);
      expect(mine.every((r) => r.actorKind === "person" && r.actorUserId === owner.userId && r.actorName === "Owner")).toBe(true);
      expect(mine.find((r) => r.action === "create_adset" && r.phase === "requested")!.summary).toContain("The most the advert can spend: ₦6,000");
      expect(JSON.stringify(mine)).not.toContain(FAKE_TOKEN);
    });

    it("the requested log row is committed before each call to Meta", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      const seen: { edge: string; requested: number }[] = [];
      const start = new Date();
      fake.override = async (call) => {
        if (call.method === "POST") {
          const requested = (await logSince(start)).filter((r) => r.phase === "requested" && r.action !== "report_purchase").length;
          seen.push({ edge: call.edge, requested });
        }
        return null;
      };
      await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(seen.map((s) => s.requested)).toEqual([1, 2, 3, 4, 5]);
    });

    it("saves each id and resumes without repeating a finished step", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      // Meta refuses the creative the first time.
      fake.override = (call) => (call.method === "POST" && call.edge === `${ACT}/adcreatives` ? fake.refuse(100, "Creative must provide enroll_status") : null);
      const first = await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(first.status).toBe("failed");
      expect(first.errorMessage).toBe("Meta refused this step: Creative must provide enroll_status");
      expect(first.campaignExternalId).not.toBeNull();
      expect(first.adsetExternalId).not.toBeNull();
      expect(first.creativeExternalId).toBeNull();
      expect(fake.campaigns.size).toBe(1);
      fake.override = null;
      fake.calls = [];
      const second = await createAdFromDraft(db, cfg, d.id, owner, deps, "continue");
      expect(second.status).toBe("created");
      expect(fake.adWrites().map((w) => w.edge)).toEqual([`${ACT}/adcreatives`, `${ACT}/ads`]);
      expect(fake.campaigns.size).toBe(1);
      expect(fake.adsets.size).toBe(1);
      expect(fake.ads.size).toBe(1);
      expect(second.campaignExternalId).toBe(first.campaignExternalId);
    });

    it("a second identical request while the first is running finds nothing to claim", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      await db.update(adDraft).set({ status: "creating", lockedAt: new Date() }).where(eq(adDraft.id, d.id));
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "in_progress", staffMessage: "This is already in progress." });
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps, "continue")).rejects.toMatchObject({ code: "in_progress" });
      expect(fake.writes()).toEqual([]);
    });

    it("budget read back differently marks failed and not created_by_suite", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      // Meta "saves" ten times the budget.
      fake.afterWrite = (call) => {
        if (call.edge === `${ACT}/adsets`) for (const a of fake.adsets.values()) a.daily_budget = "2000000";
      };
      const out = await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(out.status).toBe("failed");
      expect(out.errorMessage).toBe("Meta saved a different budget or state than we sent. Do not turn this advert on. Check it in Meta Ads Manager.");
      expect(await db.select().from(adCampaignCache).where(eq(adCampaignCache.createdBySuite, true))).toHaveLength(0);
      // And so it cannot be turned on from the suite.
      await expect(turnOnAdvert(db, cfg, out.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({ code: "not_suite_made" });
      expect(fake.adWrites().some((w) => w.body?.status === "ACTIVE")).toBe(false);
    });

    it("if Meta saved something switched on, the campaign is paused at once and the advert is blocked", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      fake.afterWrite = (call) => {
        if (call.edge === `${ACT}/ads`) for (const a of fake.ads.values()) a.status = "ACTIVE";
      };
      const out = await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(out.status).toBe("failed");
      const last = fake.adWrites().pop()!;
      expect(last.edge).toBe(out.campaignExternalId);
      expect(last.body).toEqual({ status: "PAUSED" });
      expect(await db.select().from(adCampaignCache).where(eq(adCampaignCache.createdBySuite, true))).toHaveLength(0);
    });

    it("needs_check adopts an object found by name tag instead of creating it again", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      // The ad set call reaches Meta but the answer never comes back.
      fake.override = (call) => {
        if (call.method === "POST" && call.edge === `${ACT}/adsets`) {
          fake.addAdset({ ...call.body, daily_budget: String(call.body!.daily_budget), effective_status: "PAUSED" });
          return noAnswer();
        }
        return null;
      };
      const first = await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(first.status).toBe("needs_check");
      expect(first.errorMessage).toContain("Meta did not answer. Nothing can have been spent");
      expect(first.adsetExternalId).toBeNull();
      expect(fake.adsets.size).toBe(1);
      fake.override = null;
      fake.calls = [];
      const second = await createAdFromDraft(db, cfg, d.id, owner, deps, "continue");
      expect(second.status).toBe("created");
      // The ad set was looked up, not sent again.
      expect(fake.adsets.size).toBe(1);
      expect(fake.adWrites().map((w) => w.edge)).toEqual([`${ACT}/adcreatives`, `${ACT}/ads`]);
      expect(second.adsetExternalId).toBe([...fake.adsets.keys()][0]);
      const unknown = (await logRows()).filter((r) => r.action === "create_adset" && r.phase === "result").pop()!;
      expect(unknown.outcome).toBe("unknown");
    });

    it("needs_check with nothing found at Meta repeats the step once", async () => {
      await link();
      await managing();
      const d = await confirmedDraft();
      fake.override = (call) => (call.method === "POST" && call.edge === `${ACT}/campaigns` ? noAnswer() : null);
      expect((await createAdFromDraft(db, cfg, d.id, owner, deps)).status).toBe("needs_check");
      fake.override = null;
      expect((await createAdFromDraft(db, cfg, d.id, owner, deps, "continue")).status).toBe("created");
      expect(fake.campaigns.size).toBe(1);
    });

    it("refuses, with no call to Meta, when: the switch is off, the draft changed after it was confirmed, the budget is over the cap or under Meta's minimum, or the person lacks ads.manage", async () => {
      await link();
      const d = await confirmedDraft();
      // Switch off (the default).
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "off" });
      await managing(1000);
      // Over the cap: logged as blocked.
      const t0 = new Date();
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({
        code: "over_cap",
        staffMessage: "This would take live daily budgets to ₦2,000, over your cap of ₦1,000. Lower the amount, pause another advert, or ask the owner to raise the cap.",
      });
      const blocked = (await logSince(t0)).filter((r) => r.phase === "result");
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toMatchObject({ outcome: "blocked", summary: "Blocked by the daily cap: ₦2,000 asked for, ₦0 already live, cap ₦1,000." });
      await managing(10000);
      // Under Meta's minimum (₦500 here).
      const small = await confirmedDraft({ daily_budget: 400 });
      await expect(createAdFromDraft(db, cfg, small.id, owner, deps)).rejects.toMatchObject({ code: "below_minimum", staffMessage: "Meta's minimum for this account is ₦500 a day." });
      // Changed after confirmation.
      await db.update(adDraft).set({ spec: { ...d.spec, daily_budget: 9000 } }).where(eq(adDraft.id, d.id));
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "not_confirmed" });
      // Never confirmed at all.
      const [raw] = await db.insert(adDraft).values({ spec: exampleSpec(lineId) }).returning();
      await expect(createAdFromDraft(db, cfg, raw!.id, owner, deps)).rejects.toMatchObject({ code: "not_confirmed" });
      // An admin without the permission, a manager, a switched-off owner, and a made-up person.
      const fresh = await confirmedDraft();
      const admin = await seedUser(db, { email: `admin-${Date.now()}@example.com`, role: "admin" });
      await expect(createAdFromDraft(db, cfg, fresh.id, { kind: "person", userId: admin.id, name: "Admin" }, deps)).rejects.toMatchObject({ code: "not_allowed" });
      await expect(createAdFromDraft(db, cfg, fresh.id, { kind: "person", userId: "00000000-0000-4000-8000-000000000000", name: "Nobody" }, deps)).rejects.toMatchObject({ code: "not_allowed" });
      await expect(createAdFromDraft(db, cfg, fresh.id, { kind: "rule", userId: null, name: "A rule" } as unknown as PersonActor, deps)).rejects.toMatchObject({ code: "not_allowed" });
      await db.update(adminUser).set({ isActive: false }).where(eq(adminUser.id, owner.userId));
      await expect(createAdFromDraft(db, cfg, fresh.id, owner, deps)).rejects.toMatchObject({ code: "not_allowed" });
      await db.update(adminUser).set({ isActive: true }).where(eq(adminUser.id, owner.userId));
      expect(fake.calls).toEqual([]);
      // With ads.manage granted by the owner, the admin may.
      const granted = await seedUser(db, { email: `granted-${Date.now()}@example.com`, role: "admin", granted: ["ads.manage"] });
      expect((await createAdFromDraft(db, cfg, fresh.id, { kind: "person", userId: granted.id, name: "Granted" }, deps)).status).toBe("created");
    });

    it("a dollar ad account or an unchecked budget unit is refused, never converted", async () => {
      await link({ currency: "USD" });
      await managing();
      const d = await confirmedDraft();
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "currency" });
      await db.update(adAccountLink).set({ currency: "NGN", budgetFactor: null });
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "not_calibrated" });
      await db.update(adAccountLink).set({ budgetFactor: 10 });
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "not_calibrated" });
      expect(fake.calls).toEqual([]);
      // Factor 1: Meta takes whole naira.
      await db.update(adAccountLink).set({ budgetFactor: 1, minDailyBudgetUnits: 500 });
      await createAdFromDraft(db, cfg, d.id, owner, deps);
      expect(fake.adWrites().find((w) => w.edge === `${ACT}/adsets`)!.body!.daily_budget).toBe(2000);
    });

    it("Messenger and Instagram adverts are not created until checked with Meta", async () => {
      await link();
      await managing();
      const d = await confirmedDraft({ destination: "messenger" });
      await expect(createAdFromDraft(db, cfg, d.id, owner, deps)).rejects.toMatchObject({ code: "invalid" });
      expect(fake.calls).toEqual([]);
    });
  });

  // ── Phase B: turning on, pausing, budgets ──────────────────────────────────

  async function createdAdvert(over: Parameters<typeof exampleSpec>[1] = {}) {
    const d = await confirmedDraft(over);
    const out = await createAdFromDraft(db, cfg, d.id, owner, deps);
    expect(out.status).toBe("created");
    fake.calls = [];
    return out;
  }

  describe("turnOnAdvert", () => {
    it("activates the campaign last, after the typed total and the cap are checked on the server", async () => {
      await link();
      await managing(10000);
      const d = await createdAdvert();
      // The wrong total: nothing is sent.
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "5999" })).rejects.toMatchObject({ code: "wrong_total", staffMessage: "Type the total exactly as shown to confirm." });
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "" })).rejects.toMatchObject({ code: "wrong_total" });
      expect(fake.writes()).toEqual([]);
      // ₦2,000 a day for the 3 days left = ₦6,000.
      await turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "₦6,000" });
      const writes = fake.adWrites();
      expect(writes.map((w) => w.edge)).toEqual([d.adExternalId, d.adsetExternalId, d.campaignExternalId]);
      expect(writes.every((w) => JSON.stringify(w.body) === '{"status":"ACTIVE"}')).toBe(true);
      // The cap was read from Meta before the first write.
      const firstWrite = fake.calls.findIndex((c) => c.method === "POST");
      expect(fake.calls.slice(0, firstWrite).some((c) => c.edge === `${ACT}/adsets`)).toBe(true);
      const rows = (await logRows()).filter((r) => r.action === "turn_on");
      expect(rows.filter((r) => r.phase === "requested")).toHaveLength(3);
      expect(rows[0]!.summary).toContain("₦6,000 in total");
      expect(rows[0]!.confirmText).toBe("6000");
      expect(rows.every((r) => r.actorName === "Owner")).toBe(true);
    });

    it("over the cap makes no call and logs blocked", async () => {
      await link();
      await managing(3000);
      const d = await createdAdvert();
      // Someone is already running ₦2,000 a day from Ads Manager.
      const other = fake.addCampaign({ status: "ACTIVE" });
      fake.addAdset({ campaign_id: other, status: "ACTIVE", daily_budget: "200000" });
      const t0 = new Date();
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({
        code: "over_cap",
        staffMessage: "This would take live daily budgets to ₦4,000, over your cap of ₦3,000. Lower the amount, pause another advert, or ask the owner to raise the cap.",
        details: { cap: 3000, already_committed: 2000, requested: 2000 },
      });
      expect(fake.writes()).toEqual([]);
      const rows = await logSince(t0);
      expect(rows.map((r) => [r.phase, r.outcome])).toEqual([
        ["requested", null],
        ["result", "blocked"],
      ]);
      expect(rows[1]!.summary).toBe("Blocked by the daily cap: ₦2,000 asked for, ₦2,000 already live, cap ₦3,000.");
      expect(fake.campaigns.get(d.campaignExternalId!)!.status).toBe("PAUSED");
    });

    it("refuses when the cap cannot be checked, the switch is off, the cap is 0, the advert ended, or it was not made in the suite", async () => {
      await link();
      await managing(10000);
      const d = await createdAdvert();
      fake.override = (call) => (call.edge === `${ACT}/adsets` ? fake.refuse(17, "limit") : null);
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({ code: "cap_unknown" });
      fake.override = null;
      await settings({ daily_cap: 0 });
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({ code: "over_cap" });
      await settings({ manage_enabled: false, daily_cap: 10000 });
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({ code: "off" });
      await settings({ manage_enabled: true });
      fake.adsets.get(d.adsetExternalId!)!.end_time = new Date(Date.now() - 3600_000).toISOString();
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "2000" })).rejects.toMatchObject({ code: "ended", staffMessage: "This advert's end date has passed. Create a new one." });
      const outside = fake.addCampaign({ name: "Made in Ads Manager" });
      await expect(turnOnAdvert(db, cfg, outside, owner, { typed: "1" })).rejects.toMatchObject({
        code: "not_suite_made",
        staffMessage: "This advert was not made in the suite. Turn it on in Meta Ads Manager.",
      });
      const admin = await seedUser(db, { email: `a2-${Date.now()}@example.com`, role: "admin" });
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, { kind: "person", userId: admin.id, name: "Admin" }, { typed: "6000" })).rejects.toMatchObject({ code: "not_allowed" });
      expect(fake.writes()).toEqual([]);
    });

    it("no answer from Meta is settled by one read, never by sending again", async () => {
      await link();
      await managing(10000);
      const d = await createdAdvert();
      fake.override = (call) => (call.method === "POST" && call.edge === d.campaignExternalId ? noAnswer() : null);
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({
        code: "not_confirmed_by_meta",
        staffMessage: "Meta did not confirm. The advert is still off. Try again.",
      });
      expect(fake.adWrites().filter((w) => w.edge === d.campaignExternalId)).toHaveLength(1);
      // A double click within 30 seconds is refused.
      fake.override = null;
      await expect(turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" })).rejects.toMatchObject({ code: "in_progress" });
    });
  });

  describe("pauseObject", () => {
    it("pauses anything in the linked account with the master switch off, and nothing outside it", async () => {
      await link();
      expect((await getAdsSettings(db)).manage_enabled).toBe(false);
      const camp = fake.addCampaign({ status: "ACTIVE", name: "Made elsewhere" });
      await pauseObject(db, cfg, "campaign", camp, owner, 'Paused "Made elsewhere".');
      expect(fake.adWrites().map((w) => [w.edge, w.body])).toEqual([[camp, { status: "PAUSED" }]]);
      expect(fake.campaigns.get(camp)!.status).toBe("PAUSED");
      const rows = (await logRows()).filter((r) => r.action === "pause" && r.objectExternalId === camp);
      expect(rows.map((r) => r.outcome)).toEqual([null, "ok"]);
      fake.calls = [];
      await expect(pauseObject(db, cfg, "campaign", "99999999", owner, "x")).rejects.toMatchObject({ code: "not_found" });
      const admin = await seedUser(db, { email: `a3-${Date.now()}@example.com`, role: "admin" });
      await expect(pauseObject(db, cfg, "campaign", camp, { kind: "person", userId: admin.id, name: "Admin" }, "x")).rejects.toMatchObject({ code: "not_allowed" });
      expect(fake.writes()).toEqual([]);
    });
  });

  describe("changeDailyBudget", () => {
    it("checks the typed total, the cap and Meta's minimum, then reads the budget back", async () => {
      await link();
      await managing(10000);
      const d = await createdAdvert();
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 3000, owner, { typed: "6000" })).rejects.toMatchObject({ code: "wrong_total" });
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 300, owner, { typed: "900" })).rejects.toMatchObject({ code: "below_minimum" });
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 12000, owner, { typed: "36000" })).rejects.toMatchObject({ code: "over_cap" });
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 2500.5, owner, { typed: "7500" })).rejects.toMatchObject({ code: "invalid" });
      expect(fake.writes()).toEqual([]);
      const res = await changeDailyBudget(db, cfg, d.adsetExternalId!, 3000, owner, { typed: "9000" });
      expect(res).toEqual({ before: 2000, after: 3000 });
      expect(fake.adWrites().map((w) => [w.edge, w.body])).toEqual([[d.adsetExternalId, { daily_budget: 300000 }]]);
      expect(fake.adsets.get(d.adsetExternalId!)!.daily_budget).toBe("300000");
      const outside = fake.addAdset({ campaign_id: fake.addCampaign({}), daily_budget: "100000" });
      await expect(changeDailyBudget(db, cfg, outside, 3000, owner, { typed: "9000" })).rejects.toMatchObject({ code: "not_suite_made" });
    });

    it("a live advert's new budget is added to everything else that is live", async () => {
      await link();
      await managing(5000);
      const d = await createdAdvert();
      await turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" });
      const other = fake.addCampaign({ status: "ACTIVE" });
      fake.addAdset({ campaign_id: other, status: "ACTIVE", daily_budget: "250000" });
      fake.calls = [];
      await db.update(adDraft).set({ lockedAt: null });
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 3000, owner, { typed: "9000" })).rejects.toMatchObject({
        code: "over_cap",
        details: { cap: 5000, already_committed: 2500, requested: 3000 },
      });
      expect(fake.writes()).toEqual([]);
      await changeDailyBudget(db, cfg, d.adsetExternalId!, 2500, owner, { typed: "7500" });
      expect(fake.adsets.get(d.adsetExternalId!)!.daily_budget).toBe("250000");
    });

    it("fifth change in an hour is refused", async () => {
      await link();
      await managing(100000);
      const d = await createdAdvert();
      for (const [i, amount] of [2100, 2200, 2300, 2400].entries()) {
        await db.update(adDraft).set({ lockedAt: null });
        await changeDailyBudget(db, cfg, d.adsetExternalId!, amount, owner, { typed: String(amount * 3) });
        expect(fake.adWrites()).toHaveLength(i + 1);
      }
      await db.update(adDraft).set({ lockedAt: null });
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 2500, owner, { typed: "7500" })).rejects.toMatchObject({
        code: "too_many_changes",
        staffMessage: "Meta allows a budget to change 4 times an hour. Try again later.",
      });
      expect(fake.adWrites()).toHaveLength(4);
    });

    it("if Meta saves a different budget, the advert is paused and taken out of the suite's hands", async () => {
      await link();
      await managing(100000);
      const d = await createdAdvert();
      fake.afterWrite = (call) => {
        if (call.body?.daily_budget !== undefined) fake.adsets.get(d.adsetExternalId!)!.daily_budget = "9900000";
      };
      await expect(changeDailyBudget(db, cfg, d.adsetExternalId!, 3000, owner, { typed: "9000" })).rejects.toMatchObject({ code: "mismatch" });
      const last = fake.adWrites().pop()!;
      expect([last.edge, last.body]).toEqual([d.campaignExternalId, { status: "PAUSED" }]);
      expect(await db.select().from(adCampaignCache).where(eq(adCampaignCache.createdBySuite, true))).toHaveLength(0);
    });
  });

  // ── Rules and the safety stop: they can only pause ─────────────────────────

  async function runningAdvert(cap = 100000) {
    await link();
    await managing(cap);
    const d = await createdAdvert();
    await turnOnAdvert(db, cfg, d.campaignExternalId!, owner, { typed: "6000" });
    fake.calls = [];
    return d;
  }
  const rule = (over: Partial<typeof adRule.$inferInsert> = {}) =>
    db.insert(adRule).values({ name: "Too dear", metric: "cost_per_conversation", threshold: "800.00", currency: "NGN", lookbackDays: 3, minSpend: "1000.00", ...over }).returning();
  const chats = (count: number) => [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: String(count) }];

  describe("evaluateRules", () => {
    it("pauses above the threshold; does nothing under min_spend; never activates", async () => {
      const d = await runningAdvert();
      await settings({ rules_enabled: true });
      const [r] = await rule();
      // ₦900 spent: under the ₦1,000 minimum, so nothing happens.
      fake.campaignInsights.set(d.campaignExternalId!, { spend: "900.00", actions: chats(0) });
      expect(await evaluateRules(db, cfg, log)).toBe(0);
      // ₦4,000 for 10 chats is ₦400 each: under the ₦800 limit.
      fake.campaignInsights.set(d.campaignExternalId!, { spend: "4000.00", actions: chats(10) });
      expect(await evaluateRules(db, cfg, log)).toBe(0);
      expect(fake.writes()).toEqual([]);
      expect((await db.select().from(adRule))[0]!.lastEvaluatedAt).not.toBeNull();
      // ₦4,000 for 4 chats is ₦1,000 each: over.
      fake.campaignInsights.set(d.campaignExternalId!, { spend: "4000.00", actions: chats(4) });
      const t0 = new Date();
      expect(await evaluateRules(db, cfg, log)).toBe(1);
      expect(fake.writes().map((w) => [w.method, w.edge, w.body])).toEqual([["POST", d.campaignExternalId, { status: "PAUSED" }]]);
      expect(fake.campaigns.get(d.campaignExternalId!)!.status).toBe("PAUSED");
      const rows = await logSince(t0);
      const pause = rows.find((x) => x.action === "pause" && x.phase === "requested")!;
      expect(pause).toMatchObject({ actorKind: "rule", actorName: "Too dear", actorUserId: null });
      expect(pause.summary).toBe("Rule 'Too dear' paused 'November juice [ms-" + d.id.replace(/-/g, "").slice(0, 8) + "]': each chat cost ₦1,000 over the last 3 days, above your limit of ₦800.");
      expect(rows.some((x) => x.action === "rule_check" && x.outcome === "ok")).toBe(true);
      expect((await db.select().from(adRule).where(eq(adRule.id, r!.id)))[0]!.lastFiredAt).not.toBeNull();
      expect(await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "ads.rule_fired"))).toHaveLength(1);
      // Already paused: a second run does not touch it, and nothing ever turns it back on.
      fake.calls = [];
      fake.campaignInsights.set(d.campaignExternalId!, { spend: "4000.00", actions: chats(400) });
      expect(await evaluateRules(db, cfg, log)).toBe(0);
      expect(fake.writes()).toEqual([]);
      expect(fake.campaigns.get(d.campaignExternalId!)!.status).toBe("PAUSED");
    });

    it("money spent and no chats at all also pauses", async () => {
      const d = await runningAdvert();
      await settings({ rules_enabled: true });
      await rule();
      fake.campaignInsights.set(d.campaignExternalId!, { spend: "1500.00" });
      const t0 = new Date();
      expect(await evaluateRules(db, cfg, log)).toBe(1);
      const pause = (await logSince(t0)).find((x) => x.action === "pause")!;
      expect(pause.summary).toContain("₦1,500 spent and no chats started over the last 3 days.");
    });

    it("runs only when the owner has both switches on, and only on adverts made in the suite", async () => {
      const d = await runningAdvert();
      await rule({ minSpend: "0.00", threshold: "1.00" });
      fake.campaignInsights.set(d.campaignExternalId!, { spend: "5000.00", actions: chats(1) });
      // An advert made in Ads Manager that also looks dear.
      const outside = fake.addCampaign({ status: "ACTIVE", name: "Made in Ads Manager" });
      fake.campaignInsights.set(outside, { spend: "5000.00", actions: chats(1) });
      await syncAdAccount(db, cfg, log);
      fake.calls = [];
      // rules_enabled is off by default.
      expect((await getAdsSettings(db)).rules_enabled).toBe(false);
      expect(await evaluateRules(db, cfg, log)).toBe(0);
      await settings({ rules_enabled: true, manage_enabled: false });
      expect(await evaluateRules(db, cfg, log)).toBe(0);
      expect(fake.calls).toEqual([]);
      await settings({ manage_enabled: true });
      expect(await evaluateRules(db, cfg, log)).toBe(1);
      expect(fake.writes().map((w) => w.edge)).toEqual([d.campaignExternalId]);
      expect(fake.campaigns.get(outside)!.status).toBe("ACTIVE");
    });
  });

  describe("safetyBrake", () => {
    it("pauses suite-made campaigns when today's spend reaches the cap, and tells the owner once that day", async () => {
      const d = await runningAdvert(5000);
      const outside = fake.addCampaign({ status: "ACTIVE", name: "Made in Ads Manager" });
      fake.todaySpend = 4999;
      expect(await safetyBrake(db, cfg, log)).toBe(0);
      expect(fake.writes()).toEqual([]);
      fake.todaySpend = 5000;
      const t0 = new Date();
      expect(await safetyBrake(db, cfg, log)).toBe(1);
      expect(fake.writes().map((w) => [w.edge, w.body])).toEqual([[d.campaignExternalId, { status: "PAUSED" }]]);
      expect(fake.campaigns.get(outside)!.status).toBe("ACTIVE");
      const pause = (await logSince(t0)).find((x) => x.action === "pause" && x.phase === "requested")!;
      expect(pause).toMatchObject({ actorKind: "safety", actorName: "Safety stop" });
      expect(pause.summary).toContain("Safety stop: ₦5,000 spent today, at or over the cap of ₦5,000.");
      await safetyBrake(db, cfg, log);
      expect(await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "ads.safety_stop"))).toHaveLength(1);
    });

    it("still stops spending after the owner has switched advert creation off", async () => {
      const d = await runningAdvert(5000);
      await settings({ manage_enabled: false });
      fake.todaySpend = 7000;
      expect(await safetyBrake(db, cfg, log)).toBe(1);
      expect(fake.campaigns.get(d.campaignExternalId!)!.status).toBe("PAUSED");
    });

    it("asks Meta nothing when the suite has made no adverts", async () => {
      await link();
      await managing(5000);
      fake.todaySpend = 9000;
      expect(await safetyBrake(db, cfg, log)).toBe(0);
      expect(fake.calls).toEqual([]);
    });
  });
});
