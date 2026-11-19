import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DbClient } from "@ms/db";
import type { InsightSource, MetricRow } from "@ms/shared";
import {
  EMPTY_SOURCE_STATE,
  classifyInsightsError,
  enableTemplateAnalytics,
  fetchTemplateAnalytics,
  fetchWaAnalytics,
  normaliseInsightsState,
  runInsightsCollection,
  type InsightSubjectInput,
  type InsightsSourceState,
  type InsightsState,
  type InsightsStore,
  type MetricKey,
} from "./insights.js";
import { clearPageTokenCache } from "./accounts.js";
import { MetaApiError } from "../inbox/meta.js";

/**
 * The collector, with Meta stubbed (never the real Graph API) and the store held in
 * memory, so these run without a database. Tokens here are obviously fake. Every run
 * gets a fixed "now": nothing depends on the wall clock or the machine's time zone.
 */

const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const PAGE = "100200300400";
const IG = "17841400000000001";
const WABA = "104857600123456";
const POST = `${PAGE}_900001`;
const MEDIA = "17900000000000001";
const STORY = "17900000000000002";
const TEMPLATE = "1924084211297547";
/** 11:30 in Lagos, 02:30 in Los Angeles, 10:30 UTC on Thursday 19 Nov 2026. */
const NOW = new Date("2026-11-19T10:30:00Z");
const log = { info: () => {}, warn: () => {}, error: () => {} };
const noDb = null as unknown as DbClient;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const metaError = (code: number, message: string, status = 400): Response => json({ error: { message, code } }, status);

// ── A store in memory ────────────────────────────────────────────────────────

interface Memory extends InsightsStore {
  rows: Map<string, { key: MetricKey; row: MetricRow }>;
  subjectRows: Map<string, InsightSubjectInput & { source: string; accountKey: string; gone: boolean }>;
  state: InsightsState;
  alerts: (Record<string, unknown> & { account: string })[];
}

function memoryStore(opts: { templatesOn?: boolean; instagram?: boolean; page?: boolean; whatsapp?: boolean } = {}): Memory {
  const state = normaliseInsightsState(
    opts.templatesOn ? { template_analytics: { [WABA]: { enabled_at: "2026-11-01T00:00:00.000Z", enabled_by: "owner" } } } : null,
  );
  const m: Memory = {
    rows: new Map(),
    subjectRows: new Map(),
    state,
    alerts: [],
    pages: async () =>
      opts.page === false ? [] : [{ id: "11111111-1111-4111-8111-111111111111", label: "Facebook Page", externalId: PAGE, pageId: PAGE }],
    instagramAccounts: async () =>
      opts.instagram === false ? [] : [{ id: "22222222-2222-4222-8222-222222222222", label: "Instagram", externalId: IG, pageId: PAGE }],
    wabaIds: async () => (opts.whatsapp === false ? [] : [WABA]),
    readState: async () => structuredClone(m.state),
    saveSourceState: async (key: string, value: InsightsSourceState) => {
      m.state.sources[key] = structuredClone(value);
    },
    saveCurrency: async (wabaId: string, currency: string) => {
      m.state.currencies = { ...(m.state.currencies ?? {}), [wabaId]: currency };
    },
    saveRows: async (key: MetricKey, rows: MetricRow[]) => {
      // The same rule as the table's unique index: one value per figure per day; a second write replaces it.
      for (const row of rows) m.rows.set([key.source, key.accountKey, key.subjectId, row.metric, row.day, row.breakdown].join("|"), { key, row });
      return rows.length;
    },
    upsertSubjects: async (source: InsightSource, accountKey: string, subjects: InsightSubjectInput[]) => {
      for (const s of subjects) {
        const id = `${source}|${s.subjectId}`;
        m.subjectRows.set(id, { ...s, source, accountKey, gone: m.subjectRows.get(id)?.gone ?? false });
      }
    },
    subjects: async (source: InsightSource, accountKey: string, since: Date) =>
      [...m.subjectRows.values()]
        .filter((s) => s.source === source && s.accountKey === accountKey && s.publishedAt !== null && s.publishedAt >= since)
        .map((s) => ({ subjectId: s.subjectId, kind: s.kind, gone: s.gone })),
    markGone: async (source: InsightSource, subjectId: string) => {
      const hit = m.subjectRows.get(`${source}|${subjectId}`);
      if (hit) hit.gone = true;
    },
    alertOnce: async (payload) => {
      if (!m.alerts.some((a) => a.account === payload.account)) m.alerts.push(payload);
    },
  };
  return m;
}

