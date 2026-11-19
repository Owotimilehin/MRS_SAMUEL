/**
 * Ads, Phase A (suite spec 12, sections 5.3): reading the ad account.
 *
 * LOOK, DO NOT TOUCH. Every Graph call made from this file is a GET. Nothing
 * here can create, change, switch on or pause an advert; that lives in
 * ads-manage.ts behind the owner's switch. The only other thing kept here is
 * writeAdLog, the one function that adds a row to the append-only
 * ad_action_log (rows are never updated or deleted: a database trigger refuses
 * it and no code tries).
 *
 * All calls use the system-user token, which never leaves @ms/domain.
 */
import crypto from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  ADS_SETTINGS_DEFAULT,
  ADS_SETTINGS_KEY,
  adAccountLink,
  adActionLog,
  adCampaignCache,
  adInsightDaily,
  appSetting,
  outboxEvent,
  type AdsSettingsValue,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import { summariseActions, type AdAction } from "@ms/shared";
import { MetaApiError, graph, type MetaConfig } from "../inbox/meta.js";

export type AdAccountLinkRow = typeof adAccountLink.$inferSelect;
export type AdCampaignCacheRow = typeof adCampaignCache.$inferSelect;
export type AdsLog = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

// ── Errors ───────────────────────────────────────────────────────────────────

/** Foundation D10's temporary codes plus C3's rate-limit codes (the Marketing API uses 80000, 80003, 80004, 80014). */
export const ADS_TEMPORARY_CODES: ReadonlySet<string> = new Set([
  "4", "17", "32", "613", "80007",
  "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80008", "80009", "80014",
]);
/** Token or permission problems: stop, tell the owner once a day, show a banner (D10, C2). */
export const ADS_CONFIG_CODES: ReadonlySet<string> = new Set(["190", "10", "200", "299", "283"]);

export type AdsErrorClass = "config" | "temporary" | "unknown" | "refusal";

export function classifyAdsError(err: unknown): AdsErrorClass {
  if (!(err instanceof MetaApiError)) return "refusal";
  // No answer came back: for a write we cannot tell whether Meta acted on it.
  if (err.delivery === "unknown") return "unknown";
  const code = err.code ?? "";
  if (ADS_CONFIG_CODES.has(code)) return "config";
  if (ADS_TEMPORARY_CODES.has(code) || err.status === 429 || err.status >= 500 || err.status === 0) return "temporary";
  return "refusal";
}

export function adsMetaCode(err: MetaApiError): string | null {
  if (!err.code) return null;
  return err.subcode ? `${err.code}/${err.subcode}` : err.code;
}

// ── Usage headers (A5) ───────────────────────────────────────────────────────

export interface AdsUsage {
  accountPct: number | null;
  businessPct: number | null;
  regainSeconds: number | null;
  tier: string | null;
}

