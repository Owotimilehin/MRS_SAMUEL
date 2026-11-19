/**
 * Statistics from Meta (suite spec 11, section 5.4). Mounted at /v1/insights.
 *
 * Every route needs insights.view. The read routes only read what the worker's
 * collector stored: no route here asks Meta for figures. The one call to Meta is
 * POST /whatsapp/template-analytics, the owner's confirmed, audited, permanent
 * switch (foundation rule 7).
 *
 * Rules kept here: a day with no stored figure is null, never zero; running totals
 * are never summed; unique-people figures are averaged, never summed; figures from
 * different sources are never added together; days are never converted between
 * time zones. No query touches inbox_message: the suite's own numbers come from
 * /v1/inbox/reports, on the screen.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { inboxPhoneNumber, insightMetricDaily, insightSubject, type DbClient } from "@ms/db";
import {
  MetaApiError,
  enableTemplateAnalytics,
  listChannelAccounts,
  listInsightWabaIds,
  metaConfigFromEnv,
  patchInsightsState,
  readInsightsState,
  recordTemplateAnalyticsEnabled,
  type InsightsState,
} from "@ms/domain";
import {
  INSIGHT_METRICS,
  SOURCE_DAY_ZONE,
  addDays,
  daysInRange,
  fillSeries,
  isDayKey,
  isRunningTotalMetric,
  rangeDailyAverage,
  rangeTotal,
  type InsightSource,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { toCsv } from "../lib/csv.js";
import { logger } from "../logger.js";

// ── Shapes ───────────────────────────────────────────────────────────────────

type ProblemCode = "not_connected" | "no_permission" | "token" | "too_small" | "temporary" | "not_enabled" | "other";
export interface SourceStatus {
  source: string;
  account_key: string;
  label: string;
  last_ok_at: string | null;
  problem: null | { code: ProblemCode; message: string };
}
export interface Tile {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  how: "sum" | "latest" | "daily_average";
  note: string | null;
}
export interface PostRow {
  network: "facebook" | "instagram";
  subject_id: string;
  kind: string | null;
  title: string | null;
  permalink: string | null;
  published_at: string | null;
  from_suite: boolean;
  /** Meta says the post no longer exists; its stored figures are kept. */
  removed: boolean;
  views: number | null;
  reach: number | null;
  interactions: number | null;
  comments: number | null;
  clicks: number | null;
}
export interface TemplateRow {
  template_id: string;
  name: string;
  sent: number | null;
  delivered: number | null;
  read: number | null;
  clicked: number | null;
  read_rate: number | null;
}

const RANGE_TOO_LONG = "Pick a range of up to 400 days";
const EXPORT_TOO_BIG = "That is too much to export at once. Pick a shorter range or one source.";
const REFRESHED_RECENTLY = "Figures were refreshed a few minutes ago. Try again shortly.";
const OWNER_ONLY = "Only the owner can turn this on";
const NOT_CONNECTED = "Meta is not connected on this server.";
const TEMPLATES_OFF = "Template figures are switched off at WhatsApp.";
const REACH_NOTE =
  "This is the average for a day. People reached on different days cannot be added up, because the same person may be counted on each day.";
const MIXED_CURRENCY_NOTE = "Your WhatsApp accounts are billed in different currencies, so their charges are not added together here.";
const EXPORT_MAX_ROWS = 200_000;
const REFRESH_GAP_MS = 10 * 60_000;

/** The sources whose figures are per account (no post or template behind them): the only ones a series may sum. */
const ACCOUNT_SOURCES = ["facebook_page", "instagram_account", "whatsapp"] as const;
type AccountSource = (typeof ACCOUNT_SOURCES)[number];