// ── Meta, stubbed ────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
}
let calls: Call[] = [];
/** Return a Response to answer a call differently from the default; undefined to fall through. */
let override: ((c: Call) => Response | undefined) | null = null;

const unix = (iso: string): number => Date.parse(iso) / 1000;

function defaultAnswer(c: Call): Response {
  const q = c.query;
  const fields = q.get("fields") ?? "";
  if (c.path === PAGE && fields === "access_token") return json({ access_token: "PAGE-TOKEN-TEST" });

  if (c.path === `${PAGE}/insights`) {
    const metrics = (q.get("metric") ?? "").split(",");
    return json({
      data: metrics.map((name, i) => ({
        name,
        period: "day",
        values: [
          { value: 10 + i, end_time: "2026-11-18T08:00:00+0000" },
          { value: 20 + i, end_time: "2026-11-19T08:00:00+0000" },
        ],
      })),
    });
  }
  if (c.path === `${PAGE}/feed`) {
    return json({
      data: [{ id: POST, message: "Fresh mango today", created_time: "2026-11-10T09:00:00+0000", permalink_url: "https://facebook.example/p/900001", is_published: true }],
    });
  }
  if (c.path === `${POST}/insights`) {
    return json({
      data: [
        { name: "post_media_view", period: "lifetime", values: [{ value: 900 }] },
        { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 600 }] },
        { name: "post_clicks", period: "lifetime", values: [{ value: 12 }] },
        { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 7, love: 2 } }] },
        { name: "post_video_views", period: "lifetime", values: [{ value: 0 }] },
      ],
    });
  }

  if (c.path === `${IG}/insights`) {
    const metrics = (q.get("metric") ?? "").split(",");
    const breakdown = q.get("breakdown");
    if (breakdown === "media_product_type") {
      return json({
        data: metrics.map((name) => ({
          name,
          period: "day",
          total_value: { value: 30, breakdowns: [{ dimension_keys: ["media_product_type"], results: [{ dimension_values: ["POST"], value: 20 }, { dimension_values: ["REEL"], value: 10 }] }] },
        })),
      });
    }
    if (breakdown === "follow_type") {
      return json({
        data: [
          {
            name: "follows_and_unfollows",
            period: "day",
            total_value: { breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 3 }, { dimension_values: ["NON_FOLLOWER"], value: 1 }] }] },
          },
        ],
      });
    }
    return json({ data: metrics.map((name, i) => ({ name, period: "day", total_value: { value: 100 + i } })) });
  }
  if (c.path === IG && fields === "followers_count,media_count") return json({ followers_count: 540, media_count: 61, id: IG });
  if (c.path === `${IG}/media`) {
    return json({
      data: [{ id: MEDIA, caption: "Pineapple and ginger", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://instagram.example/p/abc", timestamp: "2026-11-12T08:00:00+0000" }],
    });
  }
  if (c.path === `${IG}/stories`) return json({ data: [{ id: STORY, media_type: "IMAGE", permalink: "https://instagram.example/s/1", timestamp: "2026-11-19T06:00:00+0000" }] });
  if (c.path === `${MEDIA}/insights` || c.path === `${STORY}/insights`) {
    return json({ data: (q.get("metric") ?? "").split(",").map((name, i) => ({ name, period: "lifetime", total_value: { value: 40 + i } })) });
  }

  if (c.path === WABA && fields.startsWith("analytics.")) {
    return json({
      id: WABA,
      analytics: {
        granularity: "DAY",
        data_points: [
          { start: unix("2026-11-17T00:00:00Z"), end: unix("2026-11-18T00:00:00Z"), sent: 12, delivered: 11 },
          { start: unix("2026-11-18T00:00:00Z"), end: unix("2026-11-19T00:00:00Z"), sent: 5, delivered: 5 },
        ],
      },
    });
  }
  if (c.path === WABA && fields.startsWith("pricing_analytics.")) {
    return json({
      id: WABA,
      pricing_analytics: {
        data: [{ data_points: [{ start: unix("2026-11-17T00:00:00Z"), end: unix("2026-11-18T00:00:00Z"), pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 4, cost: 0.2 }] }],
      },
    });
  }
  if (c.path === WABA && fields === "currency") return json({ currency: "USD", id: WABA });
  if (c.path === `${WABA}/message_templates`) return json({ data: [{ id: TEMPLATE, name: "order_ready", language: "en", status: "APPROVED" }] });
  if (c.path === `${WABA}/template_analytics`) {
    return json({
      data: [
        {
          granularity: "DAILY",
          data_points: [{ template_id: TEMPLATE, start: unix("2026-11-17T00:00:00Z"), end: unix("2026-11-18T00:00:00Z"), sent: 20, delivered: 19, read: 12, clicked: [{ type: "url_button", button_content: "Order", count: 4 }] }],
        },
      ],
    });
  }
  return metaError(100, `Unsupported get request: ${c.path}`);
}

const run = (store: Memory, extra: { storiesOnly?: boolean; now?: Date } = {}) =>
  runInsightsCollection(noDb, cfg, log, { now: NOW, sleepMs: 0, store, ...extra });

const callsTo = (path: string): Call[] => calls.filter((c) => c.path === path);
const rowsOf = (store: Memory, source: string): { key: MetricKey; row: MetricRow }[] => [...store.rows.values()].filter((r) => r.key.source === source);

beforeEach(() => {
  clearPageTokenCache();
  calls = [];
  override = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const c: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: decodeURIComponent(url.pathname.replace(/^\/v[\d.]+\//, "")),
        query: url.searchParams,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
      };
      calls.push(c);
      return override?.(c) ?? defaultAnswer(c);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runInsightsCollection", () => {
  it("runInsightsCollection: first run asks the Page for 90 days, second run for 7", async () => {
    const store = memoryStore();
    await run(store);
    const first = callsTo(`${PAGE}/insights`);
    expect(first).toHaveLength(1);
    // Pacific "yesterday" is 18 Nov; 90 days back is 21 Aug; until is exclusive.
    expect(first[0]!.query.get("since")).toBe("2026-08-21");
    expect(first[0]!.query.get("until")).toBe("2026-11-19");
    expect(first[0]!.query.get("period")).toBe("day");
    expect(first[0]!.auth).toBe("Bearer PAGE-TOKEN-TEST");
    expect(store.state.sources[`facebook_page:${PAGE}`]).toMatchObject({ backfilled: true, problem_code: null, last_ok_at: NOW.toISOString() });

    calls = [];
    await run(store);
    const second = callsTo(`${PAGE}/insights`);
    expect(second).toHaveLength(1);
    expect(second[0]!.query.get("since")).toBe("2026-11-12");
    expect(second[0]!.query.get("until")).toBe("2026-11-19");

    // What was stored: Pacific days, page_follows as a running total, values as Meta gave them.
    const page = rowsOf(store, "facebook_page");
    expect(page).toHaveLength(16);
    const views = page.filter((r) => r.row.metric === "page_media_view").map((r) => [r.row.day, r.row.value, r.row.dayZone, r.row.isRunningTotal]);
    expect(views).toEqual([
      ["2026-11-17", 10, "America/Los_Angeles", false],
      ["2026-11-18", 20, "America/Los_Angeles", false],
    ]);
    expect(page.find((r) => r.row.metric === "page_follows")!.row.isRunningTotal).toBe(true);
    expect(page[0]!.key).toEqual({ source: "facebook_page", accountKey: PAGE, accountId: "11111111-1111-4111-8111-111111111111", subjectId: "" });
  });

  it("collects posts, Instagram and WhatsApp with the windows the spec gives, and only reads", async () => {
    const store = memoryStore();
    const result = await run(store);
    expect(result.problems).toBe(0);
    expect(result.written).toBeGreaterThan(0);
    // Nothing is ever written to Meta by the collector.
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    // Post: running totals for today's Lagos day, with the total of the reaction types.
    const post = rowsOf(store, "facebook_post");
    expect(post.every((r) => r.key.subjectId === POST && r.row.day === "2026-11-19" && r.row.isRunningTotal && r.row.dayZone === "Africa/Lagos")).toBe(true);
    expect(post.find((r) => r.row.metric === "post_reactions_total")!.row.value).toBe(9);
    expect(store.subjectRows.get(`facebook_post|${POST}`)).toMatchObject({ kind: "post", title: "Fresh mango today", permalink: "https://facebook.example/p/900001" });

    // Instagram account: 30 Lagos days ending yesterday, three calls a day, each for one Lagos day.
    const ig = callsTo(`${IG}/insights`);
    expect(ig).toHaveLength(90);
    const plain = ig.filter((c) => !c.query.get("breakdown"));
    expect(plain).toHaveLength(30);
    expect(plain[0]!.query.get("metric")).toBe("reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,reposts,profile_links_taps");
    expect(plain[0]!.query.get("metric_type")).toBe("total_value");
    // 20 Oct 2026 Lagos starts at 19 Oct 23:00 UTC; 18 Nov is the last day asked for.
    expect(Number(plain[0]!.query.get("since"))).toBe(unix("2026-10-19T23:00:00Z"));
    expect(Number(plain[29]!.query.get("since"))).toBe(unix("2026-11-17T23:00:00Z"));
    expect(Number(plain[29]!.query.get("until"))).toBe(unix("2026-11-18T23:00:00Z"));
    const igRows = rowsOf(store, "instagram_account");
    expect(igRows.filter((r) => r.row.metric === "views" && r.row.breakdown === "")).toHaveLength(30);
    expect(igRows.filter((r) => r.row.metric === "views" && r.row.breakdown === "media_product_type=REEL")).toHaveLength(30);
    expect(igRows.filter((r) => r.row.metric === "follows_and_unfollows" && r.row.breakdown === "follow_type=FOLLOWER")).toHaveLength(30);
    expect(igRows.find((r) => r.row.metric === "followers_count")!.row).toMatchObject({ day: "2026-11-19", value: 540, isRunningTotal: true });

    // Instagram media: a feed post asks for the feed figures; the live story for the story figures.
    expect(callsTo(`${MEDIA}/insights`)[0]!.query.get("metric")).toBe("reach,views,likes,comments,shares,saved,total_interactions");
    expect(callsTo(`${STORY}/insights`)[0]!.query.get("metric")).toBe("reach,views,replies,shares,total_interactions");
    expect(store.subjectRows.get(`instagram_media|${MEDIA}`)).toMatchObject({ kind: "feed", title: "Pineapple and ginger" });
    expect(store.subjectRows.get(`instagram_media|${STORY}`)).toMatchObject({ kind: "story" });

    // WhatsApp: system-user token, whole UTC days ending at midnight today, 90 days the first time.
    const wa = callsTo(WABA).filter((c) => (c.query.get("fields") ?? "").startsWith("analytics."));
    expect(wa.map((c) => c.query.get("fields"))).toEqual([
      `analytics.start(${unix("2026-08-21T00:00:00Z")}).end(${unix("2026-11-19T00:00:00Z")}).granularity(DAY)`,
      `analytics.start(${unix("2026-08-21T00:00:00Z")}).end(${unix("2026-11-19T00:00:00Z")}).granularity(DAY).product_types([0])`,
      `analytics.start(${unix("2026-08-21T00:00:00Z")}).end(${unix("2026-11-19T00:00:00Z")}).granularity(DAY).product_types([2])`,
    ]);
    expect(wa.every((c) => c.auth === "Bearer SYSTEM-USER-TEST")).toBe(true);
    const waRows = rowsOf(store, "whatsapp");
    expect(waRows.filter((r) => r.row.metric === "wa_sent").map((r) => r.row.breakdown).sort()).toEqual(["", "", "type=free_form", "type=free_form", "type=template", "type=template"]);
    expect(waRows.find((r) => r.row.metric === "wa_cost")!.row).toMatchObject({ breakdown: "category=MARKETING;type=REGULAR", value: 0.2, dayZone: "UTC" });
    expect(waRows.every((r) => r.key.accountId === null && r.key.accountKey === WABA)).toBe(true);
    expect(store.state.currencies).toEqual({ [WABA]: "USD" });

    // No deprecated figure is ever asked for.
    const asked = calls.map((c) => `${c.query.get("metric") ?? ""},${c.query.get("fields") ?? ""}`).join(",");
    for (const banned of ["page_impressions", "page_fans", "post_impressions", "conversation_analytics", "plays", "impressions"]) {
      expect(asked).not.toContain(banned);
    }
  });

  it("runInsightsCollection: an invalid metric is retried one by one and remembered", async () => {
    const store = memoryStore({ instagram: false, whatsapp: false });
    override = (c) =>
      c.path === `${PAGE}/insights` && (c.query.get("metric") ?? "").split(",").includes("page_video_views")
        ? metaError(100, "(#100) The value must be a valid insights metric")
        : undefined;
    await run(store);
    const first = callsTo(`${PAGE}/insights`);
    // One call for all eight, then one per metric.
    expect(first).toHaveLength(9);
    expect(first.slice(1).map((c) => c.query.get("metric"))).toEqual([
      "page_media_view",
      "page_total_media_view_unique",
      "page_post_engagements",
      "page_views_total",
      "page_follows",
      "page_daily_follows_unique",
      "page_daily_unfollows_unique",
      "page_video_views",
    ]);
    const saved = store.state.sources[`facebook_page:${PAGE}`]!;
    expect(saved.invalid_metrics).toEqual(["page_video_views"]);
    expect(saved.problem_code).toBeNull();
    expect(rowsOf(store, "facebook_page").some((r) => r.row.metric === "page_video_views")).toBe(false);
    expect(rowsOf(store, "facebook_page").some((r) => r.row.metric === "page_media_view")).toBe(true);

    calls = [];
    await run(store);
    const second = callsTo(`${PAGE}/insights`);
    expect(second).toHaveLength(1);
    expect(second[0]!.query.get("metric")).not.toContain("page_video_views");
  });

  it("runInsightsCollection: code 190 stops the run and records a token problem", async () => {
    const store = memoryStore();
    override = () => metaError(190, "Error validating access token: The session has been invalidated", 401);
    const result = await run(store);
    expect(result).toEqual({ written: 0, problems: 1 });
    expect(store.state.sources[`facebook_page:${PAGE}`]).toMatchObject({
      problem_code: "token",
      problem_message: "The connection to Meta has expired. Tell the technical team.",
      last_ok_at: null,
    });
    // The run stopped: nothing was asked of Instagram or WhatsApp, and no later source has a record.
    expect(calls.some((c) => c.path.startsWith(IG) || c.path.startsWith(WABA))).toBe(false);
    expect(Object.keys(store.state.sources)).toEqual([`facebook_page:${PAGE}`]);
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]).toMatchObject({ account: "token", code: "190" });
    expect(store.rows.size).toBe(0);
    expect(JSON.stringify(store.alerts)).not.toContain("SYSTEM-USER-TEST");
  });

  it("runInsightsCollection: empty Page data records too_small and writes no rows", async () => {
    const store = memoryStore({ instagram: false, whatsapp: false });
    override = (c) => (c.path === `${PAGE}/insights` ? json({ data: [] }) : undefined);
    await run(store);
    expect(store.state.sources[`facebook_page:${PAGE}`]).toMatchObject({
      problem_code: "too_small",
      problem_message: "Facebook only shares these figures once the Page has 100 likes, and only with permission to read them.",
      backfilled: false,
      last_ok_at: null,
    });
    expect(rowsOf(store, "facebook_page")).toHaveLength(0);
    expect(store.alerts).toHaveLength(0);
    // Posts are a separate source and still collected.
    expect(rowsOf(store, "facebook_post").length).toBeGreaterThan(0);
  });

  it("runInsightsCollection: a 429 on Instagram does not stop WhatsApp", async () => {
    const store = memoryStore();
    override = (c) => (c.path.startsWith(IG) ? json({ error: { message: "Application request limit reached", code: 4 } }, 429) : undefined);
    const result = await run(store);
    expect(store.state.sources[`instagram_account:${IG}`]).toMatchObject({
      problem_code: "temporary",
      problem_message: "Meta was busy. We will try again on the next run.",
    });
    expect(store.state.sources[`instagram_media:${IG}`]!.problem_code).toBe("temporary");
    // Instagram was left alone after the first refusal of each source.
    expect(callsTo(`${IG}/insights`)).toHaveLength(1);
    expect(store.state.sources[`whatsapp:${WABA}`]).toMatchObject({ problem_code: null, last_ok_at: NOW.toISOString() });
    expect(rowsOf(store, "whatsapp").length).toBeGreaterThan(0);
    expect(rowsOf(store, "instagram_account")).toHaveLength(0);
    expect(result.problems).toBe(2);
    expect(store.alerts).toHaveLength(0);
  });

  it("runInsightsCollection: running twice leaves the same number of rows", async () => {
    const store = memoryStore({ templatesOn: true });
    await run(store);
    const count = store.rows.size;
    const snapshot = JSON.stringify([...store.rows.entries()].sort());
    expect(count).toBeGreaterThan(100);
    await run(store);
    expect(store.rows.size).toBe(count);
    // Same values too: a re-run overwrites, it never adds.
    expect(JSON.stringify([...store.rows.entries()].sort())).toBe(snapshot);
    expect(store.subjectRows.size).toBe(4);
  });

  it("runInsightsCollection: templates are skipped until template analytics is recorded as on", async () => {
    const off = memoryStore({ page: false, instagram: false });
    await run(off);
    expect(callsTo(`${WABA}/template_analytics`)).toHaveLength(0);
    expect(callsTo(`${WABA}/message_templates`)).toHaveLength(0);
    expect(rowsOf(off, "whatsapp_template")).toHaveLength(0);
    expect(off.state.sources[`whatsapp_template:${WABA}`]).toBeUndefined();
    // The collector never turns template figures on by itself.
    expect(calls.some((c) => c.method !== "GET" || c.query.has("is_enabled_for_insights"))).toBe(false);

    calls = [];
    const on = memoryStore({ page: false, instagram: false, templatesOn: true });
    await run(on);
    const t = callsTo(`${WABA}/template_analytics`);
    expect(t).toHaveLength(1);
    expect(t[0]!.query.get("template_ids")).toBe(`["${TEMPLATE}"]`);
    expect(t[0]!.query.get("granularity")).toBe("DAILY");
    // 89 whole days back from midnight UTC stays inside Meta's 90-day look-back.
    expect(Number(t[0]!.query.get("start"))).toBe(unix("2026-08-22T00:00:00Z"));
    expect(Number(t[0]!.query.get("end"))).toBe(unix("2026-11-19T00:00:00Z"));
    expect(rowsOf(on, "whatsapp_template").map((r) => [r.key.subjectId, r.row.metric, r.row.value])).toEqual([
      [TEMPLATE, "tmpl_sent", 20],
      [TEMPLATE, "tmpl_delivered", 19],
      [TEMPLATE, "tmpl_read", 12],
      [TEMPLATE, "tmpl_clicked", 4],
    ]);
    expect(on.subjectRows.get(`whatsapp_template|${TEMPLATE}`)).toMatchObject({ kind: "template", title: "order_ready (en)" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("runInsightsCollection: story with code 10 is skipped without a problem", async () => {
    const store = memoryStore({ page: false, whatsapp: false });
    override = (c) => (c.path === `${STORY}/insights` ? metaError(10, "(#10) Not enough viewers for the media to show insights") : undefined);
    const result = await run(store);
    expect(result.problems).toBe(0);
    expect(store.state.sources[`instagram_media:${IG}`]).toMatchObject({ problem_code: null, last_ok_at: NOW.toISOString() });
    expect(rowsOf(store, "instagram_media").some((r) => r.key.subjectId === STORY)).toBe(false);
    expect(rowsOf(store, "instagram_media").some((r) => r.key.subjectId === MEDIA)).toBe(true);
    expect(store.alerts).toHaveLength(0);
    expect(store.subjectRows.get(`instagram_media|${STORY}`)!.gone).toBe(false);
  });

  it("a removed post is marked gone, keeps its figures and is not asked about again", async () => {
    const store = memoryStore({ instagram: false, whatsapp: false });
    await run(store);
    const before = rowsOf(store, "facebook_post").length;
    expect(before).toBeGreaterThan(0);

    // The post is deleted at Facebook: it leaves the feed and its insights answer code 100.
    override = (c) => {
      if (c.path === `${PAGE}/feed`) return json({ data: [] });
      if (c.path === `${POST}/insights`) return metaError(100, "Unsupported get request. Object with ID does not exist");
      return undefined;
    };
    calls = [];
    await run(store, { now: new Date("2026-11-20T10:30:00Z") });
    expect(callsTo(`${POST}/insights`)).toHaveLength(1);
    expect(store.subjectRows.get(`facebook_post|${POST}`)!.gone).toBe(true);
    expect(rowsOf(store, "facebook_post")).toHaveLength(before);
    expect(store.state.sources[`facebook_post:${PAGE}`]!.problem_code).toBeNull();

    calls = [];
    await run(store, { now: new Date("2026-11-21T10:30:00Z") });
    expect(callsTo(`${POST}/insights`)).toHaveLength(0);
  });

  it("a stories-only pass measures live stories and nothing else, and leaves the record of the daily run alone", async () => {
    const store = memoryStore();
    const result = await run(store, { storiesOnly: true });
    expect(result.problems).toBe(0);
    expect(calls.map((c) => c.path)).toEqual([PAGE, `${IG}/stories`, `${STORY}/insights`]);
    expect(rowsOf(store, "instagram_media").every((r) => r.key.subjectId === STORY)).toBe(true);
    expect(store.state.sources).toEqual({});

    // A story older than 24 hours is not measured.
    calls = [];
    override = (c) => (c.path === `${IG}/stories` ? json({ data: [{ id: STORY, timestamp: "2026-11-18T09:00:00+0000" }] }) : undefined);
    await run(store, { storiesOnly: true });
    expect(callsTo(`${STORY}/insights`)).toHaveLength(0);
  });

  it("a permission refusal is recorded for that source only and raises one owner alert", async () => {
    const store = memoryStore({ instagram: false });
    override = (c) => (c.path === `${PAGE}/insights` ? metaError(200, "(#200) Requires read_insights permission", 403) : undefined);
    await run(store);
    expect(store.state.sources[`facebook_page:${PAGE}`]).toMatchObject({
      problem_code: "no_permission",
      problem_message: "Meta has not given the suite permission to read these figures.",
    });
    expect(store.alerts).toEqual([
      { account: `facebook_page:${PAGE}`, source: "facebook_page", label: "Facebook Page", code: "200", message: "Meta has not given the suite permission to read these figures." },
    ]);
    expect(store.state.sources[`whatsapp:${WABA}`]!.problem_code).toBeNull();
  });
});

describe("insights Graph calls and errors", () => {
  it("classifyInsightsError follows foundation D10 with C2 and C3", () => {
    const e = (code: string | null, status = 400, retryable = false) => new MetaApiError("Meta message", status, code, retryable);
    expect(classifyInsightsError(e("190", 401)).code).toBe("token");
    for (const c of ["10", "200", "299", "283"]) expect(classifyInsightsError(e(c)).code).toBe("no_permission");
    for (const c of ["4", "17", "32", "613", "80001", "80007", "80014"]) expect(classifyInsightsError(e(c)).code).toBe("temporary");
    expect(classifyInsightsError(e(null, 503)).code).toBe("temporary");
    expect(classifyInsightsError(e(null, 429)).code).toBe("temporary");
    expect(classifyInsightsError(e(null, 0, true)).code).toBe("temporary");
    expect(classifyInsightsError(e("3001"))).toEqual({ code: "other", message: "Meta said: Meta message (code 3001)" });
  });

  it("fetchWaAnalytics and fetchTemplateAnalytics build the documented requests", async () => {
    await fetchWaAnalytics(cfg, WABA, 1000, 2000, 0);
    expect(calls[0]!.query.get("fields")).toBe("analytics.start(1000).end(2000).granularity(DAY).product_types([0])");
    await expect(fetchTemplateAnalytics(cfg, WABA, [], 1, 2)).rejects.toThrow(/1 to 10/);
    await expect(fetchTemplateAnalytics(cfg, WABA, Array.from({ length: 11 }, (_, i) => String(i)), 1, 2)).rejects.toThrow(/1 to 10/);
    expect(calls).toHaveLength(1);
  });

  it("enableTemplateAnalytics is the only write, and passes Meta's refusal on", async () => {
    override = (c) => (c.method === "POST" && c.path === WABA ? json({ success: true }) : undefined);
    await enableTemplateAnalytics(cfg, WABA);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: WABA, auth: "Bearer SYSTEM-USER-TEST" });
    expect(calls[0]!.query.get("is_enabled_for_insights")).toBe("true");

    override = () => metaError(100, "(#100) Template insights cannot be enabled for this account");
    await expect(enableTemplateAnalytics(cfg, WABA)).rejects.toMatchObject({ code: "100" });
  });

  it("normaliseInsightsState fills in whatever is missing", () => {
    expect(normaliseInsightsState(null)).toEqual({
      last_daily_run_day: null,
      last_run_at: null,
      refresh_requested_at: null,
      sources: {},
      template_analytics: {},
      currencies: {},
    });
    expect(normaliseInsightsState({ sources: { a: { backfilled: true } }, last_run_at: 5 }).sources.a).toEqual({ ...EMPTY_SOURCE_STATE, backfilled: true });
  });
});
