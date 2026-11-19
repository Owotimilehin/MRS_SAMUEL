/**
 * Statistics from Meta (suite spec 11): the Graph calls, the store and the daily
 * collector.
 *
 * Everything here READS from Meta, with one exception that is never called from
 * the collector: enableTemplateAnalytics, the owner-only, permanent switch behind
 * a confirmation in the API route.
 *
 * The collector never holds a database transaction open across a call to Meta:
 * each call finishes first, then its rows are written with one upsert. Re-running
 * a day overwrites that day's values; nothing is ever added to a stored value, and
 * a figure Meta did not return is never written as zero.
 *
 * Page and Instagram calls use the Page token (kept in memory by accounts.ts,
 * never stored or logged); WhatsApp calls use the system-user token.
 */
import { and, eq, gt, gte, isNotNull, isNull, sql } from "drizzle-orm";
import {
  INSIGHTS_STATE_KEY,
  appSetting,
  inboxPhoneNumber,
  insightMetricDaily,
  insightSubject,
  outboxEvent,
  type DbClient,
  type DbExecutor,
  type InsightsStateValue,
} from "@ms/db";
import {
  IG_ACCOUNT_METRICS,
  PAGE_DAY_ZONE,
  PAGE_METRICS,
  PAGE_RUNNING_TOTALS,
  POST_METRICS,
  LAGOS_ZONE,
  addDays,
  dayInZone,
  igMediaMetricsFor,
  lagosDayBounds,
  lagosDayOf,
  parseIgAccountInsights,
  parseIgMediaInsights,
  parsePageInsights,
  parsePostInsights,
  parseTemplateAnalytics,
  parseWaAnalytics,
  parseWaPricing,
  type InsightSource,
  type MetricRow,
} from "@ms/shared";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { listChannelAccounts } from "./accounts.js";
import { withPageTokenRetry } from "./messaging.js";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

const enc = encodeURIComponent;
const MAX_LIST_PAGES = 5;

// ── Graph calls (all GET, except the owner's switch at the end) ──────────────

interface Paged<T> {
  data?: T[];
  paging?: { next?: string };
}

/**
 * GET /{pageId}/insights?metric=<csv>&period=day&since=<since>&until=<until>.
 * `until` is exclusive: pass the day after the last day wanted. The span may be at most 90 days.
 */
export async function fetchPageInsights(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
  metrics: string[],
  since: string,
  until: string,
): Promise<unknown> {
  return graph<unknown>(
    cfg,
    "GET",
    `${enc(pageId)}/insights?metric=${metrics.map(enc).join(",")}&period=day&since=${enc(since)}&until=${enc(until)}`,
    undefined,
    { token: pageToken },
  );
}

export interface PagePostListing {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
}

/**
 * GET /{pageId}/feed, newest first, following paging.next for up to 5 pages. Keeps
 * published posts created at or after sinceIso. `complete` is false when the 5-page
 * cap stopped the listing before it reached sinceIso.
 */