function parseJsonHeader(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function maxOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

/** Parse the usage headers of a response (A5). Missing or malformed headers give nulls, never an error. */
export function readAdsUsage(headers: Headers, adAccountNumericId: string): AdsUsage {
  const acc = parseJsonHeader(headers.get("x-ad-account-usage")) as Record<string, unknown> | null;
  const throttle = parseJsonHeader(headers.get("x-fb-ads-insights-throttle")) as Record<string, unknown> | null;
  // The header's spelling and its keying by ad account ID are [unverified] (A5).
  const buc = parseJsonHeader(headers.get("x-business-use-case-usage")) as Record<string, unknown> | null;
  const id = adAccountNumericId.replace(/^act_/, "");
  const rows = buc && typeof buc === "object" ? buc[id] : null;
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  const businessPct = maxOf(list.flatMap((r) => [pct(r?.call_count), pct(r?.total_cputime), pct(r?.total_time)]));
  // Meta gives the wait in minutes.
  const regainMinutes = maxOf(list.map((r) => pct(r?.estimated_time_to_regain_access)));
  const tier = [acc?.ads_api_access_tier, throttle?.ads_api_access_tier].find((t): t is string => typeof t === "string") ?? null;
  return {
    accountPct: maxOf([pct(acc?.acc_id_util_pct), pct(throttle?.acc_id_util_pct), pct(throttle?.app_id_util_pct)]),
    businessPct,
    regainSeconds: regainMinutes === null ? null : Math.round(regainMinutes * 60),
    tier,
  };
}

const usageByAccount = new Map<string, AdsUsage>();
/** When each account's usage was last heard, so an old "busy" reading cannot stop the sync for ever. */
const usageHeardAt = new Map<string, number>();
let currentAccount: string | null = null;

function numericId(adAccountId: string): string {
  return adAccountId.replace(/^act_/, "");
}

/** Which ad account later object-level calls (a campaign, an ad set) should be counted against. */
export function setAdsUsageAccount(adAccountId: string | null): void {
  currentAccount = adAccountId ? numericId(adAccountId) : null;
}

export function latestAdsUsage(adAccountId: string): AdsUsage | null {
  return usageByAccount.get(numericId(adAccountId)) ?? null;
}

/** For tests. */
export function resetAdsUsage(): void {
  usageByAccount.clear();
  usageHeardAt.clear();
  currentAccount = null;
}

function rememberUsage(path: string, res: Response): void {
  const fromPath = /(?:^|\/)act_(\d+)/.exec(path)?.[1] ?? currentAccount;
  if (!fromPath) return;
  const usage = readAdsUsage(res.headers, fromPath);
  if (usage.accountPct === null && usage.businessPct === null && usage.tier === null) return;
  const before = usageByAccount.get(fromPath);
  usageHeardAt.set(fromPath, Date.now());
  // A response may carry only one of the headers: keep what the other said last time.
  usageByAccount.set(fromPath, {
    accountPct: usage.accountPct ?? before?.accountPct ?? null,
    businessPct: usage.businessPct ?? before?.businessPct ?? null,
    regainSeconds: usage.regainSeconds ?? before?.regainSeconds ?? null,
    tier: usage.tier ?? before?.tier ?? null,
  });
}

/** graph() with the usage headers captured; remembers the latest usage per ad account in memory. */
export async function adsGraph<T>(cfg: MetaConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  return graph<T>(cfg, method, path, body, { onResponse: (res) => rememberUsage(path, res) });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface MetaAdAccount {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  timezone_offset_hours_utc: number;
  account_status: number;
  min_daily_budget?: number;
  funding_source?: string;
}

const ACCOUNT_FIELDS = "id,account_id,name,currency,timezone_name,timezone_offset_hours_utc,account_status";

const OBJECT_EDGE = { campaign: "campaigns", adset: "adsets", ad: "ads" } as const;
const OBJECT_FIELDS = {
  campaign: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time",
  adset: "id,name,campaign_id,status,effective_status,destination_type,daily_budget,lifetime_budget,start_time,end_time,optimization_goal",
  ad: "id,name,adset_id,campaign_id,status,effective_status,creative{id,name,body,title,object_story_spec}",
} as const;

function graphBase(cfg: MetaConfig): string {
  return cfg.baseUrl ?? "https://graph.facebook.com";
}

/**
 * Follow Meta's paging. `paging.next` is a full address that carries the token
 * in its query, so it is never logged, and it is only followed when it points
 * at the Graph API itself (the bearer token must not go anywhere else).
 */
async function getPaged(
  cfg: MetaConfig,
  firstPath: string,
  maxPages: number,
): Promise<{ rows: Record<string, unknown>[]; complete: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let path: string | null = firstPath;
  for (let page = 0; page < maxPages && path; page++) {
    const res: { data?: Record<string, unknown>[]; paging?: { next?: string } } = await adsGraph(cfg, "GET", path);
    rows.push(...(Array.isArray(res?.data) ? res.data : []));
    const next: string | undefined = res?.paging?.next;
    path = typeof next === "string" && next.startsWith(`${graphBase(cfg)}/`) ? next : null;
  }
  return { rows, complete: path === null };
}

/**
 * The ad accounts the token can use. `me/adaccounts` is [unverified] for a
 * system user (A9); if Meta refuses that address, the documented system-user
 * edge `/{system-user-id}/assigned_ad_accounts` is asked instead. Both only read.
 */
export async function listAdAccounts(cfg: MetaConfig): Promise<MetaAdAccount[]> {
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await getPaged(cfg, `me/adaccounts?fields=${ACCOUNT_FIELDS}&limit=100`, 5));
  } catch (err) {
    if (!(err instanceof MetaApiError) || classifyAdsError(err) !== "refusal") throw err;
    const me = await adsGraph<{ id?: string }>(cfg, "GET", "me?fields=id");
    if (!me?.id || !/^\d+$/.test(String(me.id))) throw err;
    ({ rows } = await getPaged(cfg, `${me.id}/assigned_ad_accounts?fields=${ACCOUNT_FIELDS}&limit=100`, 5));
  }
  return rows.map((r) => ({
    id: String(r.id ?? ""),
    account_id: String(r.account_id ?? ""),
    name: String(r.name ?? ""),
    currency: String(r.currency ?? ""),
    timezone_name: String(r.timezone_name ?? ""),
    timezone_offset_hours_utc: Number(r.timezone_offset_hours_utc ?? 0),
    account_status: Number(r.account_status ?? 0),
  }));
}

