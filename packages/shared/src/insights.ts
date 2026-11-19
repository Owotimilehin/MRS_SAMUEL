/**
 * Statistics from Meta (suite spec 11): pure parsers and helpers shared by the
 * collector, the API and the Insights screen. Nothing here calls Meta or the clock.
 *
 * Two rules run through every function:
 *   - a figure Meta did not send produces no row (a missing figure is not zero);
 *   - a day is kept as the source counts it, with the zone it follows; days are
 *     never converted between zones.
 */

// ── Sources, zones and metric names ──────────────────────────────────────────

export const INSIGHT_SOURCES = [
  "facebook_page",
  "facebook_post",
  "instagram_account",
  "instagram_media",
  "whatsapp",
  "whatsapp_template",
] as const;
export type InsightSource = (typeof INSIGHT_SOURCES)[number];

/** Facebook counts a Page's day on US Pacific time (spec fact P4, open question Q1). */
export const PAGE_DAY_ZONE = "America/Los_Angeles";
export const LAGOS_ZONE = "Africa/Lagos";
export const UTC_ZONE = "UTC";

/** The zone the days of a source follow. */
export const SOURCE_DAY_ZONE: Record<InsightSource, string> = {
  facebook_page: PAGE_DAY_ZONE,
  facebook_post: LAGOS_ZONE,
  instagram_account: LAGOS_ZONE,
  instagram_media: LAGOS_ZONE,
  whatsapp: UTC_ZONE,
  whatsapp_template: UTC_ZONE,
};

/** Page figures asked for with period=day (spec fact P8). */
export const PAGE_METRICS = [
  "page_media_view",
  "page_total_media_view_unique",
  "page_post_engagements",
  "page_views_total",
  "page_follows",
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_video_views",
] as const;

/** Page figures that are "the total so far on that day". */
export const PAGE_RUNNING_TOTALS: ReadonlySet<string> = new Set(["page_follows"]);

/** Post figures asked for (lifetime, spec fact P10). */
export const POST_METRICS = [
  "post_media_view",
  "post_total_media_view_unique",
  "post_clicks",
  "post_reactions_by_type_total",
  "post_video_views",
] as const;

/** Instagram account figures asked for without a breakdown (spec fact G2). */
export const IG_ACCOUNT_METRICS = [
  "reach",
  "views",
  "accounts_engaged",
  "total_interactions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "reposts",
  "profile_links_taps",
] as const;

const IG_FEED_METRICS = ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"] as const;
const IG_REELS_METRICS = [...IG_FEED_METRICS, "ig_reels_avg_watch_time"] as const;
const IG_STORY_METRICS = ["reach", "views", "replies", "shares", "total_interactions"] as const;

/** The figures to ask for on one Instagram item, by its product type (spec fact G8, table 4.2). */
export function igMediaMetricsFor(productType: string | null | undefined): readonly string[] {
  const t = (productType ?? "").toUpperCase();
  if (t === "STORY") return IG_STORY_METRICS;
  if (t === "REELS" || t === "REEL") return IG_REELS_METRICS;
  return IG_FEED_METRICS;
}

/** Every metric name a source can hold; the API refuses anything else. */
export const INSIGHT_METRICS: Record<InsightSource, readonly string[]> = {
  facebook_page: PAGE_METRICS,
  facebook_post: [...POST_METRICS, "post_reactions_total"],
  instagram_account: [...IG_ACCOUNT_METRICS, "follows_and_unfollows", "followers_count", "media_count"],
  instagram_media: [...new Set([...IG_REELS_METRICS, ...IG_STORY_METRICS])],
  whatsapp: ["wa_sent", "wa_delivered", "wa_billable", "wa_cost"],
  whatsapp_template: ["tmpl_sent", "tmpl_delivered", "tmpl_read", "tmpl_clicked"],
};

/** True when a figure is "the total so far" and so must never be added across days. */
export function isRunningTotalMetric(source: InsightSource, metric: string): boolean {
  if (source === "facebook_post" || source === "instagram_media") return true;
  if (source === "facebook_page") return PAGE_RUNNING_TOTALS.has(metric);
  if (source === "instagram_account") return metric === "followers_count" || metric === "media_count";
  return false;
}

