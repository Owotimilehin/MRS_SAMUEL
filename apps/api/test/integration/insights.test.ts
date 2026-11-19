import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { INSIGHTS_STATE_KEY, appSetting, auditLog, inboxPhoneNumber, insightMetricDaily, insightSubject } from "@ms/db";
import { patchInsightsState, readInsightsState, saveInsightsSourceState } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 11: /v1/insights. The figures are put straight into the tables with fixed
 * dates (nothing here depends on today's date or the machine's time zone). The Graph API
 * is stubbed and only ever sees the owner's "turn on template figures" call. The token
 * below is fake.
 */

const SYSTEM_TOKEN = "itest-token-system-user";
const PAGE = "100200300400";
const IG = "17841400000000001";
const WABA = "104857600123456";
const POST_1 = `${PAGE}_900001`;
const POST_2 = `${PAGE}_900002`;
const MEDIA_1 = "17900000000000001";
const MEDIA_2 = "17900000000000002";
const TEMPLATE = "1924084211297547";
const PACIFIC = "America/Los_Angeles";
const LAGOS = "Africa/Lagos";
const RANGE = "from=2026-11-10&to=2026-11-12";
const AUDIT_ACTIONS = ["insights.export", "insights.refresh", "insights.template_analytics_enable", "insights.template_analytics_enable_unconfirmed"];

type Obj = Record<string, unknown>;
interface GraphCall {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
}
let calls: GraphCall[] = [];
let enableRefusal: { code: number; message: string } | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, query: url.searchParams, auth: headers.authorization ?? "" });
    if (method === "POST" && url.pathname.endsWith(`/${WABA}`) && url.searchParams.get("is_enabled_for_insights") === "true") {
      if (enableRefusal) return json({ error: { message: enableRefusal.message, code: enableRefusal.code } }, 400);
      return json({ success: true });
    }
    return json({ error: { message: "Unsupported request", code: 100 } }, 400);
  }) as typeof fetch;
}