export async function getAdAccount(cfg: MetaConfig, adAccountId: string): Promise<MetaAdAccount> {
  return adsGraph<MetaAdAccount>(cfg, "GET", `${adAccountId}?fields=${ACCOUNT_FIELDS},min_daily_budget,funding_source`);
}

/** Every campaign, ad set or ad of the account; `complete` is false when the 20-page limit cut the list short. */
export async function listAdObjectsPaged(
  cfg: MetaConfig,
  adAccountId: string,
  level: "campaign" | "adset" | "ad",
): Promise<{ rows: Record<string, unknown>[]; complete: boolean }> {
  return getPaged(cfg, `${adAccountId}/${OBJECT_EDGE[level]}?fields=${encodeURIComponent(OBJECT_FIELDS[level])}&limit=100`, 20);
}

/** Follows paging.next, at most 20 pages of 100. */
export async function listAdObjects(
  cfg: MetaConfig,
  adAccountId: string,
  level: "campaign" | "adset" | "ad",
): Promise<Record<string, unknown>[]> {
  return (await listAdObjectsPaged(cfg, adAccountId, level)).rows;
}

const INSIGHT_FIGURES = "spend,impressions,reach,clicks,inline_link_clicks,actions,action_values";
/** The object IDs are asked for only at ad level: at account level they would ask Meta to split the row. */
const INSIGHT_FIELDS = {
  account: `account_currency,${INSIGHT_FIGURES}`,
  ad: `account_currency,campaign_id,adset_id,ad_id,${INSIGHT_FIGURES}`,
} as const;

export async function fetchAdInsights(
  cfg: MetaConfig,
  adAccountId: string,
  level: "account" | "ad",
  since: string,
  until: string,
): Promise<Record<string, unknown>[]> {
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const { rows } = await getPaged(
    cfg,
    `${adAccountId}/insights?level=${level}&time_increment=1&time_range=${range}&use_unified_attribution_setting=true&fields=${INSIGHT_FIELDS[level]}&limit=500`,
    60,
  );
  return rows;
}

// ── Settings, the link, the log, owner alerts ────────────────────────────────

export async function getAdsSettings(db: DbExecutor): Promise<AdsSettingsValue> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, ADS_SETTINGS_KEY));
  const stored = row?.value && typeof row.value === "object" ? (row.value as Partial<AdsSettingsValue>) : {};
  const merged = { ...ADS_SETTINGS_DEFAULT, ...stored };
  // Anything that is not exactly `true` is off; a cap that is not a whole number >= 0 is 0 (nothing may be turned on).
  return {
    ...merged,
    manage_enabled: merged.manage_enabled === true,
    rules_enabled: merged.rules_enabled === true,
    capi_enabled: merged.capi_enabled === true,
    daily_cap: Number.isSafeInteger(merged.daily_cap) && merged.daily_cap >= 0 ? merged.daily_cap : 0,
    attribution_window_days:
      Number.isInteger(merged.attribution_window_days) && merged.attribution_window_days >= 1 && merged.attribution_window_days <= 28
        ? merged.attribution_window_days
        : 7,
    datasets: merged.datasets && typeof merged.datasets === "object" ? merged.datasets : {},
  };
}

/** Merge a change into ads_settings. Run inside a transaction when the caller also reads before. */
export async function patchAdsSettings(
  db: DbExecutor,
  patch: Partial<AdsSettingsValue>,
  userId: string | null = null,
): Promise<AdsSettingsValue> {
  // Take the row lock first so two changes cannot overwrite each other.
  await db
    .insert(appSetting)
    .values({ key: ADS_SETTINGS_KEY, value: ADS_SETTINGS_DEFAULT, updatedBy: userId })
    .onConflictDoNothing({ target: appSetting.key });
  await db.execute(sql`select 1 from app_settings where key = ${ADS_SETTINGS_KEY} for update`);
  const next = { ...(await getAdsSettings(db)), ...patch };
  await db
    .update(appSetting)
    .set({ value: next, updatedAt: new Date(), ...(userId ? { updatedBy: userId } : {}) })
    .where(eq(appSetting.key, ADS_SETTINGS_KEY));
  return next;
}