/** Metrics that count people once and so must never be added across days. */
export const UNIQUE_PEOPLE_METRICS: ReadonlySet<string> = new Set([
  "reach",
  "accounts_engaged",
  "page_total_media_view_unique",
  "post_total_media_view_unique",
]);

export interface MetricRow {
  metric: string;
  day: string;
  dayZone: string;
  breakdown: string;
  value: number;
  isRunningTotal: boolean;
}

// ── Small helpers ────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A finite number, from a number or a plain numeric string; otherwise null. Never turns "nothing" into 0. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written YYYY-MM-DD. */
export function isDayKey(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** The day `n` days after `day` (before, when n is negative). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** How many days from..to covers, counting both ends. */
export function daysInRange(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The calendar day of an instant in a zone, YYYY-MM-DD. */
export function dayInZone(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The Lagos calendar day of an instant. */
export function lagosDayOf(at: Date): string {
  return dayInZone(at, LAGOS_ZONE);
}

/** The hour (0 to 23) in Lagos of an instant. Lagos is UTC+1 all year. */
export function lagosHourOf(at: Date): number {
  return (at.getUTCHours() + 1) % 24;
}

function utcDayOfUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Sorted "k=v;k=v". Empty for no pairs. */
export function breakdownKey(pairs: Record<string, string>): string {
  return Object.keys(pairs)
    .sort()
    .map((k) => `${k}=${pairs[k]}`)
    .join(";");
}

// ── Facebook Page and posts ──────────────────────────────────────────────────

/**
 * "2020-03-10T07:00:00+0000" -> "2020-03-09": the Pacific calendar date of the day
 * that ends at `endTime`. Facebook stamps each daily value with the END of its day
 * (midnight US Pacific). We step back 12 hours, to the middle of that day, so the
 * 23-hour and 25-hour days at the clock changes still land on the right date.
 * Returns "" when the text is not a time.
 */
export function pageDayFromEndTime(endTime: string): string {
  const at = Date.parse(endTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(at)) return "";
  return dayInZone(new Date(at - 12 * 3_600_000), PAGE_DAY_ZONE);
}

/**
 * Page insights response -> rows. Object values (reactions by type) become one row
 * per key with breakdown "type=<key>". Skips values that are null or not numeric.
 */
export function parsePageInsights(json: unknown, opts: { runningTotals: ReadonlySet<string> }): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const item of arr(isObj(json) ? json.data : null)) {
    if (!isObj(item) || typeof item.name !== "string") continue;
    const isRunningTotal = opts.runningTotals.has(item.name);
    for (const v of arr(item.values)) {
      if (!isObj(v) || typeof v.end_time !== "string") continue;
      const day = pageDayFromEndTime(v.end_time);
      if (!day) continue;
      if (isObj(v.value)) {
        for (const [key, raw] of Object.entries(v.value)) {
          const n = num(raw);
          if (n !== null) rows.push({ metric: item.name, day, dayZone: PAGE_DAY_ZONE, breakdown: breakdownKey({ type: key }), value: n, isRunningTotal });
        }
        continue;
      }
      const n = num(v.value);
      if (n !== null) rows.push({ metric: item.name, day, dayZone: PAGE_DAY_ZONE, breakdown: "", value: n, isRunningTotal });
    }
  }
  return rows;
}

/** Post insights (lifetime) -> rows for `day`, all running totals; adds post_reactions_total. */
export function parsePostInsights(json: unknown, day: string): MetricRow[] {
  const rows: MetricRow[] = [];
  const row = (metric: string, breakdown: string, value: number): MetricRow => ({
    metric,
    day,
    dayZone: LAGOS_ZONE,
    breakdown,
    value,
    isRunningTotal: true,
  });
  for (const item of arr(isObj(json) ? json.data : null)) {
    if (!isObj(item) || typeof item.name !== "string") continue;
    const first = arr(item.values)[0];
    if (!isObj(first)) continue;
    if (isObj(first.value)) {
      let sum = 0;
      for (const [key, raw] of Object.entries(first.value)) {
        const n = num(raw);
        if (n === null) continue;
        rows.push(row(item.name, breakdownKey({ type: key }), n));
        sum += n;
      }
      // Meta answered for this post (an empty object is "no reactions"), so the total is real.
      if (item.name === "post_reactions_by_type_total") rows.push(row("post_reactions_total", "", sum));
      continue;
    }
    const n = num(first.value);
    if (n !== null) rows.push(row(item.name, "", n));
  }
  return rows;
}

// ── Instagram ────────────────────────────────────────────────────────────────

/**
 * Instagram total_value response for one requested day -> rows; one row per breakdown
 * result when breakdowns are present, else one row with breakdown "".
 */
export function parseIgAccountInsights(json: unknown, day: string): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const item of arr(isObj(json) ? json.data : null)) {
    if (!isObj(item) || typeof item.name !== "string" || !isObj(item.total_value)) continue;
    const total = item.total_value;
    if (Array.isArray(total.breakdowns)) {
      for (const b of total.breakdowns) {
        if (!isObj(b)) continue;
        const keys = arr(b.dimension_keys).map(String);
        for (const r of arr(b.results)) {
          if (!isObj(r)) continue;
          const n = num(r.value);
          const values = arr(r.dimension_values).map(String);
          if (n === null || keys.length === 0 || values.length !== keys.length) continue;
          const pairs: Record<string, string> = {};
          keys.forEach((k, i) => (pairs[k] = values[i]!));
          rows.push({ metric: item.name, day, dayZone: LAGOS_ZONE, breakdown: breakdownKey(pairs), value: n, isRunningTotal: false });
        }
      }
      continue;
    }
    const n = num(total.value);
    if (n !== null) rows.push({ metric: item.name, day, dayZone: LAGOS_ZONE, breakdown: "", value: n, isRunningTotal: false });
  }
  return rows;
}