export async function listPagePostsPaged(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
  sinceIso: string,
  onCall?: () => Promise<void>,
): Promise<{ posts: PagePostListing[]; complete: boolean }> {
  const since = Date.parse(sinceIso);
  const posts: PagePostListing[] = [];
  let next: string | null = `${enc(pageId)}/feed?fields=id,message,created_time,permalink_url,is_published&limit=100`;
  let reachedEnd = false;
  for (let page = 0; next && page < MAX_LIST_PAGES; page++) {
    const res: Paged<PagePostListing & { is_published?: boolean }> = await graph(cfg, "GET", next, undefined, { token: pageToken });
    await onCall?.();
    for (const p of res?.data ?? []) {
      if (!p?.id || typeof p.created_time !== "string") continue;
      const at = Date.parse(p.created_time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      if (Number.isNaN(at)) continue;
      if (at < since) {
        reachedEnd = true;
        continue;
      }
      if (p.is_published === false) continue;
      posts.push({
        id: p.id,
        created_time: new Date(at).toISOString(),
        ...(p.message !== undefined ? { message: p.message } : {}),
        ...(p.permalink_url !== undefined ? { permalink_url: p.permalink_url } : {}),
      });
    }
    next = reachedEnd ? null : (res?.paging?.next ?? null);
  }
  return { posts, complete: next === null };
}

export async function listPagePosts(cfg: MetaConfig, pageToken: string, pageId: string, sinceIso: string): Promise<PagePostListing[]> {
  return (await listPagePostsPaged(cfg, pageToken, pageId, sinceIso)).posts;
}

/** GET /{postId}/insights?metric=… (lifetime figures of one Page post). */
export async function fetchPostInsights(cfg: MetaConfig, pageToken: string, postId: string, metrics: readonly string[] = POST_METRICS): Promise<unknown> {
  return graph<unknown>(cfg, "GET", `${enc(postId)}/insights?metric=${metrics.map(enc).join(",")}`, undefined, { token: pageToken });
}

/**
 * GET /{igId}/insights?metric=<csv>&period=day&metric_type=total_value&since=&until=[&breakdown=]
 * for one Lagos day.
 */
export async function fetchIgAccountInsights(
  cfg: MetaConfig,
  pageToken: string,
  igId: string,
  metrics: string[],
  day: string,
  breakdown?: string,
): Promise<unknown> {
  const { since, until } = lagosDayBounds(day);
  return graph<unknown>(
    cfg,
    "GET",
    `${enc(igId)}/insights?metric=${metrics.map(enc).join(",")}&period=day&metric_type=total_value&since=${since}&until=${until}` +
      (breakdown ? `&breakdown=${enc(breakdown)}` : ""),
    undefined,
    { token: pageToken },
  );
}

export async function fetchIgProfile(cfg: MetaConfig, pageToken: string, igId: string): Promise<{ followers_count?: number; media_count?: number }> {
  return graph(cfg, "GET", `${enc(igId)}?fields=followers_count,media_count`, undefined, { token: pageToken });
}

export interface IgMediaListing {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp: string;
}

/** GET /{igId}/media, newest first, up to 5 pages; keeps items at or after sinceIso. */
export async function listIgMediaPaged(
  cfg: MetaConfig,
  pageToken: string,
  igId: string,
  sinceIso: string,
  onCall?: () => Promise<void>,
): Promise<{ media: IgMediaListing[]; complete: boolean }> {
  const since = Date.parse(sinceIso);
  const media: IgMediaListing[] = [];
  let next: string | null = `${enc(igId)}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=50`;
  let reachedEnd = false;
  for (let page = 0; next && page < MAX_LIST_PAGES; page++) {
    const res: Paged<IgMediaListing> = await graph(cfg, "GET", next, undefined, { token: pageToken });
    await onCall?.();
    for (const m of res?.data ?? []) {
      if (!m?.id || typeof m.timestamp !== "string") continue;
      const at = Date.parse(m.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      if (Number.isNaN(at)) continue;
      if (at < since) {
        reachedEnd = true;
        continue;
      }
      media.push({ ...m, timestamp: new Date(at).toISOString() });
    }
    next = reachedEnd ? null : (res?.paging?.next ?? null);
  }
  return { media, complete: next === null };
}

export async function listIgMedia(cfg: MetaConfig, pageToken: string, igId: string, sinceIso: string): Promise<IgMediaListing[]> {
  return (await listIgMediaPaged(cfg, pageToken, igId, sinceIso)).media;
}

/** GET /{igId}/stories: the stories that are live now (Meta keeps them 24 hours). */
export async function listIgStories(
  cfg: MetaConfig,
  pageToken: string,
  igId: string,
): Promise<{ id: string; media_type?: string; permalink?: string; timestamp: string }[]> {
  const res = await graph<Paged<{ id: string; media_type?: string; permalink?: string; timestamp: string }>>(
    cfg,
    "GET",
    `${enc(igId)}/stories?fields=id,media_type,permalink,timestamp`,
    undefined,
    { token: pageToken },
  );
  const out: { id: string; media_type?: string; permalink?: string; timestamp: string }[] = [];
  for (const s of res?.data ?? []) {
    if (!s?.id || typeof s.timestamp !== "string") continue;
    const at = Date.parse(s.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isNaN(at)) out.push({ ...s, timestamp: new Date(at).toISOString() });
  }
  return out;
}

export async function fetchIgMediaInsights(cfg: MetaConfig, pageToken: string, mediaId: string, metrics: string[]): Promise<unknown> {
  return graph<unknown>(cfg, "GET", `${enc(mediaId)}/insights?metric=${metrics.map(enc).join(",")}`, undefined, { token: pageToken });
}

const WA = { service: "WhatsApp" } as const;

/** GET /{wabaId}?fields=analytics.start(s).end(e).granularity(DAY)[.product_types([n])] — 0 templates, 2 ordinary messages. */
export async function fetchWaAnalytics(cfg: MetaConfig, wabaId: string, startUnix: number, endUnix: number, productType?: 0 | 2): Promise<unknown> {
  const expr =
    `analytics.start(${Math.floor(startUnix)}).end(${Math.floor(endUnix)}).granularity(DAY)` +
    (productType !== undefined ? `.product_types([${productType}])` : "");
  return graph<unknown>(cfg, "GET", `${enc(wabaId)}?fields=${enc(expr)}`, undefined, WA);
}

/** GET /{wabaId}?fields=pricing_analytics.start(s).end(e).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"]) */
export async function fetchWaPricing(cfg: MetaConfig, wabaId: string, startUnix: number, endUnix: number): Promise<unknown> {
  const expr = `pricing_analytics.start(${Math.floor(startUnix)}).end(${Math.floor(endUnix)}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
  return graph<unknown>(cfg, "GET", `${enc(wabaId)}?fields=${enc(expr)}`, undefined, WA);
}

/** GET /{wabaId}?fields=currency: the account's billing currency code, or null when Meta does not say. */
export async function fetchWaCurrency(cfg: MetaConfig, wabaId: string): Promise<string | null> {
  const res = await graph<{ currency?: unknown }>(cfg, "GET", `${enc(wabaId)}?fields=currency`, undefined, WA);
  return typeof res?.currency === "string" && /^[A-Z]{3}$/.test(res.currency) ? res.currency : null;
}

export async function listWaTemplateIds(cfg: MetaConfig, wabaId: string): Promise<{ id: string; name: string; language: string; status: string }[]> {
  const out: { id: string; name: string; language: string; status: string }[] = [];
  let next: string | null = `${enc(wabaId)}/message_templates?fields=id,name,language,status&limit=100`;
  for (let page = 0; next && page < 10; page++) {
    const res: Paged<{ id?: string; name?: string; language?: string; status?: string }> = await graph(cfg, "GET", next, undefined, WA);
    for (const t of res?.data ?? []) {
      if (t?.id) out.push({ id: String(t.id), name: t.name ?? "", language: t.language ?? "", status: t.status ?? "" });
    }
    next = res?.paging?.next ?? null;
  }
  return out;
}

/** GET /{wabaId}/template_analytics for at most 10 template IDs, daily. */
export async function fetchTemplateAnalytics(cfg: MetaConfig, wabaId: string, templateIds: string[], startUnix: number, endUnix: number): Promise<unknown> {
  if (templateIds.length === 0 || templateIds.length > 10) throw new Error("fetchTemplateAnalytics takes 1 to 10 template IDs");
  const ids = `[${templateIds.map((id) => JSON.stringify(id)).join(",")}]`;
  const types = `["SENT","DELIVERED","READ","CLICKED"]`;
  return graph<unknown>(
    cfg,
    "GET",
    `${enc(wabaId)}/template_analytics?start=${Math.floor(startUnix)}&end=${Math.floor(endUnix)}&granularity=DAILY&template_ids=${enc(ids)}&metric_types=${enc(types)}`,
    undefined,
    WA,
  );
}

/**
 * POST /{wabaId}?is_enabled_for_insights=true. PERMANENT at Meta: it cannot be turned
 * off again, and it switches on link tracking in templates. Only the owner's confirmed,
 * audited route calls this. The collector never does.
 */
export async function enableTemplateAnalytics(cfg: MetaConfig, wabaId: string): Promise<void> {
  const res = await graph<{ success?: boolean } | null>(cfg, "POST", `${enc(wabaId)}?is_enabled_for_insights=true`, undefined, WA);
  if (res && res.success === false) throw new MetaApiError("WhatsApp did not confirm the change", 502, null, false);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface MetricKey {
  source: string;
  accountKey: string;
  accountId: string | null;
  subjectId: string;
}

/**
 * Upsert rows; on conflict update value and fetched_at (never add). Returns how many
 * rows were written. Two rows for the same figure and day in one call: the last wins.
 */
export async function saveMetricRows(db: DbExecutor, key: MetricKey, rows: MetricRow[]): Promise<number> {
  const unique = new Map<string, MetricRow>();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    unique.set(`${r.metric}|${r.day}|${r.breakdown}`, r);
  }
  const list = [...unique.values()];
  for (let i = 0; i < list.length; i += 500) {
    await db
      .insert(insightMetricDaily)
      .values(
        list.slice(i, i + 500).map((r) => ({
          source: key.source,
          accountKey: key.accountKey,
          accountId: key.accountId,
          subjectId: key.subjectId,
          metric: r.metric,
          day: r.day,
          dayZone: r.dayZone,
          breakdown: r.breakdown,
          value: String(r.value),
          isRunningTotal: r.isRunningTotal,
        })),
      )
      .onConflictDoUpdate({
        target: [
          insightMetricDaily.source,
          insightMetricDaily.accountKey,
          insightMetricDaily.subjectId,
          insightMetricDaily.metric,
          insightMetricDaily.day,
          insightMetricDaily.breakdown,
        ],
        set: { value: sql`excluded."value"`, fetchedAt: sql`now()` },
      });
  }
  return list.length;
}

// ── Collector state (app_settings, key insights_state) ───────────────────────

export type InsightsSourceState = InsightsStateValue["sources"][string];
/** The stored state plus one optional extra: each WABA's billing currency code, when Meta told us. */
export type InsightsState = InsightsStateValue & { currencies?: Record<string, string> };

const EMPTY_STATE: InsightsState = {
  last_daily_run_day: null,
  last_run_at: null,
  refresh_requested_at: null,
  sources: {},
  template_analytics: {},
};

export const EMPTY_SOURCE_STATE: InsightsSourceState = {
  last_ok_at: null,
  backfilled: false,
  problem_code: null,
  problem_message: null,
  invalid_metrics: [],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The stored state with every missing piece filled in. */
export function normaliseInsightsState(raw: unknown): InsightsState {
  const v = isObj(raw) ? raw : {};
  const sources: InsightsState["sources"] = {};
  for (const [k, s] of Object.entries(isObj(v.sources) ? v.sources : {})) {
    if (!isObj(s)) continue;
    sources[k] = {
      last_ok_at: strOrNull(s.last_ok_at),
      backfilled: s.backfilled === true,
      problem_code: strOrNull(s.problem_code),
      problem_message: strOrNull(s.problem_message),
      invalid_metrics: Array.isArray(s.invalid_metrics) ? s.invalid_metrics.filter((m): m is string => typeof m === "string") : [],
    };
  }
  const templates: InsightsState["template_analytics"] = {};
  for (const [k, t] of Object.entries(isObj(v.template_analytics) ? v.template_analytics : {})) {
    if (isObj(t) && typeof t.enabled_at === "string") templates[k] = { enabled_at: t.enabled_at, enabled_by: String(t.enabled_by ?? "") };
  }
  const currencies: Record<string, string> = {};
  for (const [k, c] of Object.entries(isObj(v.currencies) ? v.currencies : {})) if (typeof c === "string") currencies[k] = c;
  return {
    last_daily_run_day: strOrNull(v.last_daily_run_day),
    last_run_at: strOrNull(v.last_run_at),
    refresh_requested_at: strOrNull(v.refresh_requested_at),
    sources,
    template_analytics: templates,
    currencies,
  };
}

export async function readInsightsState(db: DbExecutor): Promise<InsightsState> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, INSIGHTS_STATE_KEY));
  return normaliseInsightsState(row?.value);
}

async function ensureInsightsState(db: DbExecutor): Promise<void> {
  await db.insert(appSetting).values({ key: INSIGHTS_STATE_KEY, value: EMPTY_STATE }).onConflictDoNothing();
}

/**
 * Change top-level fields of the state in one statement, so the API (Refresh) and the
 * worker (run times) never overwrite each other's fields.
 */
export async function patchInsightsState(
  db: DbExecutor,
  patch: Partial<Pick<InsightsStateValue, "last_daily_run_day" | "last_run_at" | "refresh_requested_at">>,
): Promise<void> {
  await ensureInsightsState(db);
  await db
    .update(appSetting)
    .set({ value: sql`${appSetting.value} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(appSetting.key, INSIGHTS_STATE_KEY));
}

/** Set one entry of a map inside the state (sources, template_analytics, currencies) without touching the others. */
async function setStateEntry(db: DbExecutor, map: "sources" | "template_analytics" | "currencies", key: string, value: unknown): Promise<void> {
  await ensureInsightsState(db);
  await db
    .update(appSetting)
    .set({
      // `map` is one of three fixed names (never user input), so it is written into the statement as text.
      value: sql`jsonb_set(${appSetting.value}, ${sql.raw(`'{${map}}'`)}, coalesce(${appSetting.value}->${sql.raw(`'${map}'`)}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb), true)`,
      updatedAt: new Date(),
    })
    .where(eq(appSetting.key, INSIGHTS_STATE_KEY));
}

/**
 * Take the "a collection is running" marker, or return false when another worker holds
 * a fresh one. One statement, no transaction left open: the run that follows talks to
 * Meta for a minute or more. A marker older than `staleMinutes` (a worker that died)
 * is taken over.
 */
export async function claimInsightsRun(db: DbExecutor, now: Date = new Date(), staleMinutes = 30): Promise<boolean> {
  await ensureInsightsState(db);
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  const rows = await db
    .update(appSetting)
    .set({ value: sql`${appSetting.value} || ${JSON.stringify({ run_claimed_at: now.toISOString() })}::jsonb`, updatedAt: new Date() })
    .where(
      and(
        eq(appSetting.key, INSIGHTS_STATE_KEY),
        // ISO times in UTC sort as text.
        sql`(${appSetting.value}->>'run_claimed_at' is null or ${appSetting.value}->>'run_claimed_at' < ${cutoff})`,
      ),
    )
    .returning({ key: appSetting.key });
  return rows.length > 0;
}

/** Give the marker back. */
export async function releaseInsightsRun(db: DbExecutor): Promise<void> {
  await db
    .update(appSetting)
    .set({ value: sql`${appSetting.value} || '{"run_claimed_at": null}'::jsonb`, updatedAt: new Date() })
    .where(eq(appSetting.key, INSIGHTS_STATE_KEY));
}

export async function saveInsightsSourceState(db: DbExecutor, key: string, value: InsightsSourceState): Promise<void> {
  await setStateEntry(db, "sources", key, value);
}

/** Record that the owner turned template figures on for a WABA (after Meta said yes). */
export async function recordTemplateAnalyticsEnabled(db: DbExecutor, wabaId: string, by: string, at: Date = new Date()): Promise<void> {
  await setStateEntry(db, "template_analytics", wabaId, { enabled_at: at.toISOString(), enabled_by: by });
}

/** The WABA IDs of the active WhatsApp phone lines, each once. */
export async function listInsightWabaIds(db: DbExecutor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ wabaId: inboxPhoneNumber.wabaId })
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, "phone"), eq(inboxPhoneNumber.isActive, true), isNotNull(inboxPhoneNumber.wabaId)));
  return rows
    .map((r) => r.wabaId)
    .filter((w): w is string => !!w)
    .sort();
}