export async function getActiveAdLink(db: DbExecutor): Promise<AdAccountLinkRow | null> {
  const [row] = await db.select().from(adAccountLink).where(eq(adAccountLink.isActive, true)).limit(1);
  return row ?? null;
}

export interface AdLogEntry {
  requestId: string;
  phase: "requested" | "result";
  actorKind: "person" | "rule" | "safety" | "system";
  actorUserId?: string | null;
  actorName?: string | null;
  action: string;
  adAccountId?: string | null;
  objectLevel?: string | null;
  objectExternalId?: string | null;
  summary: string;
  maxSpendUnits?: number | null;
  currency?: string | null;
  confirmText?: string | null;
  request?: Record<string, unknown>;
  outcome?: "ok" | "refused" | "unknown" | "blocked" | null;
  metaCode?: string | null;
  metaMessage?: string | null;
  response?: Record<string, unknown> | null;
}

export function newAdRequestId(): string {
  return crypto.randomUUID();
}

/**
 * THE one place a row is added to ad_action_log. Insert only: the log is never
 * updated or deleted (the trigger in migration 0080 refuses both). Pass the
 * pooled client, not a transaction, so a 'requested' row is committed before
 * the call to Meta it describes.
 */
export async function writeAdLog(db: DbExecutor, e: AdLogEntry): Promise<void> {
  await db.insert(adActionLog).values({
    requestId: e.requestId,
    phase: e.phase,
    actorKind: e.actorKind,
    actorUserId: e.actorUserId ?? null,
    actorName: e.actorName ?? null,
    action: e.action,
    adAccountId: e.adAccountId ?? null,
    objectLevel: e.objectLevel ?? null,
    objectExternalId: e.objectExternalId ?? null,
    summary: e.summary.slice(0, 2000),
    maxSpendUnits: e.maxSpendUnits ?? null,
    currency: e.currency ?? null,
    confirmText: e.confirmText ?? null,
    request: e.request ?? {},
    outcome: e.phase === "result" ? (e.outcome ?? null) : null,
    metaCode: e.metaCode ?? null,
    metaMessage: e.metaMessage ? e.metaMessage.slice(0, 1000) : null,
    response: e.response ?? null,
  });
}

/** A 'requested' and a 'result' row for something that involved no call to Meta (a settings change, a blocked action). */
export async function writeAdLogPair(
  db: DbExecutor,
  e: Omit<AdLogEntry, "requestId" | "phase" | "outcome"> & { outcome: "ok" | "refused" | "unknown" | "blocked" },
): Promise<string> {
  const requestId = newAdRequestId();
  await writeAdLog(db, { ...e, requestId, phase: "requested" });
  await writeAdLog(db, { ...e, requestId, phase: "result" });
  return requestId;
}

export type AdsAlertType = "ads.config_error" | "ads.rule_fired" | "ads.safety_stop";

/**
 * Tell the owner (outbox_event; the cases are in apps/worker/src/outbox.ts).
 * With `dedupeKey`, at most one event of this type per key per 24 hours.
 */
export async function raiseAdsAlert(
  db: DbExecutor,
  eventType: AdsAlertType,
  payload: Record<string, unknown> & { account: string },
  dedupeKey: string | null = payload.account,
): Promise<boolean> {
  if (dedupeKey !== null) {
    const [recent] = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, eventType),
          sql`${outboxEvent.createdAt} > now() - interval '24 hours'`,
          sql`${outboxEvent.payload}->>'dedupe' = ${dedupeKey}`,
        ),
      )
      .limit(1);
    if (recent) return false;
  }
  await db.insert(outboxEvent).values({ eventType, payload: { ...payload, dedupe: dedupeKey ?? crypto.randomUUID() } });
  return true;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export const ADS_BUSY_MESSAGE = "Meta asked us to slow down. The sync will continue on the next run.";
export const ADS_CONFIG_MESSAGE =
  "Meta would not let the suite read this ad account. Check that the ad account is still assigned to the suite's system user in Meta Business Settings.";