/** Instagram media insights -> rows for `day`, running totals. Reads total_value.value, else values[0].value. */
export function parseIgMediaInsights(json: unknown, day: string): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const item of arr(isObj(json) ? json.data : null)) {
    if (!isObj(item) || typeof item.name !== "string") continue;
    let n = isObj(item.total_value) ? num(item.total_value.value) : null;
    if (n === null) {
      const first = arr(item.values)[0];
      n = isObj(first) ? num(first.value) : null;
    }
    if (n !== null) rows.push({ metric: item.name, day, dayZone: LAGOS_ZONE, breakdown: "", value: n, isRunningTotal: true });
  }
  return rows;
}

/** Unix seconds for 00:00 and 24:00 of a Lagos day (UTC+1, no daylight saving). */
export function lagosDayBounds(day: string): { since: number; until: number } {
  const since = Date.parse(`${day}T00:00:00Z`) / 1000 - 3600;
  return { since, until: since + 86_400 };
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────

/** `x.data_points`, or every `x.data[].data_points` (Meta wraps some answers in a data list). */
function dataPoints(x: unknown): Obj[] {
  if (!isObj(x)) return [];
  const direct = arr(x.data_points);
  const nested = arr(x.data).flatMap((d) => (isObj(d) ? arr(d.data_points) : []));
  return [...direct, ...nested].filter(isObj);
}

/** Adds values that share metric, day and breakdown, so one upsert never meets the same key twice. */
function addUp(rows: MetricRow[]): MetricRow[] {
  const byKey = new Map<string, MetricRow>();
  for (const r of rows) {
    const key = `${r.metric}|${r.day}|${r.breakdown}`;
    const hit = byKey.get(key);
    if (hit) hit.value += r.value;
    else byKey.set(key, { ...r });
  }
  return [...byKey.values()];
}

/** analytics.data_points -> wa_sent / wa_delivered rows; day = UTC date of `start`. */
export function parseWaAnalytics(json: unknown, breakdown: string): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const p of dataPoints(isObj(json) ? json.analytics : null)) {
    const start = num(p.start);
    if (start === null) continue;
    const day = utcDayOfUnix(start);
    const sent = num(p.sent);
    const delivered = num(p.delivered);
    if (sent !== null) rows.push({ metric: "wa_sent", day, dayZone: UTC_ZONE, breakdown, value: sent, isRunningTotal: false });
    if (delivered !== null) rows.push({ metric: "wa_delivered", day, dayZone: UTC_ZONE, breakdown, value: delivered, isRunningTotal: false });
  }
  return addUp(rows);
}