// ── The store the collector writes through ───────────────────────────────────

export interface InsightSubjectInput {
  subjectId: string;
  kind: string | null;
  title: string | null;
  permalink: string | null;
  publishedAt: Date | null;
}

export interface InsightAccount {
  /** inbox_phone_number.id */
  id: string;
  label: string;
  /** Page ID, or Instagram account ID. */
  externalId: string;
  /** The Page whose token reads it. */
  pageId: string;
}

/**
 * Everything the collector reads and writes besides Meta. The default is the
 * database (dbInsightsStore); the unit tests pass one held in memory.
 */
export interface InsightsStore {
  pages(): Promise<InsightAccount[]>;
  instagramAccounts(): Promise<InsightAccount[]>;
  wabaIds(): Promise<string[]>;
  readState(): Promise<InsightsState>;
  saveSourceState(key: string, value: InsightsSourceState): Promise<void>;
  saveCurrency(wabaId: string, currency: string): Promise<void>;
  saveRows(key: MetricKey, rows: MetricRow[]): Promise<number>;
  upsertSubjects(source: InsightSource, accountKey: string, subjects: InsightSubjectInput[], seenAt: Date): Promise<void>;
  /** Subjects of an account published at or after `since`: the ones Meta said are gone, and the ones still live. */
  subjects(source: InsightSource, accountKey: string, since: Date): Promise<{ subjectId: string; kind: string | null; gone: boolean }[]>;
  markGone(source: InsightSource, subjectId: string, at: Date): Promise<void>;
  /** One owner alert per 24 hours per `account` value. */
  alertOnce(payload: Record<string, unknown> & { account: string }): Promise<void>;
}