/** YYYY-MM-DD of a moment in a time zone; UTC when the zone is not one this machine knows. */
export function dayInZone(at: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

class AdsBusy extends Error {}

/** Meta's usage score decays over 5 minutes (A3); a reading older than that, or than the wait Meta gave, says nothing about now. */
const USAGE_FRESH_MS = 5 * 60_000;

function tooBusy(adAccountId: string): boolean {
  const u = latestAdsUsage(adAccountId);
  if (!u) return false;
  const heard = usageHeardAt.get(numericId(adAccountId)) ?? 0;
  const goodFor = Math.max(USAGE_FRESH_MS, (u.regainSeconds ?? 0) * 1000);
  if (Date.now() - heard > goodFor) return false;
  return (u.accountPct ?? 0) >= 80 || (u.businessPct ?? 0) >= 80;
}

function units(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function when(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}

/** The words of an advert, never its picture links. */
export function adCreativeText(creative: unknown): { title: string | null; body: string | null } | null {
  if (!creative || typeof creative !== "object") return null;
  const c = creative as Record<string, unknown>;
  const link = ((c.object_story_spec as Record<string, unknown> | undefined)?.link_data ?? null) as Record<string, unknown> | null;
  return { title: str(c.title) ?? str(link?.name), body: str(c.body) ?? str(link?.message) };
}

/** A copy of `o` without the named keys (the key columns of an upsert). */
function without<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
}

type CacheInsert = typeof adCampaignCache.$inferInsert;

function cacheRow(adAccountId: string, level: "campaign" | "adset" | "ad", o: Record<string, unknown>, now: Date): CacheInsert | null {
  const externalId = str(o.id);
  if (!externalId) return null;
  const campaignId = level === "campaign" ? externalId : str(o.campaign_id);
  return {
    adAccountId,
    level,
    externalId,
    parentExternalId: level === "adset" ? str(o.campaign_id) : level === "ad" ? str(o.adset_id) : null,
    campaignExternalId: campaignId,
    name: str(o.name),
    status: str(o.status),
    effectiveStatus: str(o.effective_status),
    objective: str(o.objective),
    destinationType: str(o.destination_type),
    dailyBudgetUnits: units(o.daily_budget),
    lifetimeBudgetUnits: units(o.lifetime_budget),
    startTime: when(o.start_time),
    endTime: when(o.end_time ?? o.stop_time),
    creative: level === "ad" ? adCreativeText(o.creative) : null,
    goneAt: null,
    syncedAt: now,
  };
}

/** Write what Meta listed for one level into the cache. Never touches created_by_suite. */
export async function upsertAdObjects(
  db: DbExecutor,
  adAccountId: string,
  level: "campaign" | "adset" | "ad",
  objects: Record<string, unknown>[],
  now: Date,
): Promise<string[]> {
  const ids: string[] = [];
  for (const o of objects) {
    const row = cacheRow(adAccountId, level, o, now);
    if (!row) continue;
    ids.push(row.externalId);
    await db
      .insert(adCampaignCache)
      .values(row)
      .onConflictDoUpdate({ target: [adCampaignCache.level, adCampaignCache.externalId], set: without(row, ["level", "externalId"]) });
  }
  return ids;
}

function insightRow(link: AdAccountLinkRow, level: "account" | "ad", r: Record<string, unknown>, now: Date) {
  const day = str(r.date_start);
  const externalId = level === "account" ? link.adAccountId : str(r.ad_id);
  if (!day || !externalId) return null;
  const actions = (Array.isArray(r.actions) ? r.actions : []) as AdAction[];
  const values = (Array.isArray(r.action_values) ? r.action_values : []) as AdAction[];
  const s = summariseActions(actions, values);
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    adAccountId: link.adAccountId,
    level,
    externalId,
    day,
    dayZone: link.timezoneName,
    currency: str(r.account_currency) ?? link.currency,
    spend: n(r.spend).toFixed(2),
    impressions: Math.round(n(r.impressions)),
    reach: r.reach == null ? null : Math.round(n(r.reach)),
    clicks: Math.round(n(r.clicks)),
    linkClicks: r.inline_link_clicks == null ? null : Math.round(n(r.inline_link_clicks)),
    conversationsStarted: Math.round(s.conversationsStarted),
    firstReplies: Math.round(s.firstReplies),
    metaPurchases: s.metaPurchases.toFixed(2),
    metaPurchaseValue: s.metaPurchaseValue.toFixed(2),
    actions,
    fetchedAt: now,
  };
}

async function recordSyncProblem(db: DbExecutor, link: AdAccountLinkRow, code: string, message: string): Promise<void> {
  await db
    .update(adAccountLink)
    .set({ lastErrorCode: code, lastErrorMessage: message.slice(0, 1000) })
    .where(eq(adAccountLink.id, link.id));
}

/**
 * Read the linked ad account into our tables (section 5.3). Read-only at Meta.
 * No database transaction is held while Meta is being called.
 */