describe("suite spec 11 — /v1/insights", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let ownerId: string;
  let admin: string;
  let manager: string;
  let noAccess: string;
  let pageRow: string;
  let igRow: string;
  /** Every response body this file has seen, to prove no token leaves the server. */
  const bodies: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads many response shapes
  async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, json: parsed };
  }
  async function download(cookie: string, path: string): Promise<{ status: number; text: string; type: string | null; disposition: string | null }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition") };
  }
  const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

  type Fig = [metric: string, day: string, value: number, breakdown?: string];
  async function figures(
    key: { source: string; accountKey: string; accountId: string | null; subjectId?: string; zone: string; running?: boolean },
    rows: Fig[],
  ): Promise<void> {
    await db.insert(insightMetricDaily).values(
      rows.map(([metric, day, value, breakdown]) => ({
        source: key.source,
        accountKey: key.accountKey,
        accountId: key.accountId,
        subjectId: key.subjectId ?? "",
        metric,
        day,
        dayZone: key.zone,
        breakdown: breakdown ?? "",
        value: String(value),
        isRunningTotal: key.running ?? false,
      })),
    );
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-key";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    ownerId = (await seedOwner(db)).id;
    await seedUser(db, { email: "admin@example.com", role: "admin" });
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    await seedUser(db, { email: "noinsights@example.com", role: "manager", revoked: ["insights.view"] });

    const lines = await db
      .insert(inboxPhoneNumber)
      .values([
        { kind: "messenger", e164: null, externalId: PAGE, pageExternalId: PAGE, externalName: "Mrs Samuel fruit juice", label: "Facebook Page", channels: "whatsapp" },
        { kind: "instagram", e164: null, externalId: IG, pageExternalId: PAGE, externalName: "mrs_samuelfruitjuice", label: "Instagram", channels: "whatsapp" },
        { e164: "+2348000000000", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: "109876543210987" },
      ])
      .returning({ id: inboxPhoneNumber.id, label: inboxPhoneNumber.label });
    pageRow = lines.find((l) => l.label === "Facebook Page")!.id;
    igRow = lines.find((l) => l.label === "Instagram")!.id;

    // ── Facebook Page (Pacific days) ──
    const page = { source: "facebook_page", accountKey: PAGE, accountId: pageRow, zone: PACIFIC };
    await figures(page, [
      ["page_media_view", "2026-11-08", 30],
      ["page_media_view", "2026-11-10", 100],
      // 11 Nov has no figure at all.
      ["page_media_view", "2026-11-12", 50],
    ]);
    await figures({ ...page, running: true }, [
      ["page_follows", "2026-11-09", 390],
      ["page_follows", "2026-11-10", 400],
      ["page_follows", "2026-11-11", 410],
    ]);

    // ── Instagram account (Lagos days) ──
    const ig = { source: "instagram_account", accountKey: IG, accountId: igRow, zone: LAGOS };
    await figures(ig, [
      ["views", "2026-11-10", 10],
      ["views", "2026-11-11", 0],
      ["views", "2026-11-12", 20],
      // Parts of the views above: never added to the whole.
      ["views", "2026-11-10", 6, "media_product_type=POST"],
      ["views", "2026-11-10", 4, "media_product_type=REEL"],
      ["reach", "2026-11-07", 10],
      ["reach", "2026-11-10", 40],
      ["reach", "2026-11-12", 60],
    ]);
    await figures({ ...ig, running: true }, [["followers_count", "2026-11-12", 540]]);

    // ── WhatsApp (UTC days; no channel-account row) ──
    const wa = { source: "whatsapp", accountKey: WABA, accountId: null, zone: "UTC" };
    await figures(wa, [
      ["wa_delivered", "2026-11-09", 5],
      ["wa_delivered", "2026-11-10", 8],
      ["wa_delivered", "2026-11-11", 9],
      ["wa_sent", "2026-11-10", 9],
      ["wa_sent", "2026-11-10", 3, "type=template"],
      ["wa_sent", "2026-11-10", 6, "type=free_form"],
      ["wa_cost", "2026-11-10", 0.25, "category=MARKETING;type=REGULAR"],
      ["wa_cost", "2026-11-11", 0.5, "category=MARKETING;type=REGULAR"],
      ["wa_cost", "2026-11-10", 0, "category=SERVICE;type=FREE_CUSTOMER_SERVICE"],
      ["wa_billable", "2026-11-10", 5, "category=MARKETING;type=REGULAR"],
      ["wa_billable", "2026-11-11", 10, "category=MARKETING;type=REGULAR"],
      ["wa_billable", "2026-11-10", 7, "category=SERVICE;type=FREE_CUSTOMER_SERVICE"],
    ]);

    // ── Posts ──
    await db.insert(insightSubject).values([
      { source: "facebook_post", accountKey: PAGE, subjectId: POST_1, kind: "post", title: "Mango day", permalink: "https://facebook.example/p/900001", publishedAt: new Date("2026-11-10T09:00:00Z") },
      // Removed at Facebook; it has no figures.
      { source: "facebook_post", accountKey: PAGE, subjectId: POST_2, kind: "post", title: "Old offer", permalink: null, publishedAt: new Date("2026-11-11T12:00:00Z"), goneAt: new Date("2026-11-12T10:00:00Z") },
      // 23:30 UTC on the 11th is 00:30 on the 12th in Lagos: inside a range that ends on the 12th.
      { source: "instagram_media", accountKey: IG, subjectId: MEDIA_1, kind: "feed", title: "Pineapple", permalink: "https://instagram.example/p/abc", publishedAt: new Date("2026-11-11T23:30:00Z") },
      // 23:30 UTC on the 12th is the 13th in Lagos: outside it.
      { source: "instagram_media", accountKey: IG, subjectId: MEDIA_2, kind: "reels", title: "Tomorrow's reel", permalink: null, publishedAt: new Date("2026-11-12T23:30:00Z") },
      { source: "whatsapp_template", accountKey: WABA, subjectId: TEMPLATE, kind: "template", title: "order_ready (en)", permalink: null, publishedAt: null },
    ]);
    const post = { source: "facebook_post", accountKey: PAGE, accountId: pageRow, subjectId: POST_1, zone: LAGOS, running: true };
    await figures(post, [
      ["post_media_view", "2026-11-11", 500],
      ["post_media_view", "2026-11-12", 900],
      ["post_total_media_view_unique", "2026-11-12", 600],
      ["post_reactions_total", "2026-11-12", 9],
      ["post_reactions_by_type_total", "2026-11-12", 7, "type=like"],
      ["post_clicks", "2026-11-12", 12],
    ]);
    await figures({ source: "instagram_media", accountKey: IG, accountId: igRow, subjectId: MEDIA_1, zone: LAGOS, running: true }, [
      ["views", "2026-11-12", 1200],
      ["reach", "2026-11-12", 700],
      ["total_interactions", "2026-11-12", 80],
      ["comments", "2026-11-12", 5],
    ]);
    await figures({ source: "instagram_media", accountKey: IG, accountId: igRow, subjectId: MEDIA_2, zone: LAGOS, running: true }, [["views", "2026-11-13", 99999]]);

    // ── Templates ──
    await figures({ source: "whatsapp_template", accountKey: WABA, accountId: null, subjectId: TEMPLATE, zone: "UTC" }, [
      ["tmpl_sent", "2026-11-10", 20],
      ["tmpl_sent", "2026-11-11", 10],
      ["tmpl_delivered", "2026-11-10", 19],
      ["tmpl_delivered", "2026-11-11", 9],
      ["tmpl_read", "2026-11-10", 14],
    ]);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    admin = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    noAccess = await loginAs(baseUrl, "noinsights@example.com", "userpassword123");
  }, 120_000);

  beforeEach(async () => {
    calls = [];
    enableRefusal = null;
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    await db.delete(auditLog).where(inArray(auditLog.action, AUDIT_ACTIONS));
    await db.delete(appSetting).where(eq(appSetting.key, INSIGHTS_STATE_KEY));
  });

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("403 without insights.view on every route", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", `/v1/insights/summary?${RANGE}`],
      ["GET", `/v1/insights/series?source=facebook_page&metric=page_media_view&${RANGE}`],
      ["GET", `/v1/insights/posts?${RANGE}`],
      ["GET", `/v1/insights/whatsapp?${RANGE}`],
      ["GET", `/v1/insights/export.csv?${RANGE}`],
      ["GET", "/v1/insights/status"],
      ["POST", "/v1/insights/refresh"],
      ["POST", "/v1/insights/whatsapp/template-analytics", { waba_id: WABA, confirm: true }],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(noAccess, method, path, body)).status, `${method} ${path}`).toBe(403);
      expect((await call("", method, path, body)).status, `signed out: ${method} ${path}`).toBe(401);
    }
    expect(calls).toHaveLength(0);
    expect(await audits("insights.refresh")).toHaveLength(0);
    // A manager and an admin hold insights.view by default.
    expect((await call(manager, "GET", "/v1/insights/status")).status).toBe(200);
    expect((await call(admin, "GET", "/v1/insights/status")).status).toBe(200);
  });

  it("summary: sums flows, takes latest for followers, averages reach, null when no rows", async () => {
    const res = await call(manager, "GET", `/v1/insights/summary?${RANGE}`);
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.range).toEqual({ from: "2026-11-10", to: "2026-11-12" });
    const tiles = Object.fromEntries((d.tiles as Obj[]).map((t) => [t.key as string, t]));
    expect((d.tiles as Obj[]).map((t) => t.key)).toEqual([
      "fb_views",
      "fb_followers",
      "fb_engagement",
      "ig_views",
      "ig_reach",
      "ig_followers",
      "ig_interactions",
      "wa_delivered",
      "wa_cost",
    ]);
    // Flows are added up; the day with no figure adds nothing.
    expect(tiles.fb_views).toEqual({ key: "fb_views", label: "Facebook views", value: 150, previous: 30, how: "sum", note: null });
    // A running total is the latest value in each period, never a sum.
    expect(tiles.fb_followers).toMatchObject({ value: 410, previous: 390, how: "latest" });
    // No stored figure is null, never zero.
    expect(tiles.fb_engagement).toMatchObject({ value: null, previous: null, how: "sum" });
    // The whole only: its parts (by type of content) are not added to it. A stored zero counts as zero.
    expect(tiles.ig_views).toMatchObject({ value: 30, previous: null, how: "sum" });
    // People reached: the average of the days that have a figure (40 and 60), never the sum.
    expect(tiles.ig_reach).toMatchObject({ value: 50, previous: 10, how: "daily_average" });
    expect(tiles.ig_reach!.note).toBe(
      "This is the average for a day. People reached on different days cannot be added up, because the same person may be counted on each day.",
    );
    expect(tiles.ig_followers).toMatchObject({ value: 540, previous: null, how: "latest" });
    expect(tiles.ig_interactions).toMatchObject({ value: null, previous: null });
    expect(tiles.wa_delivered).toMatchObject({ value: 17, previous: 5, how: "sum" });
    // Charges: every category and type added up (0.25 + 0.5 + 0).
    expect(tiles.wa_cost).toMatchObject({ value: 0.75, previous: null, how: "sum" });
    expect(d.cost_currency).toBeNull();

    expect((d.sources as Obj[]).map((s) => [s.source, s.account_key, (s.problem as Obj | null)?.code ?? null])).toEqual([
      ["facebook_page", PAGE, null],
      ["facebook_post", PAGE, null],
      ["instagram_account", IG, null],
      ["instagram_media", IG, null],
      ["whatsapp", WABA, null],
      ["whatsapp_template", WABA, "not_enabled"],
    ]);
    expect(calls).toHaveLength(0);
  });

  it("summary: previous period is the same length immediately before", async () => {
    const three = await call(manager, "GET", `/v1/insights/summary?${RANGE}`);
    expect(three.json.data.previous).toEqual({ from: "2026-11-07", to: "2026-11-09" });
    const thirty = await call(manager, "GET", "/v1/insights/summary?from=2026-10-01&to=2026-10-30");
    expect(thirty.json.data.previous).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    const one = await call(manager, "GET", "/v1/insights/summary?from=2026-11-10&to=2026-11-10");
    expect(one.json.data.previous).toEqual({ from: "2026-11-09", to: "2026-11-09" });
    // The day before is the whole previous period: 390 followers then, 400 on the day.
    const followers = (one.json.data.tiles as Obj[]).find((t) => t.key === "fb_followers")!;
    expect(followers).toMatchObject({ value: 400, previous: 390 });

    // Bad ranges.
    const backwards = await call(manager, "GET", "/v1/insights/summary?from=2026-11-12&to=2026-11-10");
    expect(backwards.status).toBe(400);
    expect(backwards.json.error.message).toBe("Pick a range of up to 400 days");
    const long = await call(manager, "GET", "/v1/insights/summary?from=2025-10-08&to=2026-11-12");
    expect(long.status).toBe(400);
    expect(long.json.error.message).toBe("Pick a range of up to 400 days");
    // Exactly 400 days is allowed (9 Oct 2025 to 12 Nov 2026).
    expect((await call(manager, "GET", "/v1/insights/summary?from=2025-10-09&to=2026-11-12")).status).toBe(200);
    expect((await call(manager, "GET", "/v1/insights/summary?from=2026-02-30&to=2026-03-02")).status).toBe(400);
    expect((await call(manager, "GET", "/v1/insights/summary")).status).toBe(400);
  });

  it("series: fills gaps with null and reports day_zone", async () => {
    const res = await call(manager, "GET", `/v1/insights/series?source=facebook_page&metric=page_media_view&${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      source: "facebook_page",
      metric: "page_media_view",
      day_zone: PACIFIC,
      is_running_total: false,
      points: [
        { day: "2026-11-10", value: 100 },
        { day: "2026-11-11", value: null },
        { day: "2026-11-12", value: 50 },
      ],
    });

    const followers = await call(manager, "GET", `/v1/insights/series?source=facebook_page&metric=page_follows&${RANGE}`);
    expect(followers.json.data.is_running_total).toBe(true);
    expect(followers.json.data.points.map((p: Obj) => p.value)).toEqual([400, 410, null]);

    // A stored zero stays zero; the whole does not include its parts.
    const views = await call(manager, "GET", `/v1/insights/series?source=instagram_account&metric=views&${RANGE}`);
    expect(views.json.data.day_zone).toBe(LAGOS);
    expect(views.json.data.points.map((p: Obj) => p.value)).toEqual([10, 0, 20]);

    // breakdown=*: one series per part, without the whole.
    const parts = await call(manager, "GET", `/v1/insights/series?source=instagram_account&metric=views&breakdown=*&${RANGE}`);
    expect(parts.status).toBe(200);
    expect(parts.json.data.points).toBeUndefined();
    expect(parts.json.data.series).toEqual([
      { breakdown: "media_product_type=POST", points: [{ day: "2026-11-10", value: 6 }, { day: "2026-11-11", value: null }, { day: "2026-11-12", value: null }] },
      { breakdown: "media_product_type=REEL", points: [{ day: "2026-11-10", value: 4 }, { day: "2026-11-11", value: null }, { day: "2026-11-12", value: null }] },
    ]);
    const onePart = await call(manager, "GET", `/v1/insights/series?source=whatsapp&metric=wa_sent&breakdown=${encodeURIComponent("type=template")}&${RANGE}`);
    expect(onePart.json.data.points.map((p: Obj) => p.value)).toEqual([3, null, null]);

    // Nothing stored for these dates: every day null, and the zone this source uses.
    const empty = await call(manager, "GET", "/v1/insights/series?source=whatsapp&metric=wa_delivered&from=2026-01-01&to=2026-01-02");
    expect(empty.json.data).toMatchObject({ day_zone: "UTC", points: [{ day: "2026-01-01", value: null }, { day: "2026-01-02", value: null }] });

    // Unknown source or metric, and sources that are per post (never summed into a series).
    for (const q of [
      "source=twitter&metric=views",
      "source=facebook_page&metric=page_impressions",
      "source=facebook_post&metric=post_media_view",
      "source=instagram_account&metric=page_media_view",
      "metric=views",
    ]) {
      expect((await call(manager, "GET", `/v1/insights/series?${q}&${RANGE}`)).status, q).toBe(400);
    }
  });

  it("posts: returns latest running totals, sorted by views", async () => {
    const res = await call(manager, "GET", `/v1/insights/posts?${RANGE}`);
    expect(res.status).toBe(200);
    // The Instagram post published at 00:30 Lagos time on the 12th is in; the one on the 13th is out.
    expect(res.json.data).toEqual([
      {
        network: "instagram",
        subject_id: MEDIA_1,
        kind: "feed",
        title: "Pineapple",
        permalink: "https://instagram.example/p/abc",
        published_at: "2026-11-11T23:30:00.000Z",
        from_suite: false,
        removed: false,
        views: 1200,
        reach: 700,
        interactions: 80,
        comments: 5,
        clicks: null,
      },
      {
        network: "facebook",
        subject_id: POST_1,
        kind: "post",
        title: "Mango day",
        permalink: "https://facebook.example/p/900001",
        published_at: "2026-11-10T09:00:00.000Z",
        from_suite: false,
        removed: false,
        // The newer of the two stored totals (900 on the 12th, not 500 on the 11th, and not their sum).
        views: 900,
        reach: 600,
        interactions: 9,
        comments: null,
        clicks: 12,
      },
      {
        network: "facebook",
        subject_id: POST_2,
        kind: "post",
        title: "Old offer",
        permalink: null,
        published_at: "2026-11-11T12:00:00.000Z",
        from_suite: false,
        removed: true,
        views: null,
        reach: null,
        interactions: null,
        comments: null,
        clicks: null,
      },
    ]);

    const byDate = await call(manager, "GET", `/v1/insights/posts?${RANGE}&network=facebook&sort=date`);
    expect(byDate.json.data.map((p: Obj) => p.subject_id)).toEqual([POST_2, POST_1]);
    const instagram = await call(manager, "GET", `/v1/insights/posts?${RANGE}&network=instagram&sort=reach`);
    expect(instagram.json.data.map((p: Obj) => p.subject_id)).toEqual([MEDIA_1]);
    const top = await call(manager, "GET", `/v1/insights/posts?${RANGE}&limit=1`);
    expect(top.json.data.map((p: Obj) => p.subject_id)).toEqual([MEDIA_1]);
    expect((await call(manager, "GET", "/v1/insights/posts?from=2026-01-01&to=2026-01-31")).json.data).toEqual([]);
    for (const bad of ["limit=500", "limit=0", "sort=likes", "network=tiktok"]) {
      expect((await call(manager, "GET", `/v1/insights/posts?${RANGE}&${bad}`)).status, bad).toBe(400);
    }
  });

  it("posts: a post published from the suite is marked once spec 09's table exists", async () => {
    const { resetInsightsSuitePostCheck } = await import("../../src/routes/insights.js");
    const found = (await db.execute(sql`select to_regclass('social_post_target')::text as t`)) as unknown as { t: string | null }[];
    // When spec 09 has landed the table is its own (with its own columns); this check is then spec 09's to make.
    if (found[0]?.t != null) return;
    await db.execute(sql`create table "social_post_target" ("external_id" text)`);
    try {
      await db.execute(sql`insert into "social_post_target" ("external_id") values (${POST_1})`);
      resetInsightsSuitePostCheck();
      const res = await call(manager, "GET", `/v1/insights/posts?${RANGE}`);
      expect(res.status).toBe(200);
      expect(res.json.data.map((p: Obj) => [p.subject_id, p.from_suite])).toEqual([
        [MEDIA_1, false],
        [POST_1, true],
        [POST_2, false],
      ]);
    } finally {
      await db.execute(sql`drop table "social_post_target"`);
      resetInsightsSuitePostCheck();
    }
    const after = await call(manager, "GET", `/v1/insights/posts?${RANGE}`);
    expect(after.json.data.every((p: Obj) => p.from_suite === false)).toBe(true);
  });

  it("whatsapp: messages by type, charges added up by category, templates, and UTC days", async () => {
    const res = await call(manager, "GET", `/v1/insights/whatsapp?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      day_zone: "UTC",
      by_type: [
        { day: "2026-11-10", template: 3, free_form: 6, delivered: 8 },
        { day: "2026-11-11", template: null, free_form: null, delivered: 9 },
        { day: "2026-11-12", template: null, free_form: null, delivered: null },
      ],
      pricing: [
        { category: "MARKETING", type: "REGULAR", volume: 15, cost: 0.75 },
        { category: "SERVICE", type: "FREE_CUSTOMER_SERVICE", volume: 7, cost: 0 },
      ],
      cost_currency: null,
      // No click figure was stored, so it is null, not zero. Read rate is read / delivered.
      templates: [{ template_id: TEMPLATE, name: "order_ready (en)", sent: 30, delivered: 28, read: 14, clicked: null, read_rate: 0.5 }],
      template_analytics: "off",
      accounts: [{ waba_id: WABA, template_analytics: "off" }],
    });
    expect(calls).toHaveLength(0);
  });

  it("export.csv: has the header row, one line per stored figure, and an audit entry", async () => {
    const res = await download(manager, `/v1/insights/export.csv?${RANGE}&source=facebook_page`);
    expect(res.status).toBe(200);
    expect(res.type).toContain("text/csv");
    expect(res.disposition).toBe('attachment; filename="insights-2026-11-10-to-2026-11-12.csv"');
    expect(res.text.split("\r\n")).toEqual([
      "source,account,item,item_link,metric,breakdown,day,day_time_zone,value,running_total",
      "facebook_page,Facebook Page,,,page_follows,,2026-11-10,America/Los_Angeles,400,yes",
      "facebook_page,Facebook Page,,,page_follows,,2026-11-11,America/Los_Angeles,410,yes",
      "facebook_page,Facebook Page,,,page_media_view,,2026-11-10,America/Los_Angeles,100,no",
      // No line for 11 Nov: a missing figure is not written as zero.
      "facebook_page,Facebook Page,,,page_media_view,,2026-11-12,America/Los_Angeles,50,no",
      "",
    ]);
    const logged = await audits("insights.export");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.entityType).toBe("insight");
    expect(logged[0]!.entityId).toBe("export");
    expect(logged[0]!.afterJson).toEqual({ from: "2026-11-10", to: "2026-11-12", source: "facebook_page", rows: 4 });

    // Every source: one line per stored figure in the range.
    const [stored] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(insightMetricDaily)
      .where(and(gte(insightMetricDaily.day, "2026-11-10"), lte(insightMetricDaily.day, "2026-11-12")));
    const all = await download(manager, `/v1/insights/export.csv?${RANGE}`);
    const lines = all.text.split("\r\n").filter((l) => l !== "");
    expect(lines).toHaveLength(stored!.n + 1);
    // A post's line carries its title and link; a WhatsApp line its account ID, a decimal charge and its breakdown.
    expect(lines).toContain("facebook_post,Facebook Page,Mango day,https://facebook.example/p/900001,post_media_view,,2026-11-12,Africa/Lagos,900,yes");
    expect(lines).toContain(`whatsapp,${WABA},,,wa_cost,category=MARKETING;type=REGULAR,2026-11-10,UTC,0.25,no`);
    expect(lines).toContain(`whatsapp_template,${WABA},order_ready (en),,tmpl_sent,,2026-11-10,UTC,20,no`);
    expect(await audits("insights.export")).toHaveLength(2);

    expect((await download(manager, `/v1/insights/export.csv?${RANGE}&source=twitter`)).status).toBe(400);
  });

  it("status: shows when the figures were collected and each source's problem in plain words", async () => {
    const empty = await call(manager, "GET", "/v1/insights/status");
    expect(empty.status).toBe(200);
    expect(empty.json.data).toMatchObject({ last_run_at: null, last_daily_run_day: null, refresh_requested_at: null });

    await patchInsightsState(db, { last_run_at: "2026-11-12T09:04:00.000Z", last_daily_run_day: "2026-11-12" });
    await saveInsightsSourceState(db, `facebook_page:${PAGE}`, {
      last_ok_at: null,
      backfilled: false,
      problem_code: "too_small",
      problem_message: "Facebook only shares these figures once the Page has 100 likes, and only with permission to read them.",
      invalid_metrics: [],
    });
    await saveInsightsSourceState(db, `whatsapp:${WABA}`, {
      last_ok_at: "2026-11-12T09:04:00.000Z",
      backfilled: true,
      problem_code: null,
      problem_message: null,
      invalid_metrics: [],
    });
    const res = await call(manager, "GET", "/v1/insights/status");
    expect(res.json.data).toMatchObject({ last_run_at: "2026-11-12T09:04:00.000Z", last_daily_run_day: "2026-11-12", refresh_requested_at: null });
    const sources = res.json.data.sources as Obj[];
    expect(sources.find((s) => s.source === "facebook_page")).toEqual({
      source: "facebook_page",
      account_key: PAGE,
      label: "Facebook Page: Facebook Page",
      last_ok_at: null,
      problem: { code: "too_small", message: "Facebook only shares these figures once the Page has 100 likes, and only with permission to read them." },
    });
    expect(sources.find((s) => s.source === "whatsapp")).toEqual({
      source: "whatsapp",
      account_key: WABA,
      label: "WhatsApp messages",
      last_ok_at: "2026-11-12T09:04:00.000Z",
      problem: null,
    });
    expect(sources.find((s) => s.source === "whatsapp_template")!.problem).toEqual({ code: "not_enabled", message: "Template figures are switched off at WhatsApp." });
  });

  it("refresh: second call within 10 minutes is 429", async () => {
    const first = await call(manager, "POST", "/v1/insights/refresh");
    expect(first.status).toBe(200);
    const requestedAt = first.json.data.requested_at as string;
    expect(new Date(requestedAt).toISOString()).toBe(requestedAt);
    expect((await readInsightsState(db)).refresh_requested_at).toBe(requestedAt);
    expect((await call(manager, "GET", "/v1/insights/status")).json.data.refresh_requested_at).toBe(requestedAt);
    const logged = await audits("insights.refresh");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.actorRole).toBe("manager");

    const second = await call(admin, "POST", "/v1/insights/refresh");
    expect(second.status).toBe(429);
    expect(second.json.error.code).toBe("rate_limited");
    expect(second.json.error.message).toBe("Figures were refreshed a few minutes ago. Try again shortly.");
    expect((await readInsightsState(db)).refresh_requested_at).toBe(requestedAt);
    expect(await audits("insights.refresh")).toHaveLength(1);

    // A collection that finished 5 minutes ago also counts; one from 11 minutes ago does not.
    await patchInsightsState(db, { refresh_requested_at: null, last_run_at: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect((await call(manager, "POST", "/v1/insights/refresh")).status).toBe(429);
    await patchInsightsState(db, { refresh_requested_at: null, last_run_at: new Date(Date.now() - 11 * 60_000).toISOString() });
    expect((await call(manager, "POST", "/v1/insights/refresh")).status).toBe(200);
    // Refresh never calls Meta itself: the worker does the collecting.
    expect(calls).toHaveLength(0);
  });

  it("template-analytics: admin is refused; owner succeeds, calls POST /{waba}?is_enabled_for_insights=true, and is audited", async () => {
    const path = "/v1/insights/whatsapp/template-analytics";
    const refused = await call(admin, "POST", path, { waba_id: WABA, confirm: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toBe("Only the owner can turn this on");
    expect((await call(manager, "POST", path, { waba_id: WABA, confirm: true })).status).toBe(403);

    // The owner must confirm, and may only name a WhatsApp account that is connected here.
    for (const body of [{ waba_id: WABA }, { waba_id: WABA, confirm: false }, { confirm: true }, { waba_id: "999999999999", confirm: true }, { waba_id: WABA, confirm: true, extra: 1 }]) {
      expect((await call(owner, "POST", path, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect(await audits("insights.template_analytics_enable")).toHaveLength(0);

    // WhatsApp refuses: nothing is recorded as on.
    enableRefusal = { code: 100, message: "(#100) Template insights cannot be enabled for this account" };
    const failed = await call(owner, "POST", path, { waba_id: WABA, confirm: true });
    expect(failed.status).toBe(502);
    expect(failed.json.error.code).toBe("service_unavailable");
    expect(failed.json.error.message).toBe("WhatsApp did not accept this: (#100) Template insights cannot be enabled for this account");
    expect(failed.json.error.details).toMatchObject({ reason: "meta_refused", meta_code: "100" });
    expect((await readInsightsState(db)).template_analytics).toEqual({});
    expect(await audits("insights.template_analytics_enable")).toHaveLength(0);
    expect(calls).toHaveLength(1);

    // WhatsApp accepts.
    enableRefusal = null;
    calls = [];
    const ok = await call(owner, "POST", path, { waba_id: WABA, confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ template_analytics: "on" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(`/v23.0/${WABA}`);
    expect(calls[0]!.query.get("is_enabled_for_insights")).toBe("true");
    expect(calls[0]!.auth).toBe(`Bearer ${SYSTEM_TOKEN}`);
    const state = await readInsightsState(db);
    expect(Object.keys(state.template_analytics)).toEqual([WABA]);
    expect(state.template_analytics[WABA]!.enabled_by).toBe(ownerId);
    const logged = await audits("insights.template_analytics_enable");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.actorRole).toBe("owner");
    expect(logged[0]!.actorUserId).toBe(ownerId);
    expect(logged[0]!.entityId).toBe(WABA);
    expect(logged[0]!.afterJson).toEqual({ waba_id: WABA, permanent: true });

    // The screens now say it is on, and asking again sends nothing to WhatsApp.
    const wa = await call(manager, "GET", `/v1/insights/whatsapp?${RANGE}`);
    expect(wa.json.data.template_analytics).toBe("on");
    expect(wa.json.data.accounts).toEqual([{ waba_id: WABA, template_analytics: "on" }]);
    const status = await call(manager, "GET", "/v1/insights/status");
    expect((status.json.data.sources as Obj[]).find((s) => s.source === "whatsapp_template")!.problem).toBeNull();
    const again = await call(owner, "POST", path, { waba_id: WABA, confirm: true });
    expect(again.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await audits("insights.template_analytics_enable")).toHaveLength(1);
  });

  it('no response contains the string "itest-token"', async () => {
    // Touch every read route once more with the token in place, then look at everything this file received.
    for (const path of [`/v1/insights/summary?${RANGE}`, `/v1/insights/whatsapp?${RANGE}`, `/v1/insights/posts?${RANGE}`, "/v1/insights/status"]) {
      await call(owner, "GET", path);
    }
    await download(owner, `/v1/insights/export.csv?${RANGE}`);
    expect(bodies.length).toBeGreaterThan(40);
    expect(bodies.some((b) => b.includes("itest-token"))).toBe(false);
    const state = await db.select().from(appSetting).where(eq(appSetting.key, INSIGHTS_STATE_KEY));
    expect(JSON.stringify(state)).not.toContain("itest-token");
  });
});