export function dbInsightsStore(db: DbExecutor): InsightsStore {
  const accounts = async (kind: "messenger" | "instagram"): Promise<InsightAccount[]> =>
    (await listChannelAccounts(db, kind))
      .filter((a) => a.isActive && a.externalId && a.pageId)
      .map((a) => ({ id: a.id, label: a.label, externalId: a.externalId!, pageId: a.pageId! }));
  return {
    pages: () => accounts("messenger"),
    instagramAccounts: () => accounts("instagram"),
    wabaIds: () => listInsightWabaIds(db),
    readState: () => readInsightsState(db),
    saveSourceState: (key, value) => saveInsightsSourceState(db, key, value),
    saveCurrency: (wabaId, currency) => setStateEntry(db, "currencies", wabaId, currency),
    saveRows: (key, rows) => saveMetricRows(db, key, rows),
    async upsertSubjects(source, accountKey, subjects, seenAt) {
      for (let i = 0; i < subjects.length; i += 200) {
        await db
          .insert(insightSubject)
          .values(
            subjects.slice(i, i + 200).map((s) => ({
              source,
              accountKey,
              subjectId: s.subjectId,
              kind: s.kind,
              title: s.title,
              permalink: s.permalink,
              publishedAt: s.publishedAt,
              lastSeenAt: seenAt,
            })),
          )
          .onConflictDoUpdate({
            target: [insightSubject.source, insightSubject.subjectId],
            set: {
              accountKey: sql`excluded."account_key"`,
              kind: sql`excluded."kind"`,
              title: sql`excluded."title"`,
              permalink: sql`excluded."permalink"`,
              publishedAt: sql`excluded."published_at"`,
              lastSeenAt: sql`excluded."last_seen_at"`,
            },
          });
      }
    },
    async subjects(source, accountKey, since) {
      const rows = await db
        .select({ subjectId: insightSubject.subjectId, kind: insightSubject.kind, goneAt: insightSubject.goneAt })
        .from(insightSubject)
        .where(and(eq(insightSubject.source, source), eq(insightSubject.accountKey, accountKey), gte(insightSubject.publishedAt, since)));
      return rows.map((r) => ({ subjectId: r.subjectId, kind: r.kind, gone: r.goneAt !== null }));
    },
    async markGone(source, subjectId, at) {
      await db
        .update(insightSubject)
        .set({ goneAt: at })
        .where(and(eq(insightSubject.source, source), eq(insightSubject.subjectId, subjectId), isNull(insightSubject.goneAt)));
    },
    async alertOnce(payload) {
      const [recent] = await db
        .select({ id: outboxEvent.id })
        .from(outboxEvent)
        .where(
          and(
            eq(outboxEvent.eventType, INSIGHTS_ALERT_EVENT),
            gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
            sql`${outboxEvent.payload}->>'account' = ${payload.account}`,
          ),
        )
        .limit(1);
      if (!recent) await db.insert(outboxEvent).values({ eventType: INSIGHTS_ALERT_EVENT, payload });
    },
  };
}