const TILES: { key: string; label: string; source: AccountSource; metric: string; breakdown: "" | "*"; how: Tile["how"]; note: string | null }[] = [
  { key: "fb_views", label: "Facebook views", source: "facebook_page", metric: "page_media_view", breakdown: "", how: "sum", note: null },
  { key: "fb_followers", label: "Facebook followers", source: "facebook_page", metric: "page_follows", breakdown: "", how: "latest", note: null },
  { key: "fb_engagement", label: "Facebook reactions, comments and shares", source: "facebook_page", metric: "page_post_engagements", breakdown: "", how: "sum", note: null },
  { key: "ig_views", label: "Instagram views", source: "instagram_account", metric: "views", breakdown: "", how: "sum", note: null },
  { key: "ig_reach", label: "Instagram accounts reached (average per day)", source: "instagram_account", metric: "reach", breakdown: "", how: "daily_average", note: REACH_NOTE },
  { key: "ig_followers", label: "Instagram followers", source: "instagram_account", metric: "followers_count", breakdown: "", how: "latest", note: null },
  { key: "ig_interactions", label: "Instagram likes, comments, shares and saves", source: "instagram_account", metric: "total_interactions", breakdown: "", how: "sum", note: null },
  { key: "wa_delivered", label: "WhatsApp messages delivered", source: "whatsapp", metric: "wa_delivered", breakdown: "", how: "sum", note: null },
  { key: "wa_cost", label: "WhatsApp charges", source: "whatsapp", metric: "wa_cost", breakdown: "*", how: "sum", note: null },
];

// ── Requests ─────────────────────────────────────────────────────────────────

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDayKey);
const RangeQuery = z.object({ from: Day, to: Day });

interface Range {
  from: string;
  to: string;
  previous: { from: string; to: string };
}

/** from <= to, at most 400 days; the previous period is the same length, ending the day before `from`. */
function parseRange(c: Context): Range {
  const q = RangeQuery.parse({ from: c.req.query("from"), to: c.req.query("to") });
  const days = daysInRange(q.from, q.to);
  if (days < 1 || days > 400) throw new BusinessError("validation_failed", RANGE_TOO_LONG, 400);
  const prevTo = addDays(q.from, -1);
  return { from: q.from, to: q.to, previous: { from: addDays(prevTo, -(days - 1)), to: prevTo } };
}

const num = (v: unknown): number => Number(v);

// ── Reading stored figures ───────────────────────────────────────────────────

interface DayValue {
  day: string;
  breakdown: string;
  value: number;
  dayZone: string;
}

/** Account-level figures of one source and metric, summed over that source's accounts, per day and breakdown. */
async function accountFigures(db: DbClient, source: AccountSource, metrics: string[], from: string, to: string): Promise<Map<string, DayValue[]>> {
  const rows = await db
    .select({
      metric: insightMetricDaily.metric,
      day: insightMetricDaily.day,
      breakdown: insightMetricDaily.breakdown,
      value: sql<string>`sum(${insightMetricDaily.value})`,
      dayZone: sql<string>`max(${insightMetricDaily.dayZone})`,
    })
    .from(insightMetricDaily)
    .where(
      and(
        eq(insightMetricDaily.source, source),
        inArray(insightMetricDaily.metric, metrics),
        eq(insightMetricDaily.subjectId, ""),
        gte(insightMetricDaily.day, from),
        lte(insightMetricDaily.day, to),
      ),
    )
    .groupBy(insightMetricDaily.metric, insightMetricDaily.day, insightMetricDaily.breakdown)
    .orderBy(asc(insightMetricDaily.day));
  const out = new Map<string, DayValue[]>();
  for (const r of rows) {
    const list = out.get(r.metric) ?? [];
    list.push({ day: r.day, breakdown: r.breakdown, value: num(r.value), dayZone: r.dayZone });
    out.set(r.metric, list);
  }
  return out;
}

/** One value per day for one breakdown ("" is the whole figure). */
function perDay(rows: DayValue[] | undefined, breakdown: string): { day: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const r of rows ?? []) {
    if (r.breakdown !== breakdown) continue;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.value);
  }
  return [...byDay.entries()].map(([day, value]) => ({ day, value }));
}

function tileValue(how: Tile["how"], points: { value: number | null }[]): number | null {
  if (how === "latest") return rangeTotal(points, true);
  if (how === "daily_average") return rangeDailyAverage(points);
  return rangeTotal(points, false);
}

// ── Source statuses ──────────────────────────────────────────────────────────

const KNOWN_PROBLEMS = new Set<ProblemCode>(["no_permission", "token", "too_small", "temporary", "other"]);