/** pricing_analytics.data_points -> wa_billable / wa_cost rows with breakdown "category=X;type=Y". */
export function parseWaPricing(json: unknown): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const p of dataPoints(isObj(json) ? json.pricing_analytics : null)) {
    const start = num(p.start);
    if (start === null || typeof p.pricing_category !== "string" || typeof p.pricing_type !== "string") continue;
    const day = utcDayOfUnix(start);
    const breakdown = breakdownKey({ category: p.pricing_category, type: p.pricing_type });
    const volume = num(p.volume);
    const cost = num(p.cost);
    if (volume !== null) rows.push({ metric: "wa_billable", day, dayZone: UTC_ZONE, breakdown, value: volume, isRunningTotal: false });
    if (cost !== null) rows.push({ metric: "wa_cost", day, dayZone: UTC_ZONE, breakdown, value: cost, isRunningTotal: false });
  }
  return addUp(rows);
}

/** template_analytics -> { templateId, rows }[]. tmpl_clicked is the sum of the button counts. */
export function parseTemplateAnalytics(json: unknown): { templateId: string; rows: MetricRow[] }[] {
  const byTemplate = new Map<string, MetricRow[]>();
  for (const block of arr(isObj(json) ? json.data : null)) {
    for (const p of dataPoints(block)) {
      const start = num(p.start);
      const templateId = typeof p.template_id === "string" || typeof p.template_id === "number" ? String(p.template_id) : "";
      if (start === null || !templateId) continue;
      const day = utcDayOfUnix(start);
      const rows = byTemplate.get(templateId) ?? [];
      const push = (metric: string, value: number | null): void => {
        if (value !== null) rows.push({ metric, day, dayZone: UTC_ZONE, breakdown: "", value, isRunningTotal: false });
      };
      push("tmpl_sent", num(p.sent));
      push("tmpl_delivered", num(p.delivered));
      push("tmpl_read", num(p.read));
      if (Array.isArray(p.clicked)) {
        let clicks = 0;
        for (const c of p.clicked) clicks += (isObj(c) ? num(c.count) : null) ?? 0;
        push("tmpl_clicked", clicks);
      }
      byTemplate.set(templateId, rows);
    }
  }
  return [...byTemplate.entries()].map(([templateId, rows]) => ({ templateId, rows: addUp(rows) }));
}

// ── Series and totals ────────────────────────────────────────────────────────

/** Longest series the helpers will build (the screen shows at most 400 days). */
const MAX_SERIES_DAYS = 800;

/** Every day from..to inclusive with value null where no row exists. */
export function fillSeries(from: string, to: string, rows: { day: string; value: number }[]): { day: string; value: number | null }[] {
  const out: { day: string; value: number | null }[] = [];
  if (!isDayKey(from) || !isDayKey(to) || from > to) return out;
  const byDay = new Map(rows.map((r) => [r.day, r.value]));
  for (let day = from; day <= to && out.length < MAX_SERIES_DAYS; day = addDays(day, 1)) {
    out.push({ day, value: byDay.get(day) ?? null });
  }
  return out;
}

/** Sum for flow metrics; last non-null value for running totals; null if every day is null. */
export function rangeTotal(points: { value: number | null }[], isRunningTotal: boolean): number | null {
  const known = points.filter((p): p is { value: number } => p.value !== null);
  if (known.length === 0) return null;
  if (isRunningTotal) return known[known.length - 1]!.value;
  return known.reduce((s, p) => s + p.value, 0);
}

/** The average over the days that have a figure; null if none has. */
export function rangeDailyAverage(points: { value: number | null }[]): number | null {
  const known = points.filter((p): p is { value: number } => p.value !== null);
  if (known.length === 0) return null;
  return known.reduce((s, p) => s + p.value, 0) / known.length;
}

/** For running totals: last non-null minus first non-null in the range; null if fewer than two points. */
export function rangeChange(points: { value: number | null }[]): number | null {
  const known = points.filter((p): p is { value: number } => p.value !== null);
  if (known.length < 2) return null;
  return known[known.length - 1]!.value - known[0]!.value;
}
