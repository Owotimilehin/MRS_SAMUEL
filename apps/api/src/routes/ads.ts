/**
 * Ads (suite spec 12). Mounted at /v1/ads.
 *
 * Phase A routes only read: the linked ad account's figures, which chats came
 * from an advert, and which paid orders those chats led to. Nothing in Phase A
 * can change an advert.
 *
 * Phase B routes can spend the owner's money, so each one:
 *   - needs the ads.manage permission (owner only unless the owner granted it),
 *     checked here from the session AND again in @ms/domain from the database;
 *   - is refused while the owner's master switch is off (assertCanManage),
 *     except pausing, which must always be possible;
 *   - never trusts a total, a budget summary or a cap figure from the browser:
 *     the server works them out and compares what the person typed;
 *   - reaches Meta only through @ms/domain (ads-manage.ts), where the cap, the
 *     "created switched off" rule and the action log are enforced.
 *
 * Three things need the owner role itself, whatever is granted: the settings
 * (including the daily cap), linking or unlinking the ad account, and checking
 * the budget unit.
 *
 * The API's error codes are a fixed list, so this spec's own codes (over_cap,
 * meta_refused, meta_unknown, off, …) travel in `error.details.reason`.
 * The token never leaves @ms/domain, and a click ID (ctwa_clid) is never returned.
 */
import crypto from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  adAccountLink,
  adCampaignCache,
  adDraft,
  adRule,
  adTouch,
  adminUser,
  type AdDraftSpec,
  type AdsSettingsValue,
  type DbClient,
} from "@ms/db";
import {
  ADS_SHOP_NAME,
  AdsManageError,
  MetaApiError,
  adsGraph,
  adsMetaCode,
  assertActorMayManage,
  assertCanManage,
  assertDraftBudgetAllowed,
  budgetPreview,
  buildAdSummary,
  calibrationFactor,
  canSeeConversation,
  changeDailyBudget,
  classifyAdsError,
  createAdFromDraft,
  draftFingerprint,
  getActiveAdLink,
  getAdAccount,
  getAdsSettings,
  latestAdsUsage,
  listAdAccounts,
  listAdObjects,
  metaConfigFromEnv,
  minDailyNaira,
  parseDraftSpec,
  patchAdsSettings,
  pauseObject,
  previewDraft,
  resolveDraftTargets,
  setAdsUsageAccount,
  turnOnAdvert,
  turnOnPreview,
  writeAdLogPair,
  type AdAccountLinkRow,
  type AdDraftRow,
  type MetaConfig,
  type PersonActor,
} from "@ms/domain";
import {
  AD_IMAGE_TYPES,
  AD_LIMITS,
  ENABLED_DESTINATIONS,
  SHOP_CURRENCY,
  SPECIAL_CATEGORY_REFUSAL,
  adDraftSpecSchema,
  costPerConversation,
  destinationOf,
  draftProblems,
  money,
  normaliseTyped,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { toCsv } from "../lib/csv.js";
import { displayName } from "../lib/notify.js";
import { getAdImageBytes, presignAdImagePut } from "../lib/r2.js";
import { env } from "../env.js";
import { reloadViewer } from "../inbox/realtime.js";
import { need, visibleConversation, withViewer } from "./inbox.js";

const SHOP_ZONE = "Africa/Lagos";
const NOT_SET_UP = "Meta is not connected on this server yet.";
const NOT_LINKED = "No ad account is linked yet.";
const OWNER_ONLY = "Only the owner can change this";

type Row = Record<string, unknown>;

async function rows<T extends Row = Row>(db: DbClient, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_SET_UP, 503, { reason: "not_configured" });
  return cfg;
}

/** The owner role, read from the database (not only from the session). */
function ownerOnly(db: DbClient): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth.role !== "owner") throw new BusinessError("forbidden", OWNER_ONLY, 403, { reason: "owner_only" });
    const [u] = await db
      .select({ role: adminUser.role, isActive: adminUser.isActive, deletedAt: adminUser.deletedAt })
      .from(adminUser)
      .where(eq(adminUser.id, auth.userId));
    if (!u || u.role !== "owner" || !u.isActive || u.deletedAt) {
      throw new BusinessError("forbidden", OWNER_ONLY, 403, { reason: "owner_only" });
    }
    await next();
  };
}