async function sourceStatuses(db: DbClient, state: InsightsState): Promise<SourceStatus[]> {
  const out: SourceStatus[] = [];
  const connected = metaConfigFromEnv() !== null;
  const fromState = (source: InsightSource, accountKey: string, label: string): SourceStatus => {
    const s = state.sources[`${source}:${accountKey}`];
    const code = s?.problem_code as ProblemCode | null | undefined;
    return {
      source,
      account_key: accountKey,
      label,
      last_ok_at: s?.last_ok_at ?? null,
      problem: !connected
        ? { code: "not_connected", message: NOT_CONNECTED }
        : code
          ? { code: KNOWN_PROBLEMS.has(code) ? code : "other", message: s?.problem_message ?? "These figures could not be read." }
          : null,
    };
  };
  const missing = (source: InsightSource, label: string, message: string): SourceStatus => ({
    source,
    account_key: "",
    label,
    last_ok_at: null,
    problem: { code: "not_connected", message },
  });

  const accounts = (await listChannelAccounts(db)).filter((a) => a.isActive && a.externalId && a.pageId);
  const pages = accounts.filter((a) => a.kind === "messenger");
  const instagram = accounts.filter((a) => a.kind === "instagram");
  if (pages.length === 0) out.push(missing("facebook_page", "Facebook", "No Facebook Page is connected. Connect one in Channels to see its figures."));
  for (const p of pages) {
    out.push(fromState("facebook_page", p.externalId!, `Facebook Page: ${p.label}`));
    out.push(fromState("facebook_post", p.externalId!, `Facebook posts: ${p.label}`));
  }
  if (instagram.length === 0) out.push(missing("instagram_account", "Instagram", "No Instagram account is connected. Connect one in Channels to see its figures."));
  for (const i of instagram) {
    out.push(fromState("instagram_account", i.externalId!, `Instagram: ${i.label}`));
    out.push(fromState("instagram_media", i.externalId!, `Instagram posts and stories: ${i.label}`));
  }
  const wabas = await listInsightWabaIds(db);
  if (wabas.length === 0) out.push(missing("whatsapp", "WhatsApp", "No WhatsApp number is connected."));
  for (const w of wabas) {
    out.push(fromState("whatsapp", w, "WhatsApp messages"));
    out.push(
      state.template_analytics[w]
        ? fromState("whatsapp_template", w, "WhatsApp templates")
        : { source: "whatsapp_template", account_key: w, label: "WhatsApp templates", last_ok_at: null, problem: { code: "not_enabled", message: TEMPLATES_OFF } },
    );
  }
  return out;
}

/** The one currency every connected WhatsApp account is billed in, when we know it; otherwise null. */
function costCurrency(state: InsightsState, wabas: string[]): { currency: string | null; mixed: boolean } {
  const known = wabas.map((w) => state.currencies?.[w] ?? null);
  const distinct = new Set(known.filter((c): c is string => c !== null));
  if (distinct.size > 1) return { currency: null, mixed: true };
  if (wabas.length === 0 || known.some((c) => c === null)) return { currency: null, mixed: false };
  return { currency: [...distinct][0] ?? null, mixed: false };
}

// ── Posts published from the suite (the hook for suite spec 09) ──────────────

let socialPostTargetExists: Promise<boolean> | null = null;

/**
 * Spec 09 (publishing) creates social_post_target; this spec does not. The table is
 * looked for once per process. Without it, nothing is "posted from the suite".
 */
function hasSocialPostTarget(db: DbClient): Promise<boolean> {
  socialPostTargetExists ??= db
    .execute<{ t: string | null }>(sql`select to_regclass('social_post_target')::text as t`)
    .then((rows) => (rows as unknown as { t: string | null }[])[0]?.t != null)
    .catch(() => false);
  return socialPostTargetExists;
}

/** Tests that create or drop the table ask again. */
export function resetInsightsSuitePostCheck(): void {
  socialPostTargetExists = null;
}

/** Which of these post IDs were published from the suite (social_post_target.external_id). Never fails the page. */
async function postedFromSuite(db: DbClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0 || !(await hasSocialPostTarget(db))) return new Set();
  try {
    const rows = await db.execute<{ external_id: string | null }>(
      sql`select "external_id" from "social_post_target" where "external_id" in ${ids}`,
    );
    return new Set((rows as unknown as { external_id: string | null }[]).map((r) => r.external_id).filter((v): v is string => !!v));
  } catch (err) {
    logger.warn({ err }, "insights: could not read social_post_target; no post is marked as posted from the suite");
    return new Set();
  }
}

/** A cell that a spreadsheet would run as a formula is written as plain text. */
const csvText = (s: string | null): string => (s && /^[=+\-@\t\r]/.test(s) ? `'${s}` : (s ?? ""));

// ── Routes ───────────────────────────────────────────────────────────────────