export async function syncAdAccount(
  db: DbClient,
  cfg: MetaConfig,
  log: AdsLog,
  now: Date = new Date(),
): Promise<{ objects: number; days: number }> {
  const link0 = await getActiveAdLink(db);
  if (!link0) return { objects: 0, days: 0 };
  let link = link0;
  const act = link.adAccountId;
  setAdsUsageAccount(act);
  const check = () => {
    if (tooBusy(act)) throw new AdsBusy();
  };
  let objects = 0;
  let days = 0;
  try {
    // 1. The account itself.
    check();
    const acc = await getAdAccount(cfg, act);
    const [updated] = await db
      .update(adAccountLink)
      .set({
        name: str(acc.name) ?? link.name,
        currency: str(acc.currency) ?? link.currency,
        timezoneName: str(acc.timezone_name) ?? link.timezoneName,
        timezoneOffsetHoursUtc: acc.timezone_offset_hours_utc == null ? link.timezoneOffsetHoursUtc : String(acc.timezone_offset_hours_utc),
        accountStatus: typeof acc.account_status === "number" ? acc.account_status : link.accountStatus,
        minDailyBudgetUnits: units(acc.min_daily_budget) ?? link.minDailyBudgetUnits,
      })
      .where(eq(adAccountLink.id, link.id))
      .returning();
    if (updated) link = updated;

    // 2. Campaigns, ad sets, ads.
    for (const level of ["campaign", "adset", "ad"] as const) {
      check();
      const listed = await listAdObjectsPaged(cfg, act, level);
      const ids = await upsertAdObjects(db, act, level, listed.rows, now);
      objects += ids.length;
      // Only a complete list can tell us what has gone.
      if (listed.complete) {
        const scope = and(eq(adCampaignCache.adAccountId, act), eq(adCampaignCache.level, level), isNull(adCampaignCache.goneAt));
        await db
          .update(adCampaignCache)
          .set({ goneAt: now })
          .where(ids.length ? and(scope, notInArray(adCampaignCache.externalId, ids)) : scope);
      }
    }

    // 3. Daily figures: 90 days the first time, then the last 8 (attribution keeps moving for 7 days).
    const until = dayInZone(now, link.timezoneName);
    const since = addDays(until, link.backfilledAt ? -7 : -89);
    for (const level of ["ad", "account"] as const) {
      check();
      const rows = await fetchAdInsights(cfg, act, level, since, until);
      for (const r of rows) {
        const row = insightRow(link, level, r, now);
        if (!row) continue;
        await db
          .insert(adInsightDaily)
          .values(row)
          .onConflictDoUpdate({
            target: [adInsightDaily.level, adInsightDaily.externalId, adInsightDaily.day],
            set: without(row, ["level", "externalId", "day"]),
          });
        if (level === "account") days++;
      }
    }

    await db
      .update(adAccountLink)
      .set({ lastSyncedAt: now, lastErrorCode: null, lastErrorMessage: null, ...(link.backfilledAt ? {} : { backfilledAt: now }) })
      .where(eq(adAccountLink.id, link.id));
    return { objects, days };
  } catch (err) {
    if (err instanceof AdsBusy) {
      await recordSyncProblem(db, link, "busy", ADS_BUSY_MESSAGE);
      return { objects, days };
    }
    if (!(err instanceof MetaApiError)) throw err;
    const cls = classifyAdsError(err);
    const code = adsMetaCode(err);
    if (cls === "config") {
      await recordSyncProblem(db, link, code ?? "config", ADS_CONFIG_MESSAGE);
      await raiseAdsAlert(db, "ads.config_error", { account: act, name: link.name, code: code ?? "", message: err.message.slice(0, 500), area: "sync" });
      log.warn({ code }, "ads: Meta refused the sync (configuration)");
    } else if (cls === "temporary" || cls === "unknown") {
      await recordSyncProblem(db, link, "busy", ADS_BUSY_MESSAGE);
    } else {
      await recordSyncProblem(db, link, code ?? "refused", `Meta refused this: ${err.message}`);
      log.warn({ code }, "ads: Meta refused the sync");
    }
    return { objects, days };
  }
}

/** The cached rows of an advert's family, by campaign. */
export async function cachedAdFamily(db: DbExecutor, campaignExternalId: string): Promise<AdCampaignCacheRow[]> {
  return db
    .select()
    .from(adCampaignCache)
    .where(
      and(
        inArray(adCampaignCache.level, ["campaign", "adset", "ad"]),
        eq(adCampaignCache.campaignExternalId, campaignExternalId),
      ),
    );
}