async function personActor(db: DbClient, c: Context): Promise<PersonActor> {
  const userId = c.get("auth").userId;
  const [u] = await db.select({ name: adminUser.name, email: adminUser.email }).from(adminUser).where(eq(adminUser.id, userId));
  return { kind: "person", userId, name: u ? displayName(u) : "Staff member" };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function lagosDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ?from=&to= as YYYY-MM-DD, default the last 30 days, at most 400 days. */
function range(c: Context): { from: string; to: string } {
  const today = lagosDay(new Date());
  const to = c.req.query("to") ?? today;
  const from = c.req.query("from") ?? shiftDay(to, -29);
  const valid = (d: string) => DAY.test(d) && !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime());
  if (!valid(from) || !valid(to)) throw new BusinessError("validation_failed", "Dates must look like 2026-11-19.", 400);
  const span = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
  if (span < 0) throw new BusinessError("validation_failed", "The 'from' date must not be after the 'to' date.", 400);
  if (span > 400) throw new BusinessError("validation_failed", "Choose a period of 400 days or less.", 400);
  return { from, to };
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
  return out;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Paid, not cancelled, not a draft: an order that still counts (a refund or a cancel removes it from every figure). */
const ORDER_COUNTS = sql`o.payment_status = 'paid' and o.status not in ('cancelled', 'draft')`;

function settingsJson(s: AdsSettingsValue) {
  return {
    manage_enabled: s.manage_enabled,
    daily_cap: s.daily_cap,
    rules_enabled: s.rules_enabled,
    capi_enabled: s.capi_enabled,
    capi_privacy_confirmed: !!s.capi_privacy_confirmed_at,
    attribution_window_days: s.attribution_window_days,
  };
}

function accountJson(link: AdAccountLinkRow) {
  return {
    ad_account_id: link.adAccountId,
    name: link.name,
    currency: link.currency,
    timezone_name: link.timezoneName,
    account_status: link.accountStatus,
    last_synced_at: link.lastSyncedAt,
    problem: link.lastErrorMessage,
    budget_calibrated: link.budgetFactor === 1 || link.budgetFactor === 100,
    budget_factor: link.budgetFactor,
    min_daily: minDailyNaira(link),
    manageable_currency: link.currency === SHOP_CURRENCY,
  };
}

function draftJson(d: AdDraftRow) {
  return {
    id: d.id,
    status: d.status,
    step: d.step,
    spec: d.spec,
    campaign_external_id: d.campaignExternalId,
    adset_external_id: d.adsetExternalId,
    ad_external_id: d.adExternalId,
    confirmed: !!d.confirmedHash,
    error_code: d.errorCode,
    error_message: d.errorMessage,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

/** How a Meta error reads to staff when asking for the ad accounts (7.7). */
function metaReason(err: MetaApiError): string {
  const cls = classifyAdsError(err);
  if (cls === "config") return "Meta would not let the suite see them. Check the system user's access in Meta Business Settings";
  if (cls === "temporary" || cls === "unknown") return "Meta is busy or did not answer. Try again in a few minutes";
  return err.message;
}

/** Turn the suite's own refusals and Meta's answers into the responses in 5.13. Anything else is rethrown. */
function manageError(err: unknown): never {
  if (err instanceof AdsManageError) {
    const status =
      err.code === "not_allowed" ? 403 : err.code === "not_found" ? 404 : err.code === "wrong_total" || err.code === "below_minimum" ? 400 : err.code === "invalid" ? 422 : 409;
    const code = status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : "validation_failed";
    throw new BusinessError(code, err.staffMessage, status, { reason: err.code, ...err.details });
  }
  if (err instanceof MetaApiError) {
    if (classifyAdsError(err) === "unknown") {
      throw new BusinessError(
        "service_unavailable",
        "Meta did not answer, so we cannot tell if this went through. Nothing has been switched on. Open the advert to check.",
        502,
        { reason: "meta_unknown" },
      );
    }
    throw new BusinessError("service_unavailable", `Meta refused this: ${err.message}`, 502, {
      reason: "meta_refused",
      meta_code: adsMetaCode(err),
    });
  }
  throw err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return manageError(err);
  }
}

function uploadToken(userId: string, key: string): string {
  return crypto.createHmac("sha256", env.JWT_SIGNING_KEY).update(`ads-upload:${userId}:${key}`).digest("base64url");
}

function uploadTokenOk(userId: string, key: string, token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(uploadToken(userId, key));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The shop's position for "People near the shop" (env ADS_SHOP_LAT / ADS_SHOP_LNG). Null when either is missing. */
function shopPosition(): { lat: number; lng: number } | null {
  const lat = Number(process.env.ADS_SHOP_LAT);
  const lng = Number(process.env.ADS_SHOP_LNG);
  if (!process.env.ADS_SHOP_LAT || !process.env.ADS_SHOP_LNG) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Validate what the form sent. The literal `false` for the special-category answer is checked first (rule 8.14). */
function parseSpecBody(raw: unknown): AdDraftSpec {
  const special = (raw as { special_category?: unknown } | null)?.special_category;
  if (special !== false) throw new BusinessError("validation_failed", SPECIAL_CATEGORY_REFUSAL, 422, { reason: "special_category" });
  const parsed = adDraftSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BusinessError("validation_failed", `Check the advert's ${String(first?.path?.[0] ?? "details")}: ${first?.message ?? "not valid"}.`, 422, {
      reason: "invalid",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const problems = draftProblems(parsed.data);
  if (problems.length) throw new BusinessError("validation_failed", problems[0]!, 422, { reason: "invalid", problems });
  if (parsed.data.audience.area === "near_shop" && !shopPosition()) {
    throw new BusinessError("validation_failed", "The shop's position is not set up, so 'People near the shop' cannot be used.", 422, { reason: "invalid" });
  }
  return parsed.data;
}

/** Where an advert's picture is read from. Tests swap this for bytes in memory (they have no file storage). */
export const adImageSource: { load: (key: string) => Promise<Uint8Array> } = { load: getAdImageBytes };

export function adRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  const view = requireCapability("ads.view");
  const manage = requireCapability("ads.manage");
  const owner = ownerOnly(db);

  // ── Phase A: status, account, settings ────────────────────────────────────

  r.get("/status", view, async (c) => {
    const link = await getActiveAdLink(db);
    const settings = await getAdsSettings(db);
    return c.json({
      data: {
        account: link ? accountJson(link) : null,
        settings: settingsJson(settings),
        shop_time_zone: SHOP_ZONE,
        usage: link ? latestAdsUsage(link.adAccountId) : null,
        phase_b: { enabled_destinations: ENABLED_DESTINATIONS, near_shop_available: shopPosition() !== null },
      },
    });
  });

  r.get("/accounts/available", owner, async (c) => {
    const cfg = needConfig();
    try {
      return c.json({ data: await listAdAccounts(cfg) });
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      throw new BusinessError("service_unavailable", `We could not ask Meta for your ad accounts: ${metaReason(err)}.`, 502, {
        reason: "meta_refused",
        meta_code: adsMetaCode(err),
      });
    }
  });

  r.post("/accounts/link", owner, async (c) => {
    const { ad_account_id: id } = z.object({ ad_account_id: z.string().regex(/^act_\d+$/) }).parse(await c.req.json());
    const cfg = needConfig();
    let listed;
    try {
      listed = await listAdAccounts(cfg);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      throw new BusinessError("service_unavailable", `We could not ask Meta for your ad accounts: ${metaReason(err)}.`, 502, {
        reason: "meta_refused",
        meta_code: adsMetaCode(err),
      });
    }
    const acc = listed.find((a) => a.id === id);
    if (!acc) {
      throw new BusinessError("validation_failed", "Meta does not list that ad account for the suite. Assign it to the system user in Business Settings first.", 400, {
        reason: "not_listed",
      });
    }
    const userId = c.get("auth").userId;
    const before = await getActiveAdLink(db);
    const link = await db.transaction(async (tx) => {
      await tx.update(adAccountLink).set({ isActive: false }).where(eq(adAccountLink.isActive, true));
      const [row] = await tx
        .insert(adAccountLink)
        .values({
          adAccountId: acc.id,
          name: acc.name || acc.id,
          currency: acc.currency,
          timezoneName: acc.timezone_name || "UTC",
          timezoneOffsetHoursUtc: Number.isFinite(acc.timezone_offset_hours_utc) ? String(acc.timezone_offset_hours_utc) : null,
          accountStatus: acc.account_status,
          isActive: true,
          linkedBy: userId,
        })
        .onConflictDoUpdate({
          target: adAccountLink.adAccountId,
          set: {
            name: acc.name || acc.id,
            currency: acc.currency,
            timezoneName: acc.timezone_name || "UTC",
            accountStatus: acc.account_status,
            isActive: true,
            linkedBy: userId,
            linkedAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        })
        .returning();
      // A different ad account is a different purse: creating adverts and rules go back to off until the owner decides again.
      const changed = before?.adAccountId !== acc.id;
      await patchAdsSettings(
        tx,
        { refresh_requested_at: new Date().toISOString(), ...(changed ? { manage_enabled: false, rules_enabled: false } : {}) },
        userId,
      );
      return row!;
    });
    await writeAudit(db, c, {
      action: "ads.account_link",
      entityType: "ad_account_link",
      entityId: link.id,
      before: before ? { ad_account_id: before.adAccountId, name: before.name } : null,
      after: { ad_account_id: link.adAccountId, name: link.name, currency: link.currency },
    });
    return c.json({ data: accountJson(link) });
  });

  r.post("/accounts/unlink", owner, async (c) => {
    const link = await getActiveAdLink(db);
    if (!link) throw new BusinessError("not_found", NOT_LINKED, 404, { reason: "not_linked" });
    await db.transaction(async (tx) => {
      await tx.update(adAccountLink).set({ isActive: false }).where(eq(adAccountLink.id, link.id));
      await patchAdsSettings(tx, { manage_enabled: false, rules_enabled: false }, c.get("auth").userId);
    });
    await writeAudit(db, c, {
      action: "ads.account_unlink",
      entityType: "ad_account_link",
      entityId: link.id,
      before: { ad_account_id: link.adAccountId, name: link.name },
      after: { is_active: false },
    });
    return c.json({ data: { ok: true } });
  });

  r.get("/settings", owner, async (c) => c.json({ data: settingsJson(await getAdsSettings(db)) }));

  r.put("/settings", owner, async (c) => {
    const body = z
      .object({
        manage_enabled: z.boolean().optional(),
        daily_cap: z.number().int().min(0).max(1_000_000_000).optional(),
        rules_enabled: z.boolean().optional(),
        capi_enabled: z.boolean().optional(),
        capi_privacy_confirmed: z.boolean().optional(),
        attribution_window_days: z.number().int().min(1).max(28).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const userId = c.get("auth").userId;
    const { before, after } = await db.transaction(async (tx) => {
      const cur = await getAdsSettings(tx);
      const patch: Partial<AdsSettingsValue> = {};
      if (body.daily_cap !== undefined) patch.daily_cap = body.daily_cap;
      if (body.rules_enabled !== undefined) patch.rules_enabled = body.rules_enabled;
      if (body.attribution_window_days !== undefined) patch.attribution_window_days = body.attribution_window_days;
      // The privacy statement: ticking records who and when; un-ticking also switches reporting off.
      let confirmed = !!cur.capi_privacy_confirmed_at;
      if (body.capi_privacy_confirmed === true && !confirmed) {
        patch.capi_privacy_confirmed_by = userId;
        patch.capi_privacy_confirmed_at = new Date().toISOString();
        confirmed = true;
      } else if (body.capi_privacy_confirmed === false) {
        patch.capi_privacy_confirmed_by = null;
        patch.capi_privacy_confirmed_at = null;
        patch.capi_enabled = false;
        confirmed = false;
      }
      if (body.capi_enabled === true) {
        if (!confirmed) throw new BusinessError("validation_failed", "Tick the privacy statement first", 400, { reason: "privacy_not_confirmed" });
        patch.capi_enabled = true;
      } else if (body.capi_enabled === false) {
        patch.capi_enabled = false;
      }
      if (body.manage_enabled === true) {
        const link = await getActiveAdLink(tx);
        if (!link || (link.budgetFactor !== 1 && link.budgetFactor !== 100)) {
          throw new BusinessError("conflict", "Link the ad account and check the budget unit first", 409, { reason: "not_ready" });
        }
        if (link.currency !== SHOP_CURRENCY) {
          throw new BusinessError("conflict", "The suite can only manage adverts for an ad account in naira.", 409, { reason: "currency" });
        }
        patch.manage_enabled = true;
      } else if (body.manage_enabled === false) {
        patch.manage_enabled = false;
      }
      const next = await patchAdsSettings(tx, patch, userId);
      return { before: cur, after: next };
    });
    const b = settingsJson(before);
    const a = settingsJson(after);
    const changes: string[] = [];
    const onOff = (v: boolean) => (v ? "on" : "off");
    if (b.daily_cap !== a.daily_cap) changes.push(`daily cap ${money(b.daily_cap, "NGN")} → ${money(a.daily_cap, "NGN")}`);
    if (b.manage_enabled !== a.manage_enabled) changes.push(`creating and changing adverts from the suite turned ${onOff(a.manage_enabled)}`);
    if (b.rules_enabled !== a.rules_enabled) changes.push(`rules turned ${onOff(a.rules_enabled)}`);
    if (b.capi_enabled !== a.capi_enabled) changes.push(`reporting purchases to Meta turned ${onOff(a.capi_enabled)}`);
    if (b.capi_privacy_confirmed !== a.capi_privacy_confirmed) changes.push(`privacy statement ${a.capi_privacy_confirmed ? "ticked" : "un-ticked"}`);
    if (b.attribution_window_days !== a.attribution_window_days) {
      changes.push(`orders counted within ${b.attribution_window_days} → ${a.attribution_window_days} days of an advert tap`);
    }
    if (changes.length) {
      const actor = await personActor(db, c);
      const link = await getActiveAdLink(db);
      await writeAdLogPair(db, {
        actorKind: "person",
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "settings_change",
        adAccountId: link?.adAccountId ?? null,
        summary: `Changed the ads settings: ${changes.join("; ")}.`,
        request: { before: b, after: a },
        outcome: "ok",
      });
      await writeAudit(db, c, { action: "ads.settings_update", entityType: "ads_settings", entityId: "ads_settings", before: b, after: a });
    }
    return c.json({ data: a });
  });

  r.post("/refresh", view, async (c) => {
    const link = await getActiveAdLink(db);
    if (!link) throw new BusinessError("not_found", NOT_LINKED, 404, { reason: "not_linked" });
    const settings = await getAdsSettings(db);
    const recent = (iso: string | Date | null) => !!iso && Date.now() - new Date(iso).getTime() < 10 * 60_000;
    if (recent(link.lastSyncedAt) || recent(settings.refresh_requested_at)) {
      throw new BusinessError("rate_limited", "Figures were refreshed a few minutes ago. Try again shortly.", 429, { reason: "just_refreshed" });
    }
    await db.transaction((tx) => patchAdsSettings(tx, { refresh_requested_at: new Date().toISOString() }));
    return c.json({ data: { ok: true } });
  });

  // ── Phase A: figures ──────────────────────────────────────────────────────

  r.get("/overview", view, async (c) => {
    const { from, to } = range(c);
    const link = await getActiveAdLink(db);
    const daily = link
      ? await rows(
          db,
          sql`select day::text as day, spend::float8 as spend, impressions::float8 as impressions, clicks::float8 as clicks,
                     conversations_started, currency, day_zone
              from ad_insight_daily
              where level = 'account' and ad_account_id = ${link.adAccountId} and day between ${from}::date and ${to}::date
              order by day`,
        )
      : [];
    const byDay = new Map(daily.map((d) => [String(d.day), d]));
    const perDay = daysBetween(from, to).map((day) => {
      const d = byDay.get(day);
      // A day Meta gave no figure for is a gap, not a zero.
      return d
        ? { day, spend: n(d.spend), impressions: n(d.impressions), clicks: n(d.clicks), conversations_started: n(d.conversations_started) }
        : { day, spend: null, impressions: null, clicks: null, conversations_started: null };
    });
    const orders = await rows(
      db,
      sql`select to_char(a.order_at at time zone ${SHOP_ZONE}, 'YYYY-MM-DD') as day, count(*)::int as orders, coalesce(sum(a.value_ngn), 0)::int as value_ngn
          from ad_order_attribution a
          join sale_order o on o.id = a.sale_order_id
          where ${ORDER_COUNTS}
            and (a.order_at at time zone ${SHOP_ZONE})::date between ${from}::date and ${to}::date
          group by 1 order by 1`,
    );
    const spend = daily.reduce((s, d) => s + n(d.spend), 0);
    const chats = daily.reduce((s, d) => s + n(d.conversations_started), 0);
    const orderCount = orders.reduce((s, o) => s + n(o.orders), 0);
    const orderValue = orders.reduce((s, o) => s + n(o.value_ngn), 0);
    const currency = link?.currency ?? null;
    return c.json({
      data: {
        currency,
        day_zone: link?.timezoneName ?? null,
        has_figures: daily.length > 0,
        totals: {
          spend: Math.round(spend * 100) / 100,
          impressions: daily.reduce((s, d) => s + n(d.impressions), 0),
          clicks: daily.reduce((s, d) => s + n(d.clicks), 0),
          conversations_started: chats,
          cost_per_conversation: costPerConversation(spend, chats),
          orders: orderCount,
          order_value_ngn: orderValue,
          // Only when spend and sales are in the same currency. We never convert.
          cost_per_order: currency === "NGN" && orderCount > 0 && spend > 0 ? Math.round(spend / orderCount) : null,
        },
        per_day: perDay,
        orders_per_day: orders.map((o) => ({ day: String(o.day), orders: n(o.orders), value_ngn: n(o.value_ngn) })),
      },
    });
  });

  async function advertRows(link: AdAccountLinkRow, from: string, to: string, onlyAd: string | null): Promise<Row[]> {
    return rows(
      db,
      sql`with f as (
            select external_id, sum(spend)::float8 as spend, sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks,
                   sum(conversations_started)::int as chats
            from ad_insight_daily
            where level = 'ad' and ad_account_id = ${link.adAccountId} and day between ${from}::date and ${to}::date
            group by 1
          ), t as (
            select ad_external_id, count(*)::int as chats_seen
            from ad_touch
            where ad_external_id is not null and (touched_at at time zone ${SHOP_ZONE})::date between ${from}::date and ${to}::date
            group by 1
          ), ord as (
            select t.ad_external_id, count(*)::int as orders, coalesce(sum(a.value_ngn), 0)::int as value_ngn
            from ad_order_attribution a
            join ad_touch t on t.id = a.touch_id
            join sale_order o on o.id = a.sale_order_id
            where ${ORDER_COUNTS} and t.ad_external_id is not null
              and (a.order_at at time zone ${SHOP_ZONE})::date between ${from}::date and ${to}::date
            group by 1
          )
          select ad.external_id, ad.name, ad.status, ad.effective_status, ad.creative, ad.campaign_external_id, ad.parent_external_id as adset_external_id,
                 camp.name as campaign_name, camp.status as campaign_status, coalesce(camp.created_by_suite, false) as created_by_suite,
                 aset.destination_type, aset.daily_budget_units, aset.end_time, aset.start_time, aset.status as adset_status,
                 coalesce(f.spend, 0) as spend, coalesce(f.impressions, 0) as impressions, coalesce(f.clicks, 0) as clicks,
                 coalesce(f.chats, 0) as chats, coalesce(t.chats_seen, 0) as chats_seen,
                 coalesce(ord.orders, 0) as orders, coalesce(ord.value_ngn, 0) as value_ngn
          from ad_campaign_cache ad
          left join ad_campaign_cache camp on camp.level = 'campaign' and camp.external_id = ad.campaign_external_id
          left join ad_campaign_cache aset on aset.level = 'adset' and aset.external_id = ad.parent_external_id
          left join f on f.external_id = ad.external_id
          left join t on t.ad_external_id = ad.external_id
          left join ord on ord.ad_external_id = ad.external_id
          where ad.level = 'ad' and ad.ad_account_id = ${link.adAccountId}
            and ${onlyAd ? sql`ad.external_id = ${onlyAd}` : sql`(f.external_id is not null or t.ad_external_id is not null or coalesce(camp.created_by_suite, false))`}
          order by coalesce(f.spend, 0) desc, ad.name`,
    );
  }

  function advertJson(r0: Row) {
    return {
      ad_external_id: String(r0.external_id),
      name: (r0.name as string | null) ?? null,
      campaign_name: (r0.campaign_name as string | null) ?? null,
      destination: destinationOf(r0.destination_type as string | null),
      status: (r0.status as string | null) ?? null,
      effective_status: (r0.effective_status as string | null) ?? null,
      created_by_suite: r0.created_by_suite === true,
      spend: n(r0.spend),
      impressions: n(r0.impressions),
      clicks: n(r0.clicks),
      conversations_started: n(r0.chats),
      cost_per_conversation: costPerConversation(n(r0.spend), n(r0.chats)),
      chats_seen: n(r0.chats_seen),
      orders: n(r0.orders),
      order_value_ngn: n(r0.value_ngn),
    };
  }

  r.get("/adverts", view, async (c) => {
    const { from, to } = range(c);
    const link = await getActiveAdLink(db);
    if (!link) return c.json({ data: [], currency: null });
    return c.json({ data: (await advertRows(link, from, to, null)).map(advertJson), currency: link.currency });
  });

  r.get("/adverts/:adExternalId", view, async (c) => {
    const { from, to } = range(c);
    const adId = c.req.param("adExternalId");
    const link = await getActiveAdLink(db);
    if (!link || !/^\d{1,40}$/.test(adId)) throw new BusinessError("not_found", "That advert was not found.", 404);
    const [row] = await advertRows(link, from, to, adId);
    if (!row) throw new BusinessError("not_found", "That advert was not found.", 404);
    const daily = await rows(
      db,
      sql`select day::text as day, spend::float8 as spend, impressions::float8 as impressions, clicks::float8 as clicks, conversations_started
          from ad_insight_daily
          where level = 'ad' and external_id = ${adId} and day between ${from}::date and ${to}::date
          order by day`,
    );
    const byDay = new Map(daily.map((d) => [String(d.day), d]));
    const factor = link.budgetFactor === 1 || link.budgetFactor === 100 ? link.budgetFactor : null;
    const creative = (row.creative as { title?: string | null; body?: string | null } | null) ?? null;
    return c.json({
      data: {
        ...advertJson(row),
        currency: link.currency,
        day_zone: link.timezoneName,
        creative: { title: creative?.title ?? null, body: creative?.body ?? null },
        campaign_external_id: (row.campaign_external_id as string | null) ?? null,
        adset_external_id: (row.adset_external_id as string | null) ?? null,
        campaign_status: (row.campaign_status as string | null) ?? null,
        start_time: row.start_time ?? null,
        budget:
          row.daily_budget_units != null && factor
            ? { daily: n(row.daily_budget_units) / factor, end_time: row.end_time ?? null }
            : null,
        per_day: daysBetween(from, to).map((day) => {
          const d = byDay.get(day);
          return d
            ? { day, spend: n(d.spend), impressions: n(d.impressions), clicks: n(d.clicks), conversations_started: n(d.conversations_started) }
            : { day, spend: null, impressions: null, clicks: null, conversations_started: null };
        }),
      },
    });
  });

  r.get("/chats", view, async (c) => {
    const { from, to } = range(c);
    const ad = c.req.query("ad");
    const cursor = c.req.query("cursor");
    if (ad !== undefined && !/^\d{1,40}$/.test(ad)) throw new BusinessError("validation_failed", "That advert was not found.", 400);
    let after: { at: string; id: string } | null = null;
    if (cursor) {
      const [at, id] = cursor.split("|");
      if (!at || !id || Number.isNaN(new Date(at).getTime()) || !z.string().uuid().safeParse(id).success) {
        throw new BusinessError("validation_failed", "That page was not found.", 400);
      }
      after = { at, id };
    }
    const viewer = await reloadViewer(db, c.get("auth").userId);
    const settings = await getAdsSettings(db);
    const list = await rows(
      db,
      sql`select t.id, t.touched_at, t.channel, t.ad_external_id, t.headline, t.reporting_blocked_at,
                 conv.id as conversation_id, conv.phone_number_id, conv.team_id, conv.assignee_id,
                 cust.name as customer_name,
                 att.order_number, att.value_ngn, att.capi_status, att.capi_note
          from ad_touch t
          left join inbox_conversation conv on conv.id = t.conversation_id
          left join customer cust on cust.id = coalesce(conv.customer_id, t.customer_id)
          left join lateral (
            select o.order_number, a.value_ngn, a.capi_status, a.capi_note
            from ad_order_attribution a
            join sale_order o on o.id = a.sale_order_id
            where a.touch_id = t.id and ${ORDER_COUNTS}
            order by a.order_at desc
            limit 1
          ) att on true
          where (t.touched_at at time zone ${SHOP_ZONE})::date between ${from}::date and ${to}::date
            ${ad ? sql`and t.ad_external_id = ${ad}` : sql``}
            ${after ? sql`and (t.touched_at, t.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
          order by t.touched_at desc, t.id desc
          limit 51`,
    );
    const page = list.slice(0, 50);
    const last = page[page.length - 1];
    return c.json({
      data: page.map((t) => {
        // Names and links follow the inbox's one visibility rule; the row itself still counts.
        const visible =
          !!viewer &&
          !!t.conversation_id &&
          canSeeConversation(viewer, {
            phoneNumberId: String(t.phone_number_id),
            teamId: (t.team_id as string | null) ?? null,
            assigneeId: (t.assignee_id as string | null) ?? null,
          });
        return {
          id: String(t.id),
          touched_at: t.touched_at,
          channel: String(t.channel),
          ad_external_id: (t.ad_external_id as string | null) ?? null,
          headline: (t.headline as string | null) ?? null,
          conversation_id: visible ? String(t.conversation_id) : null,
          customer_name: visible ? ((t.customer_name as string | null) ?? "Customer") : null,
          order: t.order_number
            ? {
                order_number: String(t.order_number),
                value_ngn: n(t.value_ngn),
                reported: String(t.capi_status),
                reported_note: (t.capi_note as string | null) ?? null,
              }
            : null,
          reporting_blocked: t.reporting_blocked_at != null,
        };
      }),
      reporting_on: settings.capi_enabled,
      next_cursor: list.length > 50 && last ? `${new Date(last.touched_at as string | Date).toISOString()}|${String(last.id)}` : null,
    });
  });

  // Needs inbox access and sight of the conversation, not ads.view: it is a line on the inbox's contact panel.
  r.get("/conversations/:conversationId/source", withViewer(db), async (c) => {
    need(c, "inbox.view");
    const conv = await visibleConversation(db, c, c.req.param("conversationId"));
    const [t] = await db
      .select({ touchedAt: adTouch.touchedAt, channel: adTouch.channel, headline: adTouch.headline, adExternalId: adTouch.adExternalId })
      .from(adTouch)
      .where(eq(adTouch.conversationId, conv.id))
      .orderBy(desc(adTouch.touchedAt))
      .limit(1);
    if (!t) return c.json({ data: null });
    let adName: string | null = null;
    if (t.adExternalId) {
      const [ad] = await db
        .select({ name: adCampaignCache.name })
        .from(adCampaignCache)
        .where(and(eq(adCampaignCache.level, "ad"), eq(adCampaignCache.externalId, t.adExternalId)));
      adName = ad?.name ?? null;
    }
    return c.json({ data: { touched_at: t.touchedAt, channel: t.channel, headline: t.headline, ad_name: adName } });
  });

  const blockRoute = (block: boolean) => async (c: Context) => {
    const id = c.req.param("touchId") ?? "";
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "That chat was not found.", 404);
    const [row] = await db
      .update(adTouch)
      .set(block ? { reportingBlockedAt: new Date(), reportingBlockedBy: c.get("auth").userId } : { reportingBlockedAt: null, reportingBlockedBy: null })
      .where(eq(adTouch.id, id))
      .returning({ id: adTouch.id });
    if (!row) throw new BusinessError("not_found", "That chat was not found.", 404);
    await writeAudit(db, c, {
      action: block ? "ads.reporting_block" : "ads.reporting_unblock",
      entityType: "ad_touch",
      entityId: id,
      after: { reporting_blocked: block },
      notify: false,
    });
    return c.json({ data: { id, reporting_blocked: block } });
  };
  r.post("/chats/:touchId/block-reporting", manage, blockRoute(true));
  r.post("/chats/:touchId/unblock-reporting", manage, blockRoute(false));

  r.get("/export.csv", view, async (c) => {
    const { from, to } = range(c);
    const link = await getActiveAdLink(db);
    const list = link
      ? await rows(
          db,
          sql`select i.day::text as day, i.day_zone, camp.name as campaign, ad.name as advert, i.external_id, aset.destination_type, i.currency,
                     i.spend::float8 as spend, i.impressions::float8 as impressions, i.clicks::float8 as clicks, i.conversations_started,
                     (select count(*)::int from ad_touch t
                       where t.ad_external_id = i.external_id and (t.touched_at at time zone ${SHOP_ZONE})::date = i.day) as chats_seen,
                     (select count(*)::int from ad_order_attribution a join ad_touch t on t.id = a.touch_id join sale_order o on o.id = a.sale_order_id
                       where t.ad_external_id = i.external_id and ${ORDER_COUNTS} and (a.order_at at time zone ${SHOP_ZONE})::date = i.day) as orders,
                     (select coalesce(sum(a.value_ngn), 0)::int from ad_order_attribution a join ad_touch t on t.id = a.touch_id join sale_order o on o.id = a.sale_order_id
                       where t.ad_external_id = i.external_id and ${ORDER_COUNTS} and (a.order_at at time zone ${SHOP_ZONE})::date = i.day) as value_ngn
              from ad_insight_daily i
              left join ad_campaign_cache ad on ad.level = 'ad' and ad.external_id = i.external_id
              left join ad_campaign_cache camp on camp.level = 'campaign' and camp.external_id = ad.campaign_external_id
              left join ad_campaign_cache aset on aset.level = 'adset' and aset.external_id = ad.parent_external_id
              where i.level = 'ad' and i.ad_account_id = ${link.adAccountId} and i.day between ${from}::date and ${to}::date
              order by i.day, camp.name, ad.name`,
        )
      : [];
    await writeAudit(db, c, { action: "ads.export", entityType: "ad_account_link", entityId: link?.id ?? "none", after: { from, to, rows: list.length }, notify: false });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="ads-${from}-to-${to}.csv"`);
    return c.body(
      toCsv(
        ["day", "day_time_zone", "campaign", "advert", "destination", "currency", "spend", "impressions", "clicks", "chats_started_meta", "chats_seen_suite", "orders", "order_value_ngn"],
        list.map((x) => [
          x.day,
          x.day_zone,
          x.campaign ?? "",
          x.advert ?? `Advert ${String(x.external_id)}`,
          destinationOf(x.destination_type as string | null),
          x.currency,
          n(x.spend).toFixed(2),
          n(x.impressions),
          n(x.clicks),
          n(x.conversations_started),
          n(x.chats_seen),
          n(x.orders),
          n(x.value_ngn),
        ]),
      ),
    );
  });

  r.get("/log", view, async (c) => {
    const cursor = c.req.query("cursor");
    let after: { at: string; id: string } | null = null;
    if (cursor) {
      const [at, id] = cursor.split("|");
      if (!at || !id || Number.isNaN(new Date(at).getTime()) || !z.string().uuid().safeParse(id).success) {
        throw new BusinessError("validation_failed", "That page was not found.", 400);
      }
      after = { at, id };
    }
    const isOwner = c.get("auth").role === "owner";
    const list = await rows(
      db,
      sql`select q.id, q.request_id, q.at, q.actor_kind, q.actor_name, q.action, q.summary, q.max_spend_units, q.currency, q.request,
                 res.outcome, res.meta_message, res.meta_code, res.response, res.id as result_id
          from ad_action_log q
          left join ad_action_log res on res.request_id = q.request_id and res.phase = 'result'
          where q.phase = 'requested'
            ${after ? sql`and (q.at, q.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
          order by q.at desc, q.id desc
          limit 51`,
    );
    const link = await getActiveAdLink(db);
    const factor = link?.budgetFactor === 100 ? 100 : 1;
    const page = list.slice(0, 50);
    const last = page[page.length - 1];
    return c.json({
      data: page.map((l) => ({
        request_id: String(l.request_id),
        at: l.at,
        actor_kind: String(l.actor_kind),
        actor_name: (l.actor_name as string | null) ?? null,
        action: String(l.action),
        summary: String(l.summary),
        max_spend: l.max_spend_units != null ? n(l.max_spend_units) / factor : null,
        currency: (l.currency as string | null) ?? null,
        // A request with no result row yet is still in progress (or was cut off): "pending".
        outcome: l.result_id ? String(l.outcome) : "pending",
        meta_message: (l.meta_message as string | null) ?? null,
        ...(isOwner ? { meta_code: l.meta_code ?? null, request: l.request, response: l.response ?? null } : {}),
      })),
      next_cursor: list.length > 50 && last ? `${new Date(last.at as string | Date).toISOString()}|${String(last.id)}` : null,
    });
  });

  // ── Phase B: checking the budget unit (owner) ─────────────────────────────

  r.get("/calibration", owner, async (c) => {
    const cfg = needConfig();
    const link = await getActiveAdLink(db);
    if (!link) throw new BusinessError("not_found", NOT_LINKED, 404, { reason: "not_linked" });
    return guarded(async () => {
      setAdsUsageAccount(link.adAccountId);
      const adsets = await listAdObjects(cfg, link.adAccountId, "adset");
      return c.json({
        data: {
          currency: link.currency,
          budget_factor: link.budgetFactor,
          adsets: adsets
            .filter((a) => Number.isSafeInteger(Number(a.daily_budget)) && Number(a.daily_budget) > 0)
            .map((a) => ({ external_id: String(a.id), name: String(a.name ?? a.id), daily_budget_units: Number(a.daily_budget) })),
        },
      });
    });
  });

  r.post("/calibration", owner, async (c) => {
    const body = z
      .object({ adset_external_id: z.string().regex(/^\d{3,40}$/), amount_in_ads_manager: z.number().positive().max(1_000_000_000) })
      .parse(await c.req.json());
    const cfg = needConfig();
    const link = await getActiveAdLink(db);
    if (!link) throw new BusinessError("not_found", NOT_LINKED, 404, { reason: "not_linked" });
    if (link.currency !== SHOP_CURRENCY) {
      throw new BusinessError("conflict", "The suite can only manage adverts for an ad account in naira.", 409, { reason: "currency" });
    }
    return guarded(async () => {
      setAdsUsageAccount(link.adAccountId);
      const fresh = await adsGraph<{ id?: string; daily_budget?: unknown; account_id?: unknown }>(
        cfg,
        "GET",
        `${body.adset_external_id}?fields=id,name,daily_budget,account_id`,
      );
      if (`act_${String(fresh?.account_id ?? "")}` !== link.adAccountId) {
        throw new BusinessError("not_found", "That ad set is not in the linked ad account.", 404, { reason: "not_found" });
      }
      const factor = calibrationFactor(Number(fresh?.daily_budget), body.amount_in_ads_manager);
      if (factor === null) {
        throw new BusinessError(
          "validation_failed",
          "That does not match what Meta reports for this ad set. Check the amount in Meta Ads Manager and try again.",
          400,
          { reason: "no_match" },
        );
      }
      const userId = c.get("auth").userId;
      const [updated] = await db
        .update(adAccountLink)
        .set({ budgetFactor: factor, budgetFactorConfirmedBy: userId, budgetFactorConfirmedAt: new Date() })
        .where(eq(adAccountLink.id, link.id))
        .returning();
      const actor = await personActor(db, c);
      await writeAdLogPair(db, {
        actorKind: "person",
        actorUserId: actor.userId,
        actorName: actor.name,
        action: "calibrate",
        adAccountId: link.adAccountId,
        objectLevel: "adset",
        objectExternalId: body.adset_external_id,
        summary: `Checked the budget unit: Meta writes ₦1 as ${factor}.`,
        currency: link.currency,
        request: { adset_external_id: body.adset_external_id, amount_in_ads_manager: body.amount_in_ads_manager, daily_budget_units: Number(fresh.daily_budget) },
        outcome: "ok",
      });
      await writeAudit(db, c, {
        action: "ads.calibrate",
        entityType: "ad_account_link",
        entityId: link.id,
        before: { budget_factor: link.budgetFactor },
        after: { budget_factor: factor },
      });
      return c.json({ data: { budget_factor: factor, account: accountJson(updated!) } });
    });
  });

  // ── Phase B: drafts ───────────────────────────────────────────────────────

  async function loadDraft(id: string): Promise<AdDraftRow> {
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "That advert draft was not found.", 404);
    const [d] = await db.select().from(adDraft).where(eq(adDraft.id, id));
    if (!d) throw new BusinessError("not_found", "That advert draft was not found.", 404);
    return d;
  }

  const hasIds = (d: AdDraftRow) => !!(d.campaignExternalId || d.adsetExternalId || d.creativeExternalId || d.adExternalId);

  r.post("/uploads", manage, async (c) =>
    guarded(async () => {
      await assertCanManage(db);
      const body = z
        .object({ filename: z.string().max(200).optional(), content_type: z.enum(AD_IMAGE_TYPES), size_bytes: z.number().int().positive().max(AD_LIMITS.imageMaxBytes) })
        .parse(await c.req.json());
      const res = await presignAdImagePut({ contentType: body.content_type, sizeBytes: body.size_bytes });
      return c.json({ data: { ...res, upload_token: uploadToken(c.get("auth").userId, res.object_key) } }, 201);
    }),
  );

  const draftBody = z.object({ spec: z.unknown(), image_token: z.string().max(200).optional() });

  r.post("/drafts", manage, async (c) =>
    guarded(async () => {
      await assertCanManage(db);
      const body = draftBody.parse(await c.req.json());
      const spec = parseSpecBody(body.spec);
      const userId = c.get("auth").userId;
      if (!uploadTokenOk(userId, spec.image_key, body.image_token)) {
        throw new BusinessError("validation_failed", "Upload the picture again.", 422, { reason: "image_token" });
      }
      await resolveDraftTargets(db, spec);
      const [d] = await db.insert(adDraft).values({ spec, createdBy: userId }).returning();
      await writeAudit(db, c, { action: "ads.draft_create", entityType: "ad_draft", entityId: d!.id, after: { name: spec.name, daily_budget: spec.daily_budget }, notify: false });
      return c.json({ data: draftJson(d!) }, 201);
    }),
  );

  r.patch("/drafts/:id", manage, async (c) =>
    guarded(async () => {
      await assertCanManage(db);
      const d = await loadDraft(c.req.param("id"));
      if (!["draft", "failed"].includes(d.status) || hasIds(d)) {
        throw new BusinessError("conflict", "This advert has already been sent to Meta, so it can no longer be edited here.", 409, { reason: "not_editable" });
      }
      const body = draftBody.parse(await c.req.json());
      const spec = parseSpecBody(body.spec);
      const userId = c.get("auth").userId;
      if (spec.image_key !== d.spec.image_key && !uploadTokenOk(userId, spec.image_key, body.image_token)) {
        throw new BusinessError("validation_failed", "Upload the picture again.", 422, { reason: "image_token" });
      }
      await resolveDraftTargets(db, spec);
      // Editing clears the confirmation: what was confirmed is what is sent (rule 8.19).
      const [u] = await db
        .update(adDraft)
        .set({ spec, status: "draft", step: "start", imageHash: null, confirmedBy: null, confirmedAt: null, confirmedHash: null, errorCode: null, errorMessage: null, updatedAt: new Date() })
        .where(and(eq(adDraft.id, d.id), sql`${adDraft.status} in ('draft', 'failed')`))
        .returning();
      if (!u) throw new BusinessError("conflict", "This is already in progress.", 409, { reason: "in_progress" });
      await writeAudit(db, c, { action: "ads.draft_update", entityType: "ad_draft", entityId: d.id, before: { daily_budget: d.spec.daily_budget }, after: { name: spec.name, daily_budget: spec.daily_budget }, notify: false });
      return c.json({ data: draftJson(u) });
    }),
  );

  r.get("/drafts", manage, async (c) =>
    guarded(async () => {
      await assertCanManage(db);
      const list = await db.select().from(adDraft).orderBy(desc(adDraft.updatedAt)).limit(100);
      return c.json({ data: list.map(draftJson) });
    }),
  );

  r.get("/drafts/:id", manage, async (c) =>
    guarded(async () => {
      await assertCanManage(db);
      return c.json({ data: draftJson(await loadDraft(c.req.param("id"))) });
    }),
  );

  r.delete("/drafts/:id", manage, async (c) =>
    guarded(async () => {
      await assertCanManage(db);
      const d = await loadDraft(c.req.param("id"));
      if (hasIds(d) || d.status === "creating") {
        throw new BusinessError("conflict", "This advert has already been sent to Meta, so the draft is kept as its record.", 409, { reason: "not_deletable" });
      }
      await db.delete(adDraft).where(eq(adDraft.id, d.id));
      await writeAudit(db, c, { action: "ads.draft_delete", entityType: "ad_draft", entityId: d.id, before: { name: d.spec.name }, notify: false });
      return c.json({ data: { ok: true } });
    }),
  );

  r.post("/drafts/:id/preview", manage, async (c) =>
    guarded(async () => {
      const cfg = needConfig();
      const d = await loadDraft(c.req.param("id"));
      const p = await previewDraft(db, cfg, d);
      const { link } = await assertCanManage(db);
      const warnings: string[] = [...p.problems];
      const acc = await getAdAccount(cfg, link.adAccountId).catch(() => null);
      if (acc && !acc.funding_source) {
        warnings.push("Meta shows no payment method on this ad account. The advert can be created but will not run until one is added.");
      }
      return c.json({
        data: {
          lines: p.lines,
          max_spend: p.maxSpend,
          confirm_text: p.confirmText,
          content_hash: p.contentHash,
          cap: { ok: p.cap.ok, cap: p.cap.cap, already_committed: p.cap.alreadyCommitted, requested: p.cap.requested, room: p.cap.room },
          min_daily: p.minDaily,
          warnings,
        },
      });
    }),
  );

  const createDeps = () => ({ loadImage: adImageSource.load, shop: shopPosition() });

  r.post("/drafts/:id/create", manage, async (c) =>
    guarded(async () => {
      const cfg = needConfig();
      const body = z.object({ content_hash: z.string().min(1).max(128), typed: z.string().max(60) }).parse(await c.req.json());
      const actor = await personActor(db, c);
      await assertActorMayManage(db, actor);
      const { link, settings } = await assertCanManage(db);
      const d = await loadDraft(c.req.param("id"));
      if (!["draft", "failed"].includes(d.status)) throw new BusinessError("conflict", "This is already in progress.", 409, { reason: "in_progress" });
      const spec = parseDraftSpec(d.spec);
      const hash = draftFingerprint(spec);
      if (body.content_hash !== hash) {
        throw new BusinessError("conflict", "This advert changed while you were looking at it. Check it again.", 409, { reason: "stale" });
      }
      const targets = await resolveDraftTargets(db, spec);
      // The total is worked out here from the stored draft. Nothing the browser says about amounts is used.
      const summary = buildAdSummary(spec, { accountLabel: targets.accountLabel, adAccountName: link.name, currency: link.currency, shopName: ADS_SHOP_NAME });
      if (normaliseTyped(body.typed) !== summary.confirmText) {
        throw new BusinessError("validation_failed", "Type the total exactly as shown to confirm.", 400, { reason: "wrong_total" });
      }
      await assertDraftBudgetAllowed(db, link, settings, spec, actor);
      const [confirmed] = await db
        .update(adDraft)
        .set({ confirmedBy: actor.userId, confirmedAt: new Date(), confirmedHash: hash, updatedAt: new Date() })
        .where(and(eq(adDraft.id, d.id), sql`${adDraft.status} in ('draft', 'failed')`))
        .returning({ id: adDraft.id });
      if (!confirmed) throw new BusinessError("conflict", "This is already in progress.", 409, { reason: "in_progress" });
      const result = await createAdFromDraft(db, cfg, d.id, actor, createDeps(), "create");
      await writeAudit(db, c, {
        action: "ads.advert_create",
        entityType: "ad_draft",
        entityId: d.id,
        after: { name: spec.name, lines: summary.lines, max_spend: summary.maxSpend, status: result.status, campaign_external_id: result.campaignExternalId },
      });
      return c.json({ data: draftJson(result) });
    }),
  );

  r.post("/drafts/:id/continue", manage, async (c) =>
    guarded(async () => {
      const cfg = needConfig();
      const actor = await personActor(db, c);
      const d = await loadDraft(c.req.param("id"));
      // Only what was confirmed may be carried on with; otherwise the total must be typed again.
      if (!d.confirmedHash || draftFingerprint(parseDraftSpec(d.spec)) !== d.confirmedHash) {
        throw new BusinessError("conflict", "This advert changed while you were looking at it. Check it again.", 409, { reason: "stale" });
      }
      const result = await createAdFromDraft(db, cfg, d.id, actor, createDeps(), "continue");
      await writeAudit(db, c, { action: "ads.advert_continue", entityType: "ad_draft", entityId: d.id, after: { status: result.status, step: result.step } });
      return c.json({ data: draftJson(result) });
    }),
  );

  // ── Phase B: turning on, pausing, changing a budget ───────────────────────

  const objectId = z.string().regex(/^\d{3,40}$/);

  r.get("/adverts/:campaignExternalId/turn-on-preview", manage, async (c) =>
    guarded(async () => {
      const id = objectId.parse(c.req.param("campaignExternalId"));
      const p = await turnOnPreview(db, needConfig(), id);
      return c.json({
        data: { ...p, cap: { ok: p.cap.ok, cap: p.cap.cap, already_committed: p.cap.alreadyCommitted, requested: p.cap.requested, room: p.cap.room } },
      });
    }),
  );

  r.post("/adverts/:campaignExternalId/turn-on", manage, async (c) =>
    guarded(async () => {
      const id = objectId.parse(c.req.param("campaignExternalId"));
      const { typed } = z.object({ typed: z.string().max(60) }).parse(await c.req.json());
      const actor = await personActor(db, c);
      await turnOnAdvert(db, needConfig(), id, actor, { typed });
      await writeAudit(db, c, { action: "ads.advert_turn_on", entityType: "ad_campaign", entityId: id, after: { status: "ACTIVE" } });
      return c.json({ data: { ok: true } });
    }),
  );

  // Pausing does not need the master switch: it must always be possible. It still needs ads.manage and a linked account.
  r.post("/objects/:level/:externalId/pause", manage, async (c) =>
    guarded(async () => {
      const level = z.enum(["campaign", "adset", "ad"]).parse(c.req.param("level"));
      const id = objectId.parse(c.req.param("externalId"));
      const actor = await personActor(db, c);
      const [cached] = await db
        .select({ name: adCampaignCache.name })
        .from(adCampaignCache)
        .where(and(eq(adCampaignCache.level, level), eq(adCampaignCache.externalId, id)));
      await pauseObject(db, needConfig(), level, id, actor, `Paused "${cached?.name ?? id}".`);
      await writeAudit(db, c, { action: "ads.pause", entityType: `ad_${level}`, entityId: id, after: { status: "PAUSED" } });
      return c.json({ data: { ok: true } });
    }),
  );

  r.post("/adsets/:externalId/budget-preview", manage, async (c) =>
    guarded(async () => {
      const id = objectId.parse(c.req.param("externalId"));
      const { daily_budget: daily } = z.object({ daily_budget: z.number().int().min(1).max(1_000_000_000) }).parse(await c.req.json());
      const p = await budgetPreview(db, needConfig(), id, daily);
      return c.json({
        data: { ...p, cap: { ok: p.cap.ok, cap: p.cap.cap, already_committed: p.cap.alreadyCommitted, requested: p.cap.requested, room: p.cap.room } },
      });
    }),
  );

  r.post("/adsets/:externalId/budget", manage, async (c) =>
    guarded(async () => {
      const id = objectId.parse(c.req.param("externalId"));
      const body = z.object({ daily_budget: z.number().int().min(1).max(1_000_000_000), typed: z.string().max(60) }).parse(await c.req.json());
      const actor = await personActor(db, c);
      const res = await changeDailyBudget(db, needConfig(), id, body.daily_budget, actor, { typed: body.typed });
      await writeAudit(db, c, { action: "ads.budget_change", entityType: "ad_adset", entityId: id, before: { daily_budget: res.before }, after: { daily_budget: res.after } });
      return c.json({ data: { ok: true, daily_budget: res.after } });
    }),
  );

  // ── Phase B: rules (they can only pause) ──────────────────────────────────

  const ruleBody = z
    .object({
      name: z.string().trim().min(1).max(60),
      threshold: z.number().positive().max(1_000_000_000),
      lookback_days: z.union([z.literal(1), z.literal(3), z.literal(7)]),
      min_spend: z.number().min(0).max(1_000_000_000),
      scope_campaign_external_id: z.string().regex(/^\d{3,40}$/).nullable(),
      is_active: z.boolean(),
    })
    .strict();

  const ruleJson = (x: typeof adRule.$inferSelect) => ({
    id: x.id,
    name: x.name,
    metric: x.metric,
    threshold: Number(x.threshold),
    currency: x.currency,
    lookback_days: x.lookbackDays,
    min_spend: Number(x.minSpend),
    scope_campaign_external_id: x.scopeCampaignExternalId,
    is_active: x.isActive,
    last_evaluated_at: x.lastEvaluatedAt,
    last_fired_at: x.lastFiredAt,
  });

  r.get("/rules", manage, async (c) => {
    const list = await db.select().from(adRule).orderBy(adRule.createdAt);
    const settings = await getAdsSettings(db);
    const link = await getActiveAdLink(db);
    const campaigns = link
      ? await db
          .select({ external_id: adCampaignCache.externalId, name: adCampaignCache.name })
          .from(adCampaignCache)
          .where(and(eq(adCampaignCache.adAccountId, link.adAccountId), eq(adCampaignCache.level, "campaign"), eq(adCampaignCache.createdBySuite, true)))
      : [];
    return c.json({ data: list.map(ruleJson), rules_enabled: settings.rules_enabled, manage_enabled: settings.manage_enabled, campaigns });
  });

  r.post("/rules", manage, async (c) =>
    guarded(async () => {
      const { link } = await assertCanManage(db);
      const body = ruleBody.parse(await c.req.json());
      const [row] = await db
        .insert(adRule)
        .values({
          name: body.name,
          metric: "cost_per_conversation",
          threshold: body.threshold.toFixed(2),
          currency: link.currency,
          lookbackDays: body.lookback_days,
          minSpend: body.min_spend.toFixed(2),
          scopeCampaignExternalId: body.scope_campaign_external_id,
          isActive: body.is_active,
          createdBy: c.get("auth").userId,
        })
        .returning();
      await writeAudit(db, c, { action: "ads.rule_create", entityType: "ad_rule", entityId: row!.id, after: ruleJson(row!) });
      return c.json({ data: ruleJson(row!) }, 201);
    }),
  );

  r.patch("/rules/:id", manage, async (c) =>
    guarded(async () => {
      const { link } = await assertCanManage(db);
      const id = z.string().uuid().parse(c.req.param("id"));
      const body = ruleBody.partial().parse(await c.req.json());
      const [before] = await db.select().from(adRule).where(eq(adRule.id, id));
      if (!before) throw new BusinessError("not_found", "That rule was not found.", 404);
      const [row] = await db
        .update(adRule)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.threshold !== undefined ? { threshold: body.threshold.toFixed(2) } : {}),
          ...(body.lookback_days !== undefined ? { lookbackDays: body.lookback_days } : {}),
          ...(body.min_spend !== undefined ? { minSpend: body.min_spend.toFixed(2) } : {}),
          ...(body.scope_campaign_external_id !== undefined ? { scopeCampaignExternalId: body.scope_campaign_external_id } : {}),
          ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
          currency: link.currency,
          updatedAt: new Date(),
        })
        .where(eq(adRule.id, id))
        .returning();
      await writeAudit(db, c, { action: "ads.rule_update", entityType: "ad_rule", entityId: id, before: ruleJson(before), after: ruleJson(row!) });
      return c.json({ data: ruleJson(row!) });
    }),
  );

  // Deleting a rule can only reduce what the suite does by itself, so it works with the master switch off too.
  r.delete("/rules/:id", manage, async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const [gone] = await db.delete(adRule).where(eq(adRule.id, id)).returning();
    if (!gone) throw new BusinessError("not_found", "That rule was not found.", 404);
    await writeAudit(db, c, { action: "ads.rule_delete", entityType: "ad_rule", entityId: id, before: ruleJson(gone) });
    return c.json({ data: { ok: true } });
  });

  /** The channel accounts an advert may open a chat with (for the form's select). No call to Meta. */
  r.get("/destinations", manage, async (c) => {
    const lines = await rows(
      db,
      sql`select id, kind, label, e164, waba_id from inbox_phone_number where is_active order by created_at`,
    );
    const kindOf = { whatsapp: "phone", messenger: "messenger", instagram: "instagram" } as const;
    return c.json({
      data: ENABLED_DESTINATIONS.map((destination) => ({
        destination,
        accounts: lines
          .filter((l) => l.kind === kindOf[destination] && (destination !== "whatsapp" || (l.e164 && l.waba_id)))
          .map((l) => ({ id: String(l.id), label: String(l.label) })),
      })),
    });
  });

  return r;
}