export function insightRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("insights.view"));

  /** The tiles, each with the same figure for the period just before. */
  r.get("/summary", async (c) => {
    const range = parseRange(c);
    const state = await readInsightsState(db);
    const wabas = await listInsightWabaIds(db);
    const money = costCurrency(state, wabas);

    const bySource = new Map<AccountSource, Map<string, DayValue[]>>();
    for (const source of ACCOUNT_SOURCES) {
      const metrics = TILES.filter((t) => t.source === source).map((t) => t.metric);
      bySource.set(source, await accountFigures(db, source, metrics, range.previous.from, range.to));
    }
    const tiles: Tile[] = TILES.map((t) => {
      if (t.key === "wa_cost" && money.mixed) {
        return { key: t.key, label: t.label, value: null, previous: null, how: t.how, note: MIXED_CURRENCY_NOTE };
      }
      const stored = bySource.get(t.source)!.get(t.metric);
      // wa_cost has no "whole" row: its parts (category and type) are the only rows, and together they are the whole.
      const values = t.breakdown === "*" ? perDayAllParts(stored) : perDay(stored, "");
      return {
        key: t.key,
        label: t.label,
        value: tileValue(t.how, fillSeries(range.from, range.to, values)),
        previous: tileValue(t.how, fillSeries(range.previous.from, range.previous.to, values)),
        how: t.how,
        note: t.note,
      };
    });
    return c.json({
      data: {
        range: { from: range.from, to: range.to },
        previous: range.previous,
        sources: await sourceStatuses(db, state),
        tiles,
        cost_currency: money.currency,
      },
    });
  });

  /** One figure per day, with null for a day that has no stored figure. */
  r.get("/series", async (c) => {
    const range = parseRange(c);
    const source = c.req.query("source") ?? "";
    const metric = c.req.query("metric") ?? "";
    const breakdown = c.req.query("breakdown") ?? "";
    if (!(ACCOUNT_SOURCES as readonly string[]).includes(source)) {
      throw new BusinessError("validation_failed", "Unknown source", 400);
    }
    const src = source as AccountSource;
    if (!INSIGHT_METRICS[src].includes(metric)) throw new BusinessError("validation_failed", "Unknown metric", 400);
    if (breakdown.length > 200) throw new BusinessError("validation_failed", "Unknown breakdown", 400);

    const rows = (await accountFigures(db, src, [metric], range.from, range.to)).get(metric) ?? [];
    const head = {
      source: src,
      metric,
      // Rows keep the zone they were counted in; with no rows, the zone this source uses today.
      day_zone: rows.length > 0 ? rows[rows.length - 1]!.dayZone : SOURCE_DAY_ZONE[src],
      is_running_total: isRunningTotalMetric(src, metric),
    };
    if (breakdown === "*") {
      // Every part, each as its own series. The whole ("") is left out: parts are never added to it.
      const parts = [...new Set(rows.map((x) => x.breakdown).filter((b) => b !== ""))].sort();
      return c.json({
        data: { ...head, series: parts.map((b) => ({ breakdown: b, points: fillSeries(range.from, range.to, perDay(rows, b)) })) },
      });
    }
    return c.json({ data: { ...head, points: fillSeries(range.from, range.to, perDay(rows, breakdown)) } });
  });

  /** Posts published in the range, each with its latest running totals. */
  r.get("/posts", async (c) => {
    const range = parseRange(c);
    const q = z
      .object({
        network: z.enum(["all", "facebook", "instagram"]).default("all"),
        sort: z.enum(["views", "interactions", "reach", "date"]).default("views"),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse({ network: c.req.query("network"), sort: c.req.query("sort"), limit: c.req.query("limit") });
    const sources = q.network === "facebook" ? ["facebook_post"] : q.network === "instagram" ? ["instagram_media"] : ["facebook_post", "instagram_media"];

    // Lagos days (UTC+1 all year): published_at decides which day a post belongs to.
    const subjects = await db
      .select()
      .from(insightSubject)
      .where(
        and(
          inArray(insightSubject.source, sources),
          gte(insightSubject.publishedAt, new Date(`${range.from}T00:00:00+01:00`)),
          lt(insightSubject.publishedAt, new Date(`${addDays(range.to, 1)}T00:00:00+01:00`)),
        ),
      );
    if (subjects.length === 0) return c.json({ data: [] });

    const ids = subjects.map((s) => s.subjectId);
    const latest = await db
      .selectDistinctOn([insightMetricDaily.source, insightMetricDaily.subjectId, insightMetricDaily.metric], {
        source: insightMetricDaily.source,
        subjectId: insightMetricDaily.subjectId,
        metric: insightMetricDaily.metric,
        value: insightMetricDaily.value,
      })
      .from(insightMetricDaily)
      .where(and(inArray(insightMetricDaily.source, sources), inArray(insightMetricDaily.subjectId, ids), eq(insightMetricDaily.breakdown, "")))
      .orderBy(insightMetricDaily.source, insightMetricDaily.subjectId, insightMetricDaily.metric, desc(insightMetricDaily.day));
    const figures = new Map<string, number>();
    for (const f of latest) figures.set(`${f.source}|${f.subjectId}|${f.metric}`, num(f.value));
    const fromSuite = await postedFromSuite(db, ids);

    const rows: PostRow[] = subjects.map((s) => {
      const fb = s.source === "facebook_post";
      const get = (metric: string): number | null => figures.get(`${s.source}|${s.subjectId}|${metric}`) ?? null;
      return {
        network: fb ? "facebook" : "instagram",
        subject_id: s.subjectId,
        kind: s.kind,
        title: s.title,
        permalink: s.permalink,
        published_at: s.publishedAt ? s.publishedAt.toISOString() : null,
        from_suite: fromSuite.has(s.subjectId),
        removed: s.goneAt !== null,
        views: get(fb ? "post_media_view" : "views"),
        reach: get(fb ? "post_total_media_view_unique" : "reach"),
        interactions: get(fb ? "post_reactions_total" : "total_interactions"),
        comments: fb ? null : get("comments"),
        clicks: fb ? get("post_clicks") : null,
      };
    });
    const key = (p: PostRow): number | null =>
      q.sort === "date" ? (p.published_at ? Date.parse(p.published_at) : null) : q.sort === "views" ? p.views : q.sort === "reach" ? p.reach : p.interactions;
    // Largest first; a post with no figure goes last; ties by newest, then ID, so the order is stable.
    rows.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka !== kb) {
        if (ka === null) return 1;
        if (kb === null) return -1;
        return kb - ka;
      }
      const byDate = (b.published_at ?? "").localeCompare(a.published_at ?? "");
      return byDate !== 0 ? byDate : a.subject_id.localeCompare(b.subject_id);
    });
    return c.json({ data: rows.slice(0, q.limit) });
  });

  /** WhatsApp: messages by type, charges, and how each template did. */
  r.get("/whatsapp", async (c) => {
    const range = parseRange(c);
    const state = await readInsightsState(db);
    const wabas = await listInsightWabaIds(db);
    const figures = await accountFigures(db, "whatsapp", ["wa_sent", "wa_delivered", "wa_billable", "wa_cost"], range.from, range.to);

    const template = new Map(perDay(figures.get("wa_sent"), "type=template").map((p) => [p.day, p.value]));
    const freeForm = new Map(perDay(figures.get("wa_sent"), "type=free_form").map((p) => [p.day, p.value]));
    const delivered = new Map(perDay(figures.get("wa_delivered"), "").map((p) => [p.day, p.value]));
    const byType = fillSeries(range.from, range.to, []).map(({ day }) => ({
      day,
      template: template.get(day) ?? null,
      free_form: freeForm.get(day) ?? null,
      delivered: delivered.get(day) ?? null,
    }));

    // Charges, added up over the range for each category and type. A part with no cost row keeps cost null.
    const pricing = new Map<string, { category: string; type: string; volume: number | null; cost: number | null }>();
    const part = (breakdown: string) => {
      const pairs = Object.fromEntries(breakdown.split(";").map((kv) => kv.split("=", 2) as [string, string]));
      const hit = pricing.get(breakdown) ?? { category: pairs.category ?? "", type: pairs.type ?? "", volume: null, cost: null };
      pricing.set(breakdown, hit);
      return hit;
    };
    for (const row of figures.get("wa_billable") ?? []) if (row.breakdown) part(row.breakdown).volume = (part(row.breakdown).volume ?? 0) + row.value;
    for (const row of figures.get("wa_cost") ?? []) if (row.breakdown) part(row.breakdown).cost = (part(row.breakdown).cost ?? 0) + row.value;

    // Templates: flows added up over the range, per template. A figure with no row stays null.
    const sums = await db
      .select({
        subjectId: insightMetricDaily.subjectId,
        metric: insightMetricDaily.metric,
        value: sql<string>`sum(${insightMetricDaily.value})`,
      })
      .from(insightMetricDaily)
      .where(
        and(
          eq(insightMetricDaily.source, "whatsapp_template"),
          eq(insightMetricDaily.breakdown, ""),
          gte(insightMetricDaily.day, range.from),
          lte(insightMetricDaily.day, range.to),
        ),
      )
      .groupBy(insightMetricDaily.subjectId, insightMetricDaily.metric);
    const perTemplate = new Map<string, Record<string, number>>();
    for (const s of sums) perTemplate.set(s.subjectId, { ...(perTemplate.get(s.subjectId) ?? {}), [s.metric]: num(s.value) });
    const names =
      perTemplate.size > 0
        ? await db
            .select({ subjectId: insightSubject.subjectId, title: insightSubject.title })
            .from(insightSubject)
            .where(and(eq(insightSubject.source, "whatsapp_template"), inArray(insightSubject.subjectId, [...perTemplate.keys()])))
        : [];
    const nameOf = new Map(names.map((n) => [n.subjectId, n.title]));
    const templates: TemplateRow[] = [...perTemplate.entries()]
      .map(([id, m]) => {
        const deliveredCount = m.tmpl_delivered ?? null;
        const read = m.tmpl_read ?? null;
        return {
          template_id: id,
          name: nameOf.get(id) ?? id,
          sent: m.tmpl_sent ?? null,
          delivered: deliveredCount,
          read,
          clicked: m.tmpl_clicked ?? null,
          read_rate: read !== null && deliveredCount !== null && deliveredCount > 0 ? read / deliveredCount : null,
        };
      })
      .sort((a, b) => (b.sent ?? -1) - (a.sent ?? -1) || a.name.localeCompare(b.name));

    const accounts = wabas.map((w) => ({ waba_id: w, template_analytics: state.template_analytics[w] ? ("on" as const) : ("off" as const) }));
    return c.json({
      data: {
        day_zone: "UTC",
        by_type: byType,
        pricing: [...pricing.values()].sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type)),
        cost_currency: costCurrency(state, wabas).currency,
        templates,
        // "on" only when we recorded the owner turning it on for every account; with no account we cannot say.
        template_analytics: accounts.length === 0 ? "unknown" : accounts.every((a) => a.template_analytics === "on") ? "on" : "off",
        accounts,
      },
    });
  });

  /** Every stored figure in the range as a spreadsheet. A day with no figure has no line. */
  r.get("/export.csv", async (c) => {
    const range = parseRange(c);
    const source = c.req.query("source") ?? "all";
    if (source !== "all" && !(Object.keys(INSIGHT_METRICS) as string[]).includes(source)) {
      throw new BusinessError("validation_failed", "Unknown source", 400);
    }
    const rows = await db
      .select({
        source: insightMetricDaily.source,
        accountKey: insightMetricDaily.accountKey,
        accountLabel: inboxPhoneNumber.label,
        subjectId: insightMetricDaily.subjectId,
        title: insightSubject.title,
        permalink: insightSubject.permalink,
        metric: insightMetricDaily.metric,
        breakdown: insightMetricDaily.breakdown,
        day: insightMetricDaily.day,
        dayZone: insightMetricDaily.dayZone,
        value: insightMetricDaily.value,
        isRunningTotal: insightMetricDaily.isRunningTotal,
      })
      .from(insightMetricDaily)
      .leftJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, insightMetricDaily.accountId))
      .leftJoin(insightSubject, and(eq(insightSubject.source, insightMetricDaily.source), eq(insightSubject.subjectId, insightMetricDaily.subjectId)))
      .where(
        and(
          gte(insightMetricDaily.day, range.from),
          lte(insightMetricDaily.day, range.to),
          source === "all" ? undefined : eq(insightMetricDaily.source, source),
        ),
      )
      .orderBy(insightMetricDaily.source, insightMetricDaily.subjectId, insightMetricDaily.metric, insightMetricDaily.breakdown, insightMetricDaily.day)
      .limit(EXPORT_MAX_ROWS + 1);
    if (rows.length > EXPORT_MAX_ROWS) throw new BusinessError("validation_failed", EXPORT_TOO_BIG, 400);

    await writeAudit(db, c, {
      action: "insights.export",
      entityType: "insight",
      entityId: "export",
      after: { from: range.from, to: range.to, source, rows: rows.length },
      notify: false,
    });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="insights-${range.from}-to-${range.to}.csv"`);
    return c.body(
      toCsv(
        ["source", "account", "item", "item_link", "metric", "breakdown", "day", "day_time_zone", "value", "running_total"],
        rows.map((x) => [
          x.source,
          csvText(x.accountLabel ?? x.accountKey),
          csvText(x.subjectId === "" ? "" : (x.title ?? x.subjectId)),
          csvText(x.permalink),
          x.metric,
          x.breakdown,
          x.day,
          x.dayZone,
          String(num(x.value)),
          x.isRunningTotal ? "yes" : "no",
        ]),
      ),
    );
  });

  r.get("/status", async (c) => {
    const state = await readInsightsState(db);
    return c.json({
      data: {
        last_run_at: state.last_run_at,
        last_daily_run_day: state.last_daily_run_day,
        refresh_requested_at: state.refresh_requested_at,
        sources: await sourceStatuses(db, state),
      },
    });
  });

  /** Ask the worker to collect now. It notices within 10 minutes. */
  r.post("/refresh", async (c) => {
    const state = await readInsightsState(db);
    const now = new Date();
    const recent = (iso: string | null): boolean => iso !== null && now.getTime() - Date.parse(iso) < REFRESH_GAP_MS;
    if (recent(state.last_run_at) || recent(state.refresh_requested_at)) {
      throw new BusinessError("rate_limited", REFRESHED_RECENTLY, 429);
    }
    const requestedAt = now.toISOString();
    await patchInsightsState(db, { refresh_requested_at: requestedAt });
    await writeAudit(db, c, {
      action: "insights.refresh",
      entityType: "insight",
      entityId: "refresh",
      after: { requested_at: requestedAt },
      notify: false,
    });
    return c.json({ data: { requested_at: requestedAt } });
  });

  /**
   * Turn on template figures at WhatsApp. Owner only, and only with `confirm: true`:
   * WhatsApp cannot turn this off again, and it starts tracking taps on template links.
   */
  r.post("/whatsapp/template-analytics", async (c) => {
    const auth = c.get("auth");
    if (auth.role !== "owner") throw new BusinessError("forbidden", OWNER_ONLY, 403);
    const body = z
      .object({ waba_id: z.string().regex(/^\d{5,30}$/), confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json().catch(() => ({})));
    const wabas = await listInsightWabaIds(db);
    if (!wabas.includes(body.waba_id)) {
      throw new BusinessError("validation_failed", "That WhatsApp account is not connected here.", 400);
    }
    const state = await readInsightsState(db);
    // Already on (we recorded it): nothing to send, nothing to audit.
    if (state.template_analytics[body.waba_id]) return c.json({ data: { template_analytics: "on" } });

    const cfg = metaConfigFromEnv();
    if (!cfg) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
    try {
      await enableTemplateAnalytics(cfg, body.waba_id);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      if (err.delivery === "unknown") {
        // No answer: WhatsApp may have turned it on. It is permanent, so leave a trace and do not record it as on.
        await writeAudit(db, c, {
          action: "insights.template_analytics_enable_unconfirmed",
          entityType: "insight",
          entityId: body.waba_id,
          after: { waba_id: body.waba_id, result: "unknown" },
          notify: true,
        });
        throw new BusinessError(
          "service_unavailable",
          "WhatsApp did not answer, so we do not know whether template figures were turned on. Check in WhatsApp Manager before trying again.",
          504,
          { reason: "meta_unknown" },
        );
      }
      throw new BusinessError("service_unavailable", `WhatsApp did not accept this: ${err.message}`, 502, {
        reason: "meta_refused",
        meta_code: err.code,
      });
    }
    await recordTemplateAnalyticsEnabled(db, body.waba_id, auth.userId);
    await writeAudit(db, c, {
      action: "insights.template_analytics_enable",
      entityType: "insight",
      entityId: body.waba_id,
      after: { waba_id: body.waba_id, permanent: true },
      notify: true,
    });
    return c.json({ data: { template_analytics: "on" } });
  });

  return r;
}

/** Every part added up per day (charges have no "whole" row; their parts together are the whole). */
function perDayAllParts(rows: DayValue[] | undefined): { day: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const r of rows ?? []) {
    if (r.breakdown === "") continue;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.value);
  }
  return [...byDay.entries()].map(([day, value]) => ({ day, value }));
}