/** The owner alert the collector raises (a case in apps/worker/src/outbox.ts turns it into words). */
export const INSIGHTS_ALERT_EVENT = "insights.config_error";

// ── Errors ───────────────────────────────────────────────────────────────────

export type InsightsProblemCode = "token" | "no_permission" | "too_small" | "temporary" | "other";

export const INSIGHTS_PROBLEM_TEXT = {
  token: "The connection to Meta has expired. Tell the technical team.",
  no_permission: "Meta has not given the suite permission to read these figures.",
  too_small: "Facebook only shares these figures once the Page has 100 likes, and only with permission to read them.",
  temporary: "Meta was busy. We will try again on the next run.",
  all_invalid: "Meta no longer provides these figures under the names the suite uses. Tell the technical team.",
  ours: "Something went wrong on our side while collecting these figures. We will try again on the next run.",
} as const;

const PERMISSION_CODES = new Set(["10", "200", "299", "283", "no_page_token"]);
const TEMPORARY_CODES = new Set(["4", "17", "32", "613", "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80007", "80008", "80009", "80014"]);

/** Foundation D10 with corrections C2 and C3, for the insights reads. Code 100 is decided by the caller. */
export function classifyInsightsError(err: MetaApiError): { code: Exclude<InsightsProblemCode, "too_small">; message: string } {
  const code = err.code ?? "";
  if (code === "190") return { code: "token", message: INSIGHTS_PROBLEM_TEXT.token };
  if (PERMISSION_CODES.has(code)) return { code: "no_permission", message: INSIGHTS_PROBLEM_TEXT.no_permission };
  if (TEMPORARY_CODES.has(code) || err.status === 429 || err.status >= 500 || err.status === 0 || err.retryable) {
    return { code: "temporary", message: INSIGHTS_PROBLEM_TEXT.temporary };
  }
  return { code: "other", message: `Meta said: ${err.message}${code ? ` (code ${code})` : ""}`.slice(0, 500) };
}

/** A problem the collector decided itself (not a Meta error). */
class SourceProblem extends Error {
  constructor(
    public readonly problem: InsightsProblemCode,
    message: string,
  ) {
    super(message);
  }
}

/** The token is not accepted: nothing else can work, so the whole run stops. */
class StopRun extends Error {}

const isCode = (err: unknown, code: string): err is MetaApiError => err instanceof MetaApiError && err.code === code;
/** Code 100 that names a metric (spec fact P5): "(#100) The value must be a valid insights metric". */
const namesMetric = (err: MetaApiError): boolean => /metric/i.test(err.message);

// ── The collector ────────────────────────────────────────────────────────────

export interface InsightsCollectionOptions {
  now?: Date;
  /** Only measure Instagram stories that are under 24 hours old (the hourly pass). */
  storiesOnly?: boolean;
  /** Pause after every Graph call. Default 200 ms. */
  sleepMs?: number;
  /** Where rows and state go. Default: the database. */
  store?: InsightsStore;
}

interface StepCtx {
  prev: InsightsSourceState;
  invalid: Set<string>;
  /** Call once the back-fill window has been read, so a later failure does not repeat it. */
  markBackfilled(): void;
}

const DAY_MS = 86_400_000;
const first120 = (s: string | undefined): string | null => (s && s.trim() ? s.trim().slice(0, 120) : null);

/**
 * Read every source once and store what Meta returned. Each source is tried on its
 * own: a failure is recorded against that source and the run carries on, except a
 * rejected token (code 190), which stops the run.
 */
