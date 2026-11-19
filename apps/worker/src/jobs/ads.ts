/**
 * Ads background jobs (suite spec 12, section 6). Thin wrappers: they read the
 * configuration and call the domain functions, which hold the rules.
 *
 *   - runAdTouchScan:       note which chats came from an advert (our own data; no call to Meta)
 *   - runAdAttribution:     tie paid orders to those chats, then decide which may be reported
 *   - runAdPurchaseReports: tell Meta about a purchase; ONLY while the owner's switch is on
 *   - runAdSyncIfDue:       read the ad account's figures (read-only at Meta)
 *   - runAdGuard:           the safety stop and the owner's rules
 *
 * WHAT THESE JOBS MAY DO TO AN ADVERT: PAUSE IT. NOTHING ELSE.
 * No job here creates an advert, turns one on, raises or changes a budget, or
 * changes targeting, and none ever will: this file must not import
 * createAdFromDraft, turnOnAdvert or changeDailyBudget (a test fails if it
 * does), and @ms/domain refuses any unattended write to Meta that is not
 * exactly { status: "PAUSED" }.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import {
  attributeOrders,
  capiAllowed,
  evaluateRules,
  getActiveAdLink,
  getAdsSettings,
  metaConfigFromEnv,
  patchAdsSettings,
  queuePurchaseReports,
  safetyBrake,
  scanAdTouches,
  sendPurchaseReports,
  syncAdAccount,
  type MetaConfig,
} from "@ms/domain";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

const SHOP_ZONE = "Africa/Lagos";

function lagos(now: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return { day: `${p("year")}-${p("month")}-${p("day")}`, hour: Number(p("hour")) };
}

/** Works with no ad account linked and with Meta not configured: it only reads what the inbox stored. */
export async function runAdTouchScan(db: DbClient, log: Log, now: Date = new Date()): Promise<number> {
  const created = await scanAdTouches(db, now);
  if (created) log.info({ created }, "ads: chats from adverts noted");
  return created;
}

export async function runAdAttribution(db: DbClient, log: Log, now: Date = new Date()): Promise<{ attributed: number; queued: number }> {
  const settings = await getAdsSettings(db);
  const attributed = await attributeOrders(db, settings.attribution_window_days, now);
  // Does nothing unless the owner has switched purchase reporting on.
  const queued = await queuePurchaseReports(db, settings, now);
  if (attributed || queued) log.info({ attributed, queued }, "ads: orders traced to adverts");
  return { attributed, queued };
}

/** Sends nothing unless "Report purchases to Meta" is on and the owner's privacy statement is on record. */
export async function runAdPurchaseReports(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  const settings = await getAdsSettings(db);
  if (!capiAllowed(settings)) return 0;
  const sent = await sendPurchaseReports(db, cfg, settings, log, now);
  if (sent) log.info({ sent }, "ads: purchases reported to Meta");
  return sent;
}

const MIN_SYNC_GAP_MS = 10 * 60_000;

/**
 * A full read of the ad account when someone pressed "Refresh figures", or
 * once a day from 7 am Lagos time. Never more often than every 10 minutes.
 */
export async function runAdSyncIfDue(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<{ objects: number; days: number } | null> {
  if (!cfg) return null;
  const link = await getActiveAdLink(db);
  if (!link) return null;
  const settings = await getAdsSettings(db);
  const { day, hour } = lagos(now);
  const asked = settings.refresh_requested_at ? new Date(settings.refresh_requested_at).getTime() : 0;
  const lastSync = link.lastSyncedAt ? link.lastSyncedAt.getTime() : 0;
  const refreshAsked = asked > lastSync;
  const dailyDue = hour >= 7 && settings.last_sync_day !== day;
  if (!refreshAsked && !dailyDue) return null;
  if (lastSync && now.getTime() - lastSync < MIN_SYNC_GAP_MS) return null;
  const result = await syncAdAccount(db, cfg, log, now);
  await db.transaction((tx) => patchAdsSettings(tx, { last_sync_day: day, refresh_requested_at: null }));
  log.info(result, "ads: ad account read");
  return result;
}

/**
 * The safety stop on every run; the owner's rules at most once an hour, and
 * only while the owner has both "create adverts" and "rules" switched on.
 * Both can only PAUSE.
 */
export async function runAdGuard(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<{ stopped: number; rulePauses: number } | null> {
  if (!cfg) return null;
  const link = await getActiveAdLink(db);
  if (!link) return null;
  const stopped = await safetyBrake(db, cfg, log, now);
  let rulePauses = 0;
  const settings = await getAdsSettings(db);
  if (settings.manage_enabled && settings.rules_enabled) {
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    const due = (await db.execute(
      sql`select 1 from ad_rule where is_active and (last_evaluated_at is null or last_evaluated_at <= ${hourAgo}::timestamptz) limit 1`,
    )) as unknown as unknown[];
    if (due.length) rulePauses = await evaluateRules(db, cfg, log, now);
  }
  if (stopped || rulePauses) log.warn({ stopped, rulePauses }, "ads: adverts paused");
  return { stopped, rulePauses };
}