export async function runInsightsCollection(
  db: DbClient,
  cfg: MetaConfig,
  log: Log,
  opts: InsightsCollectionOptions = {},
): Promise<{ written: number; problems: number }> {
  const store = opts.store ?? dbInsightsStore(db);
  const now = opts.now ?? new Date();
  const sleepMs = opts.sleepMs ?? 200;
  const storiesOnly = opts.storiesOnly === true;
  const pause = (): Promise<void> => (sleepMs > 0 ? new Promise((resolve) => setTimeout(resolve, sleepMs)) : Promise.resolve());
  /** One Graph call, then the pause that keeps us well inside Meta's limits. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      await pause();
    }
  };

  const state = await store.readState();
  const today = lagosDayOf(now);
  let written = 0;
  let problems = 0;

  /** Run one source. Records what happened; never throws, except StopRun. */
  async function step(source: InsightSource, accountKey: string, label: string, fn: (ctx: StepCtx) => Promise<void>): Promise<void> {
    const key = `${source}:${accountKey}`;
    const prev = state.sources[key] ?? EMPTY_SOURCE_STATE;
    const invalid = new Set(prev.invalid_metrics);
    let backfilled = prev.backfilled;
    const ctx: StepCtx = { prev, invalid, markBackfilled: () => (backfilled = true) };
    const save = async (patch: Partial<InsightsSourceState>): Promise<void> => {
      if (storiesOnly) return; // the hourly stories pass leaves the daily run's record alone
      const next: InsightsSourceState = { ...prev, backfilled, invalid_metrics: [...invalid].sort(), ...patch };
      state.sources[key] = next;
      await store.saveSourceState(key, next);
    };
    try {
      await fn(ctx);
      await save({ last_ok_at: now.toISOString(), backfilled: true, problem_code: null, problem_message: null });
    } catch (err) {
      problems++;
      if (err instanceof SourceProblem) {
        await save({ problem_code: err.problem, problem_message: err.message });
        return;
      }
      if (!(err instanceof MetaApiError)) {
        log.error({ err, source, accountKey }, "insights collection failed on our side");
        await save({ problem_code: "other", problem_message: INSIGHTS_PROBLEM_TEXT.ours }).catch(() => undefined);
        return;
      }
      const cls = classifyInsightsError(err);
      log.warn({ source, accountKey, metaCode: err.code, metaSubcode: err.subcode, status: err.status, problem: cls.code }, "insights source could not be read");
      await save({ problem_code: cls.code, problem_message: cls.message });
      if (storiesOnly) return;
      if (cls.code === "token") {
        await store.alertOnce({ account: "token", source, label, code: err.code ?? "190", message: cls.message });
        throw new StopRun();
      }
      if (cls.code === "no_permission") {
        await store.alertOnce({ account: key, source, label, code: err.code ?? "", message: cls.message });
      }
    }
  }

  /**
   * One call for several metrics. If Meta refuses it with code 100 naming a metric,
   * ask again one metric at a time and remember each metric that fails alone.
   * `tag` keeps metrics of different kinds of item apart ("STORY:reach").
   */
  async function withMetricFallback(
    ctx: StepCtx,
    metrics: readonly string[],
    fetchMetrics: (metrics: string[]) => Promise<unknown>,
    logCtx: object,
    tag = "",
  ): Promise<unknown[]> {
    const valid = metrics.filter((m) => !ctx.invalid.has(tag + m));
    if (valid.length === 0) return [];
    const drop = (m: string): void => {
      ctx.invalid.add(tag + m);
      log.warn({ ...logCtx, metric: m }, "insights metric no longer valid");
    };
    try {
      return [await call(() => fetchMetrics(valid))];
    } catch (err) {
      if (!isCode(err, "100") || !namesMetric(err)) throw err;
      if (valid.length === 1) {
        drop(valid[0]!);
        return [];
      }
    }
    const out: unknown[] = [];
    for (const m of valid) {
      try {
        out.push(await call(() => fetchMetrics([m])));
      } catch (err) {
        if (!isCode(err, "100") || !namesMetric(err)) throw err;
        drop(m);
      }
    }
    return out;
  }

  const allInvalid = (ctx: StepCtx, metrics: readonly string[], tag = ""): boolean => metrics.every((m) => ctx.invalid.has(tag + m));

  // 1. Page figures.
  async function pageFigures(page: InsightAccount): Promise<void> {
    await step("facebook_page", page.externalId, page.label, async (ctx) => {
      if (allInvalid(ctx, PAGE_METRICS)) throw new SourceProblem("other", INSIGHTS_PROBLEM_TEXT.all_invalid);
      // Facebook's days are US Pacific days. The newest complete one is yesterday there.
      const last = addDays(dayInZone(now, PAGE_DAY_ZONE), -1);
      const days = ctx.prev.backfilled ? 7 : 90;
      const since = addDays(last, -(days - 1));
      const until = addDays(last, 1);
      const answers = await withMetricFallback(
        ctx,
        PAGE_METRICS,
        (metrics) => withPageTokenRetry(cfg, page.pageId, (token) => fetchPageInsights(cfg, token, page.externalId, metrics, since, until)),
        { source: "facebook_page", accountKey: page.externalId },
      );
      if (allInvalid(ctx, PAGE_METRICS)) throw new SourceProblem("other", INSIGHTS_PROBLEM_TEXT.all_invalid);
      const rows = answers.flatMap((a) => parsePageInsights(a, { runningTotals: PAGE_RUNNING_TOTALS }));
      // Under 100 likes, or without read_insights, Meta answers "ok" with nothing in it (P3, P5).
      if (rows.length === 0) throw new SourceProblem("too_small", INSIGHTS_PROBLEM_TEXT.too_small);
      written += await store.saveRows({ source: "facebook_page", accountKey: page.externalId, accountId: page.id, subjectId: "" }, rows);
    });
  }

  // 2. Page posts.
  async function pagePosts(page: InsightAccount): Promise<void> {
    await step("facebook_post", page.externalId, page.label, async (ctx) => {
      const since = new Date(now.getTime() - 90 * DAY_MS);
      const listing = await withPageTokenRetry(cfg, page.pageId, (token) => listPagePostsPaged(cfg, token, page.externalId, since.toISOString(), pause));
      await store.upsertSubjects(
        "facebook_post",
        page.externalId,
        listing.posts.map((p) => ({
          subjectId: p.id,
          kind: "post",
          title: first120(p.message),
          permalink: p.permalink_url ?? null,
          publishedAt: new Date(p.created_time),
        })),
        now,
      );
      ctx.markBackfilled();
      // Every post we know from the last 90 days that Meta has not said is gone. A post missing
      // from the listing is still asked about once: Meta's own answer (code 100) marks it gone.
      const known = await store.subjects("facebook_post", page.externalId, since);
      const gone = new Set(known.filter((s) => s.gone).map((s) => s.subjectId));
      const ids = new Set([...listing.posts.map((p) => p.id), ...(listing.complete ? known.map((s) => s.subjectId) : [])]);
      for (const postId of ids) {
        if (gone.has(postId)) continue;
        if (allInvalid(ctx, POST_METRICS)) throw new SourceProblem("other", INSIGHTS_PROBLEM_TEXT.all_invalid);
        let answers: unknown[];
        try {
          answers = await withMetricFallback(
            ctx,
            POST_METRICS,
            (metrics) => withPageTokenRetry(cfg, page.pageId, (token) => fetchPostInsights(cfg, token, postId, metrics)),
            { source: "facebook_post", accountKey: page.externalId },
          );
        } catch (err) {
          if (isCode(err, "100")) {
            await store.markGone("facebook_post", postId, now);
            continue;
          }
          throw err;
        }
        const rows = answers.flatMap((a) => parsePostInsights(a, today));
        written += await store.saveRows({ source: "facebook_post", accountKey: page.externalId, accountId: page.id, subjectId: postId }, rows);
      }
    });
  }

  // 3. Instagram account figures.
  async function instagramFigures(ig: InsightAccount): Promise<void> {
    await step("instagram_account", ig.externalId, ig.label, async (ctx) => {
      const key: MetricKey = { source: "instagram_account", accountKey: ig.externalId, accountId: ig.id, subjectId: "" };
      // Lagos days, the newest complete one first in mind: yesterday back 30 days, later 3 (figures settle for 48 hours).
      const last = addDays(today, -1);
      const count = ctx.prev.backfilled ? 3 : 30;
      const days = Array.from({ length: count }, (_, i) => addDays(last, -(count - 1 - i)));
      const read = (metrics: string[], day: string, breakdown?: string): Promise<unknown> =>
        withPageTokenRetry(cfg, ig.pageId, (token) => fetchIgAccountInsights(cfg, token, ig.externalId, metrics, day, breakdown));
      const logCtx = { source: "instagram_account", accountKey: ig.externalId };

      // (a) the plain figures, one day at a time.
      for (const day of days) {
        const answers = await withMetricFallback(ctx, IG_ACCOUNT_METRICS, (metrics) => read(metrics, day), logCtx);
        written += await store.saveRows(key, answers.flatMap((a) => parseIgAccountInsights(a, day)));
      }
      if (allInvalid(ctx, IG_ACCOUNT_METRICS)) throw new SourceProblem("other", INSIGHTS_PROBLEM_TEXT.all_invalid);
      ctx.markBackfilled();

      // Followers and number of posts, as they stand today.
      const profile = await call(() => withPageTokenRetry(cfg, ig.pageId, (token) => fetchIgProfile(cfg, token, ig.externalId)));
      const totals: MetricRow[] = [];
      for (const metric of ["followers_count", "media_count"] as const) {
        const value = profile?.[metric];
        if (typeof value === "number" && Number.isFinite(value)) {
          totals.push({ metric, day: today, dayZone: LAGOS_ZONE, breakdown: "", value, isRunningTotal: true });
        }
      }
      written += await store.saveRows(key, totals);

      // (b) views and reach by type of content; (c) new followers and unfollows. Kept apart from (a)
      // so that a refusal here never costs the plain figures.
      for (const day of days) {
        const answers = await withMetricFallback(ctx, ["views", "reach"], (metrics) => read(metrics, day, "media_product_type"), logCtx, "media_product_type:");
        written += await store.saveRows(key, answers.flatMap((a) => parseIgAccountInsights(a, day)).filter((r) => r.breakdown !== ""));
      }
      for (const day of days) {
        const answers = await withMetricFallback(ctx, ["follows_and_unfollows"], (metrics) => read(metrics, day, "follow_type"), logCtx);
        // Under 100 followers Meta leaves this out: no rows, no problem (the screen's note covers it).
        written += await store.saveRows(key, answers.flatMap((a) => parseIgAccountInsights(a, day)).filter((r) => r.breakdown !== ""));
      }
    });
  }

  // 4. Instagram posts, reels and stories.
  async function instagramMedia(ig: InsightAccount): Promise<void> {
    await step("instagram_media", ig.externalId, ig.label, async (ctx) => {
      const since = new Date(now.getTime() - 90 * DAY_MS);
      const key = (subjectId: string): MetricKey => ({ source: "instagram_media", accountKey: ig.externalId, accountId: ig.id, subjectId });
      const logCtx = { source: "instagram_media", accountKey: ig.externalId };
      const measure = async (mediaId: string, productType: string, story: boolean): Promise<void> => {
        const type = story ? "STORY" : productType.toUpperCase() === "REELS" ? "REELS" : "FEED";
        const metrics = igMediaMetricsFor(type);
        let answers: unknown[];
        try {
          answers = await withMetricFallback(
            ctx,
            metrics,
            (m) => withPageTokenRetry(cfg, ig.pageId, (token) => fetchIgMediaInsights(cfg, token, mediaId, m)),
            logCtx,
            `${type}:`,
          );
        } catch (err) {
          // A story with fewer than 5 viewers answers code 10 (G10): no figures, no problem.
          if (story && isCode(err, "10")) return;
          if (isCode(err, "100")) {
            await store.markGone("instagram_media", mediaId, now);
            return;
          }
          throw err;
        }
        written += await store.saveRows(key(mediaId), answers.flatMap((a) => parseIgMediaInsights(a, today)));
      };

      // Stories are only measured while under 24 hours old; their last stored values stay.
      const stories = (await call(() => withPageTokenRetry(cfg, ig.pageId, (token) => listIgStories(cfg, token, ig.externalId)))).filter(
        (s) => now.getTime() - Date.parse(s.timestamp) < DAY_MS,
      );
      await store.upsertSubjects(
        "instagram_media",
        ig.externalId,
        stories.map((s) => ({ subjectId: s.id, kind: "story", title: null, permalink: s.permalink ?? null, publishedAt: new Date(s.timestamp) })),
        now,
      );
      const storyIds = new Set(stories.map((s) => s.id));
      const known = storiesOnly ? [] : await store.subjects("instagram_media", ig.externalId, since);
      const gone = new Set(known.filter((s) => s.gone).map((s) => s.subjectId));
      for (const s of stories) if (!gone.has(s.id)) await measure(s.id, "STORY", true);
      if (storiesOnly) return;

      const listing = await withPageTokenRetry(cfg, ig.pageId, (token) => listIgMediaPaged(cfg, token, ig.externalId, since.toISOString(), pause));
      const media = listing.media.filter((m) => !storyIds.has(m.id) && (m.media_product_type ?? "").toUpperCase() !== "STORY");
      await store.upsertSubjects(
        "instagram_media",
        ig.externalId,
        media.map((m) => ({
          subjectId: m.id,
          kind: (m.media_product_type ?? m.media_type ?? "").toLowerCase() || null,
          title: first120(m.caption),
          permalink: m.permalink ?? null,
          publishedAt: new Date(m.timestamp),
        })),
        now,
      );
      ctx.markBackfilled();
      const listed = new Map(media.map((m) => [m.id, m.media_product_type ?? ""]));
      // Items we know that the listing no longer shows are asked about once more; Meta's answer marks them gone.
      if (listing.complete) {
        for (const s of known) {
          if (!listed.has(s.subjectId) && s.kind !== "story" && !storyIds.has(s.subjectId)) listed.set(s.subjectId, s.kind ?? "");
        }
      }
      for (const [mediaId, productType] of listed) {
        if (gone.has(mediaId)) continue;
        await measure(mediaId, productType, false);
      }
    });
  }

  /** 00:00 UTC today: WhatsApp's day buckets are UTC days and only complete days are stored. */
  const utcMidnight = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);

  // 5. WhatsApp messages and charges.
  async function whatsappFigures(wabaId: string): Promise<void> {
    await step("whatsapp", wabaId, "WhatsApp", async (ctx) => {
      const key: MetricKey = { source: "whatsapp", accountKey: wabaId, accountId: null, subjectId: "" };
      const start = utcMidnight - (ctx.prev.backfilled ? 7 : 90) * 86_400;
      written += await store.saveRows(key, parseWaAnalytics(await call(() => fetchWaAnalytics(cfg, wabaId, start, utcMidnight)), ""));
      written += await store.saveRows(key, parseWaPricing(await call(() => fetchWaPricing(cfg, wabaId, start, utcMidnight))));
      ctx.markBackfilled();
      written += await store.saveRows(key, parseWaAnalytics(await call(() => fetchWaAnalytics(cfg, wabaId, start, utcMidnight, 0)), "type=template"));
      written += await store.saveRows(key, parseWaAnalytics(await call(() => fetchWaAnalytics(cfg, wabaId, start, utcMidnight, 2)), "type=free_form"));
      // The billing currency is a label only; not knowing it never fails the source.
      try {
        const currency = await call(() => fetchWaCurrency(cfg, wabaId));
        if (currency && state.currencies?.[wabaId] !== currency) await store.saveCurrency(wabaId, currency);
      } catch (err) {
        if (isCode(err, "190")) throw err;
        log.warn({ wabaId, metaCode: err instanceof MetaApiError ? err.code : null }, "insights: WhatsApp billing currency could not be read");
      }
    });
  }

  // 6. WhatsApp templates: only after the owner turned template figures on.
  async function whatsappTemplates(wabaId: string): Promise<void> {
    if (!state.template_analytics[wabaId]) return;
    await step("whatsapp_template", wabaId, "WhatsApp templates", async (ctx) => {
      const templates = await call(() => listWaTemplateIds(cfg, wabaId));
      await store.upsertSubjects(
        "whatsapp_template",
        wabaId,
        templates.map((t) => ({ subjectId: t.id, kind: "template", title: `${t.name} (${t.language})`, permalink: null, publishedAt: null })),
        now,
      );
      // Meta keeps template figures for 90 days; 89 whole days back from midnight stays inside that.
      const start = utcMidnight - (ctx.prev.backfilled ? 7 : 89) * 86_400;
      for (let i = 0; i < templates.length; i += 10) {
        const ids = templates.slice(i, i + 10).map((t) => t.id);
        const answer = await call(() => fetchTemplateAnalytics(cfg, wabaId, ids, start, utcMidnight));
        for (const t of parseTemplateAnalytics(answer)) {
          if (!ids.includes(t.templateId)) continue;
          written += await store.saveRows({ source: "whatsapp_template", accountKey: wabaId, accountId: null, subjectId: t.templateId }, t.rows);
        }
      }
    });
  }

  try {
    const instagram = await store.instagramAccounts();
    if (storiesOnly) {
      for (const ig of instagram) await instagramMedia(ig);
      return { written, problems };
    }
    const pages = await store.pages();
    for (const page of pages) await pageFigures(page);
    for (const page of pages) await pagePosts(page);
    for (const ig of instagram) await instagramFigures(ig);
    for (const ig of instagram) await instagramMedia(ig);
    const wabas = await store.wabaIds();
    for (const waba of wabas) await whatsappFigures(waba);
    for (const waba of wabas) await whatsappTemplates(waba);
  } catch (err) {
    if (!(err instanceof StopRun)) throw err;
    log.warn({}, "insights collection stopped: Meta did not accept the token");
  }
  return { written, problems };
}
