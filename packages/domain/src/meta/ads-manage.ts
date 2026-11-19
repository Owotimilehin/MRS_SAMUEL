/**
 * Ads, Phase B (suite spec 12, sections 5.8 to 5.12): the only code in the
 * suite that can spend the owner's money. Read this before changing it.
 *
 * The rules, and where each is enforced in this file:
 *
 *  1. OFF BY DEFAULT. assertCanManage() refuses everything unless the owner has
 *     switched "Allow adverts to be created and changed from the suite" on, an
 *     ad account is linked and active, its budget unit has been checked, and
 *     it is in naira. Create, turn on and change budget all call it themselves
 *     (not only the routes).
 *  2. A NAMED PERSON WITH ads.manage. assertActorMayManage() re-reads the
 *     person from the database; the route's own permission check is the first
 *     gate, this is the second.
 *  3. THE DAILY CAP is checked in our code before any call that could raise
 *     spending, from a fresh read of Meta (checkCap). If Meta cannot be read
 *     the action is refused. A refused action makes no write to Meta.
 *  4. CREATED SWITCHED OFF. Every create body carries status "PAUSED";
 *     metaWrite() refuses a create whose body says anything else.
 *  5. THE TYPED TOTAL is worked out here, on the server, from the stored draft
 *     or a fresh read of Meta, and compared with what the person typed.
 *  6. NEVER TWICE. The draft row is claimed first; each step's ID is saved
 *     before the next; a call with no answer is "needs_check" and is resolved
 *     by looking the object up at Meta by its name tag, never by re-sending.
 *  7. UNATTENDED CODE CAN ONLY PAUSE. Every write to an ad object goes through
 *     metaWrite(), and metaWrite() refuses any write from a rule, the safety
 *     stop or the system that is not exactly { status: "PAUSED" }.
 *  8. EVERYTHING IS LOGGED, before and after, in the append-only ad_action_log.
 *  9. BUDGETS ARE WHOLE NAIRA here; budgetToMetaUnits() in @ms/shared is the
 *     only conversion to Meta's integer.
 */
import crypto from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  adActionLog,
  adCampaignCache,
  adDraft,
  adRule,
  adminUser,
  inboxPhoneNumber,
  type AdDraftSpec,
  type AdsSettingsValue,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  BudgetUnitError,
  ENABLED_DESTINATIONS,
  SHOP_CURRENCY,
  adDraftSpecSchema,
  budgetToMetaUnits,
  confirmTextFor,
  costPerConversation,
  draftProblems,
  evaluateCap,
  maxSpend,
  money,
  nameTag,
  normaliseTyped,
  remainingMaxSpend,
  resolveCapabilities,
  runDays,
  summariseActions,
  type AdAction,
  type AdminRole,
  type CapResult,
  type Capability,
} from "@ms/shared";
import { MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { listChannelAccounts } from "./accounts.js";
import {
  addDays,
  adsGraph,
  adsMetaCode,
  classifyAdsError,
  dayInZone,
  getActiveAdLink,
  getAdsSettings,
  listAdObjectsPaged,
  newAdRequestId,
  raiseAdsAlert,
  setAdsUsageAccount,
  upsertAdObjects,
  writeAdLog,
  writeAdLogPair,
  type AdAccountLinkRow,
  type AdsLog,
} from "./ads.js";

export type AdDraftRow = typeof adDraft.$inferSelect;
export type AdRuleRow = typeof adRule.$inferSelect;

/** Shown on the summary: "…opens a WhatsApp chat with Mrs Samuel — Main line." */
export const ADS_SHOP_NAME = "Mrs Samuel";

export type AdsManageCode =
  | "off"
  | "no_account"
  | "account_not_active"
  | "not_calibrated"
  | "currency"
  | "not_allowed"
  | "cap_unknown"
  | "over_cap"
  | "not_found"
  | "not_suite_made"
  | "ended"
  | "invalid"
  | "not_confirmed"
  | "wrong_total"
  | "below_minimum"
  | "in_progress"
  | "too_many_changes"
  | "not_confirmed_by_meta"
  | "mismatch";

/** A refusal made by the suite itself, with the sentence staff see. */
export class AdsManageError extends Error {
  constructor(
    public readonly code: AdsManageCode,
    public readonly staffMessage: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(staffMessage);
    this.name = "AdsManageError";
  }
}

export const ADS_MANAGE_OFF = "Creating and changing adverts is switched off. The owner can turn it on in Ads → Settings.";
export const ADS_CAP_UNKNOWN = "We could not check current budgets with Meta, so nothing was changed. Try again in a few minutes.";
export const ADS_VERIFY_MISMATCH =
  "Meta saved a different budget or state than we sent. Do not turn this advert on. Check it in Meta Ads Manager.";
export const ADS_IN_PROGRESS = "This is already in progress.";

export interface PersonActor {
  kind: "person";
  userId: string;
  name: string;
}
/** Who may pause: a person, a rule, or the safety stop. Rules and the safety stop can do nothing else. */
export type PauseActor = PersonActor | { kind: "rule" | "safety"; userId: null; name: string };

// ── The gates ────────────────────────────────────────────────────────────────

/** The five conditions every money action needs, in order (section 5.8). */
export async function assertCanManage(db: DbExecutor): Promise<{ link: AdAccountLinkRow; settings: AdsSettingsValue }> {
  const settings = await getAdsSettings(db);
  if (settings.manage_enabled !== true) throw new AdsManageError("off", ADS_MANAGE_OFF);
  const link = await getActiveAdLink(db);
  if (!link) throw new AdsManageError("no_account", "No ad account is linked yet. The owner can link one in Ads → Settings.");
  if (link.accountStatus !== 1) {
    throw new AdsManageError("account_not_active", "Meta shows this ad account as not active. Check it in Meta Ads Manager.");
  }
  if (link.budgetFactor !== 1 && link.budgetFactor !== 100) {
    throw new AdsManageError("not_calibrated", "The budget unit for this ad account has not been checked yet. The owner can check it in Ads → Settings.");
  }
  // The shop works in naira. A dollar ad account would need an exchange rate, which the suite refuses to guess.
  if (link.currency !== SHOP_CURRENCY) {
    throw new AdsManageError("currency", "The suite can only manage adverts for an ad account in naira.");
  }
  return { link, settings };
}

/** The person exists, is active, and holds ads.manage right now (owner only unless the owner granted it). */
export async function assertActorMayManage(db: DbExecutor, actor: PersonActor): Promise<void> {
  const refuse = () => new AdsManageError("not_allowed", "You do not have permission to manage adverts.");
  if (actor?.kind !== "person" || !actor.userId) throw refuse();
  const [u] = await db
    .select({ role: adminUser.role, overrides: adminUser.permissionOverrides, isActive: adminUser.isActive, deletedAt: adminUser.deletedAt })
    .from(adminUser)
    .where(eq(adminUser.id, actor.userId));
  if (!u || !u.isActive || u.deletedAt) throw refuse();
  const caps = resolveCapabilities(u.role as AdminRole, {
    granted: (u.overrides?.granted ?? []) as Capability[],
    revoked: (u.overrides?.revoked ?? []) as Capability[],
  });
  if (!caps.includes("ads.manage")) throw refuse();
}

function account(link: AdAccountLinkRow): { currency: string; budgetFactor: number | null } {
  return { currency: link.currency, budgetFactor: link.budgetFactor };
}

/** Naira → Meta's integer, as a staff-readable refusal when it cannot be done. */
function unitsFor(amountNgn: number, link: AdAccountLinkRow): number {
  try {
    return budgetToMetaUnits(amountNgn, account(link));
  } catch (e) {
    if (e instanceof BudgetUnitError) {
      throw new AdsManageError(e.reason === "currency" ? "currency" : e.reason === "not_calibrated" ? "not_calibrated" : "invalid", e.message);
    }
    throw e;
  }
}

/** Meta's integer → whole naira, rounded UP (used for the cap and the minimum, where more is the safe side). */
function nairaCeil(units: number, link: AdAccountLinkRow): number {
  const f = link.budgetFactor === 100 ? 100 : 1;
  return Math.ceil(units / f);
}

function intOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function dateOf(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── The one write function ───────────────────────────────────────────────────

type WriteAction =
  | "upload_image"
  | "create_campaign"
  | "create_adset"
  | "create_creative"
  | "create_ad"
  | "turn_on"
  | "pause"
  | "budget_change";

interface MetaWrite {
  actor: PauseActor;
  action: WriteAction;
  link: AdAccountLinkRow;
  level: "campaign" | "adset" | "ad" | "creative" | "image";
  /** The object changed, or null for a create. */
  externalId: string | null;
  path: string;
  body: Record<string, unknown>;
  summary: string;
  maxSpendUnits?: number | null;
  confirmText?: string | null;
}

/** Thrown when code tries a write the rules above forbid. This is a bug guard, not a staff message. */
export class AdWriteForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdWriteForbiddenError";
  }
}

const CREATE_ACTIONS: readonly WriteAction[] = ["create_campaign", "create_adset", "create_creative", "create_ad"];

/**
 * Check a write against the hard rules before anything is logged or sent.
 * Exported for tests.
 */
export function assertWriteAllowed(w: Pick<MetaWrite, "actor" | "action" | "externalId" | "path" | "body">): void {
  const body = w.body ?? {};
  const keys = Object.keys(body);
  const isPauseOnly = keys.length === 1 && body.status === "PAUSED";
  // Rule 7: a rule, the safety stop or the system may only pause an existing object.
  if (w.actor.kind !== "person") {
    if (w.action !== "pause" || !isPauseOnly || !w.externalId || w.path !== w.externalId) {
      throw new AdWriteForbiddenError(`unattended write refused: only { status: "PAUSED" } is allowed (${w.action})`);
    }
    return;
  }
  if (w.action === "pause") {
    if (!isPauseOnly || !w.externalId || w.path !== w.externalId) throw new AdWriteForbiddenError("a pause may only set status PAUSED");
    return;
  }
  // Rule 4: everything is created switched off.
  if (CREATE_ACTIONS.includes(w.action)) {
    if (w.externalId) throw new AdWriteForbiddenError("a create has no object yet");
    if (w.action !== "create_creative" && body.status !== "PAUSED") throw new AdWriteForbiddenError(`${w.action} must be created PAUSED`);
    if (JSON.stringify(body).includes('"ACTIVE"')) throw new AdWriteForbiddenError(`${w.action} may not contain ACTIVE`);
    if ("lifetime_budget" in body || "bid_amount" in body) throw new AdWriteForbiddenError("no lifetime budgets or bid caps");
    if ("daily_budget" in body && w.action !== "create_adset") throw new AdWriteForbiddenError("only an ad set carries a budget");
    return;
  }
  if (w.action === "upload_image") {
    if (keys.length !== 1 || typeof body.bytes !== "string") throw new AdWriteForbiddenError("an image upload carries only the picture");
    return;
  }
  if (w.action === "turn_on") {
    if (keys.length !== 1 || body.status !== "ACTIVE" || !w.externalId || w.path !== w.externalId) {
      throw new AdWriteForbiddenError("turning on may only set status ACTIVE");
    }
    return;
  }
  if (w.action === "budget_change") {
    if (keys.length !== 1 || !Number.isSafeInteger(body.daily_budget) || !w.externalId || w.path !== w.externalId) {
      throw new AdWriteForbiddenError("a budget change may only set daily_budget");
    }
    return;
  }
  throw new AdWriteForbiddenError(`unknown write: ${String(w.action)}`);
}

function loggableBody(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.bytes === "string") return { ...body, bytes: `<picture, ${Math.round((body.bytes.length * 3) / 4)} bytes>` };
  return body;
}

/**
 * THE one function that sends a write to an ad object. It checks the hard
 * rules, writes the 'requested' log row (committed: `db` is the pooled client,
 * never a transaction), calls Meta, then writes the 'result' row. A refusal or
 * a missing answer is logged and thrown on as MetaApiError.
 */
async function metaWrite<T>(db: DbClient, cfg: MetaConfig, w: MetaWrite): Promise<T> {
  assertWriteAllowed(w);
  const requestId = newAdRequestId();
  const base = {
    requestId,
    actorKind: w.actor.kind,
    actorUserId: w.actor.userId,
    actorName: w.actor.name,
    action: w.action,
    adAccountId: w.link.adAccountId,
    objectLevel: w.level,
    objectExternalId: w.externalId,
    summary: w.summary,
    maxSpendUnits: w.maxSpendUnits ?? null,
    currency: w.link.currency,
    confirmText: w.confirmText ?? null,
    request: { method: "POST", path: w.path, body: loggableBody(w.body) },
  };
  await writeAdLog(db, { ...base, phase: "requested" });
  try {
    setAdsUsageAccount(w.link.adAccountId);
    const res = await adsGraph<T>(cfg, "POST", w.path, w.body);
    const id = (res as { id?: unknown } | null)?.id;
    await writeAdLog(db, {
      ...base,
      phase: "result",
      outcome: "ok",
      objectExternalId: w.externalId ?? (id != null ? String(id) : null),
      response: (res && typeof res === "object" ? (res as Record<string, unknown>) : { value: res }) as Record<string, unknown>,
    });
    return res;
  } catch (err) {
    const meta = err instanceof MetaApiError ? err : null;
    await writeAdLog(db, {
      ...base,
      phase: "result",
      outcome: meta && classifyAdsError(meta) !== "unknown" ? "refused" : "unknown",
      metaCode: meta ? adsMetaCode(meta) : null,
      metaMessage: meta ? meta.message : "The suite stopped before Meta answered.",
    });
    throw err;
  }
}

// ── Calibration (section 5.9) ────────────────────────────────────────────────

/** How many of Meta's units make ₦1: exactly 1 or exactly 100, or null when the two numbers do not agree. */
export function calibrationFactor(dailyBudgetUnits: number, amountInAdsManager: number): 1 | 100 | null {
  if (!Number.isSafeInteger(dailyBudgetUnits) || dailyBudgetUnits <= 0) return null;
  if (!Number.isFinite(amountInAdsManager) || amountInAdsManager <= 0) return null;
  if (dailyBudgetUnits === amountInAdsManager) return 1;
  if (dailyBudgetUnits === amountInAdsManager * 100) return 100;
  return null;
}

// ── The cap (section 5.10) ───────────────────────────────────────────────────

/**
 * Would `requestedDaily` (whole naira) fit under the owner's cap, counting
 * every live ad set in the account as Meta reports it right now? Reads Meta
 * fresh; never the cache. If the read fails or is incomplete, the answer is a
 * refusal ("cap_unknown"), never a guess.
 */
export async function checkCap(
  cfg: MetaConfig,
  link: AdAccountLinkRow,
  settings: AdsSettingsValue,
  req: { requestedDaily: number; excludeAdsetExternalId?: string; now?: Date },
): Promise<CapResult> {
  if ((link.budgetFactor !== 1 && link.budgetFactor !== 100) || link.currency !== SHOP_CURRENCY) {
    throw new AdsManageError("cap_unknown", ADS_CAP_UNKNOWN);
  }
  const now = req.now ?? new Date();
  let campaigns: Record<string, unknown>[];
  let adsets: Record<string, unknown>[];
  try {
    setAdsUsageAccount(link.adAccountId);
    const c = await listAdObjectsPaged(cfg, link.adAccountId, "campaign");
    const a = await listAdObjectsPaged(cfg, link.adAccountId, "adset");
    if (!c.complete || !a.complete) throw new Error("the list was too long to read completely");
    campaigns = c.rows;
    adsets = a.rows;
  } catch {
    throw new AdsManageError("cap_unknown", ADS_CAP_UNKNOWN);
  }
  const byId = new Map(campaigns.map((c) => [String(c.id), c]));
  const counted = new Set<string>();
  const others: number[] = [];
  const perDay = (lifetimeUnits: number, end: Date | null) =>
    Math.ceil(nairaCeil(lifetimeUnits, link) / (end && end.getTime() > now.getTime() ? runDays(now, end) : 1));
  for (const a of adsets) {
    const id = String(a.id ?? "");
    if (req.excludeAdsetExternalId && id === req.excludeAdsetExternalId) continue;
    if (a.status !== "ACTIVE") continue;
    const campaignId = String(a.campaign_id ?? "");
    const camp = byId.get(campaignId);
    // A live ad set whose campaign we cannot see: we cannot know what it spends.
    if (!camp) throw new AdsManageError("cap_unknown", ADS_CAP_UNKNOWN);
    if (camp.status !== "ACTIVE") continue;
    const campDaily = intOf(camp.daily_budget) ?? 0;
    const campLifetime = intOf(camp.lifetime_budget) ?? 0;
    if (campDaily > 0 || campLifetime > 0) {
      // The campaign holds the budget: count it once, and nothing for its ad sets.
      if (!counted.has(campaignId)) {
        counted.add(campaignId);
        others.push(campDaily > 0 ? nairaCeil(campDaily, link) : perDay(campLifetime, dateOf(camp.stop_time)));
      }
      continue;
    }
    const daily = intOf(a.daily_budget) ?? 0;
    const lifetime = intOf(a.lifetime_budget) ?? 0;
    if (daily > 0) others.push(nairaCeil(daily, link));
    else if (lifetime > 0) others.push(perDay(lifetime, dateOf(a.end_time)));
    else throw new AdsManageError("cap_unknown", ADS_CAP_UNKNOWN);
  }
  return evaluateCap({ cap: settings.daily_cap, othersActiveDaily: others, requestedDaily: req.requestedDaily });
}

export function overCapMessage(cap: CapResult): string {
  return `This would take live daily budgets to ${money(cap.alreadyCommitted + cap.requested, "NGN")}, over your cap of ${money(cap.cap, "NGN")}. Lower the amount, pause another advert, or ask the owner to raise the cap.`;
}

/** Log a blocked action (no call to Meta was made) and build the refusal. */
async function blockedByCap(
  db: DbClient,
  link: AdAccountLinkRow,
  actor: PersonActor,
  action: string,
  level: string,
  externalId: string | null,
  cap: CapResult,
): Promise<AdsManageError> {
  await writeAdLogPair(db, {
    actorKind: "person",
    actorUserId: actor.userId,
    actorName: actor.name,
    action,
    adAccountId: link.adAccountId,
    objectLevel: level,
    objectExternalId: externalId,
    summary: `Blocked by the daily cap: ${money(cap.requested, "NGN")} asked for, ${money(cap.alreadyCommitted, "NGN")} already live, cap ${money(cap.cap, "NGN")}.`,
    currency: link.currency,
    request: { blocked: true, requested: cap.requested, already_committed: cap.alreadyCommitted, cap: cap.cap },
    outcome: "blocked",
  });
  return new AdsManageError("over_cap", overCapMessage(cap), {
    cap: cap.cap,
    already_committed: cap.alreadyCommitted,
    requested: cap.requested,
  });
}

/** Meta's minimum daily budget for the account in whole naira (rounded up), or null when unknown. */
export function minDailyNaira(link: AdAccountLinkRow): number | null {
  if (link.minDailyBudgetUnits == null || (link.budgetFactor !== 1 && link.budgetFactor !== 100)) return null;
  return nairaCeil(link.minDailyBudgetUnits, link);
}

// ── Building an advert (section 5.11) ────────────────────────────────────────

const LAGOS = "Africa/Lagos";

/** "Mon 23 Nov 2026 9:00 am", Lagos time. */
export function lagosDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LAGOS,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")} ${p("year")} ${p("hour")}:${p("minute")} ${p("dayPeriod").toLowerCase()}`;
}

const DESTINATION_WORDS = { whatsapp: "a WhatsApp chat", messenger: "a Messenger chat", instagram: "an Instagram chat" } as const;

/**
 * The plain-English summary the owner confirms, and the total they must type.
 * The numbers are worked out here from the stored draft; nothing the browser
 * sends is used.
 */
export function buildAdSummary(
  spec: AdDraftSpec,
  ctx: { accountLabel: string; adAccountName: string; currency: string; shopName: string },
): { lines: string[]; maxSpend: number; confirmText: string } {
  const start = new Date(spec.start_at);
  const end = new Date(spec.end_at);
  const days = runDays(start, end);
  const total = maxSpend(spec.daily_budget, start, end);
  const who =
    spec.audience.area === "near_shop"
      ? `within ${spec.audience.radius_km} km of the shop`
      : "in Nigeria";
  return {
    lines: [
      `This creates an advert on Facebook and Instagram that opens ${DESTINATION_WORDS[spec.destination]} with ${ctx.shopName} — ${ctx.accountLabel}.`,
      `Headline: "${spec.headline}". Main text: "${spec.primary_text}".`,
      `Shown to: people aged ${spec.audience.age_min} to ${spec.audience.age_max} ${who}.`,
      `Budget: up to ${money(spec.daily_budget, ctx.currency)} a day, from ${lagosDateTime(start)} to ${lagosDateTime(end)} (${days} ${days === 1 ? "day" : "days"}).`,
      `**The most this advert can spend: ${money(total, ctx.currency)}.**`,
      `Meta takes the money from the ad account "${ctx.adAccountName}" using the payment method saved there.`,
      "It will be created **switched off**. Nothing is spent until you turn it on.",
      "You have confirmed it is not about jobs, housing, loans or financial services, politics, or gambling.",
    ],
    maxSpend: total,
    confirmText: confirmTextFor(total),
  };
}

const DESTINATION_TYPE = { whatsapp: "WHATSAPP", messenger: "MESSENGER", instagram: "INSTAGRAM_DIRECT" } as const;

export function buildCampaignBody(spec: AdDraftSpec, tag: string): Record<string, unknown> {
  return {
    name: `${spec.name}${tag}`,
    objective: "OUTCOME_ENGAGEMENT",
    special_ad_categories: [],
    buying_type: "AUCTION",
    status: "PAUSED",
  };
}

export function buildAdsetBody(
  spec: AdDraftSpec,
  ctx: {
    campaignId: string;
    pageId: string;
    whatsappNumber: string | null;
    /** The ad account's currency and checked budget unit; the budget is converted by budgetToMetaUnits and nowhere else. */
    account: { currency: string; budgetFactor: number | null };
    shop: { lat: number; lng: number } | null;
  },
  tag: string,
): Record<string, unknown> {
  let geo: Record<string, unknown>;
  if (spec.audience.area === "near_shop") {
    if (!ctx.shop || spec.audience.radius_km == null) throw new AdsManageError("invalid", "The shop's position is not set up, so 'People near the shop' cannot be used.");
    geo = {
      custom_locations: [
        { latitude: ctx.shop.lat, longitude: ctx.shop.lng, radius: spec.audience.radius_km, distance_unit: "kilometer" },
      ],
    };
  } else {
    geo = { countries: ["NG"] };
  }
  const promoted: Record<string, unknown> = { page_id: ctx.pageId };
  if (spec.destination === "whatsapp") {
    if (!ctx.whatsappNumber) throw new AdsManageError("invalid", "This WhatsApp line has no phone number.");
    promoted.whatsapp_phone_number = ctx.whatsappNumber.replace(/\D/g, "");
  }
  return {
    name: `${spec.name}${tag}`,
    campaign_id: ctx.campaignId,
    destination_type: DESTINATION_TYPE[spec.destination],
    optimization_goal: "CONVERSATIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    daily_budget: budgetToMetaUnits(spec.daily_budget, ctx.account),
    start_time: new Date(spec.start_at).toISOString(),
    end_time: new Date(spec.end_at).toISOString(),
    promoted_object: promoted,
    targeting: { geo_locations: geo, age_min: spec.audience.age_min, age_max: spec.audience.age_max },
    status: "PAUSED",
  };
}

export const DEFAULT_PREFILLED_MESSAGE = "Hello! Can I get more info on this?";

/** OPT_OUT so Meta does not alter the picture or text the owner approved. If Meta refuses it (C10), we stop; we never switch to OPT_IN. */
const NO_ENHANCEMENTS = { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } };

export function buildCreativeBody(
  spec: AdDraftSpec,
  ctx: { pageId: string; instagramAccountId: string | null; imageHash: string },
  tag: string,
): Record<string, unknown> {
  const name = `${spec.name}${tag}`;
  if (spec.destination === "whatsapp") {
    const welcome = JSON.stringify({
      type: "VISUAL_EDITOR",
      version: 2,
      landing_screen_type: "welcome_message",
      media_type: "text",
      text_format: {
        customer_action_type: "autofill_message",
        message: {
          autofill_message: { content: spec.prefilled_message ?? DEFAULT_PREFILLED_MESSAGE },
          text: spec.greeting,
        },
      },
    });
    return {
      name,
      object_story_spec: {
        page_id: ctx.pageId,
        link_data: {
          link: "https://api.whatsapp.com/send",
          name: spec.headline,
          message: spec.primary_text,
          ...(spec.description ? { description: spec.description } : {}),
          image_hash: ctx.imageHash,
          call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } },
          page_welcome_message: welcome,
        },
      },
      degrees_of_freedom_spec: NO_ENHANCEMENTS,
    };
  }
  if (spec.destination === "messenger") {
    return {
      name,
      object_story_spec: {
        page_id: ctx.pageId,
        link_data: {
          // The link value for Messenger is [unverified] (C11).
          link: `https://m.me/${ctx.pageId}`,
          name: spec.headline,
          message: spec.primary_text,
          ...(spec.description ? { description: spec.description } : {}),
          image_hash: ctx.imageHash,
          call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } },
          page_welcome_message: spec.greeting,
        },
      },
      degrees_of_freedom_spec: NO_ENHANCEMENTS,
    };
  }
  if (!ctx.instagramAccountId) throw new AdsManageError("invalid", "This Instagram account is not connected.");
  return {
    name,
    object_story_spec: {
      page_id: ctx.pageId,
      // instagram_actor_id or instagram_user_id is [unverified] (C12).
      instagram_actor_id: ctx.instagramAccountId,
      link_data: {
        message: spec.primary_text,
        name: spec.headline,
        image_hash: ctx.imageHash,
        call_to_action: { type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } },
        page_welcome_message: spec.greeting,
      },
    },
    degrees_of_freedom_spec: NO_ENHANCEMENTS,
  };
}

export function buildAdBody(spec: AdDraftSpec, ctx: { adsetId: string; creativeId: string }, tag: string): Record<string, unknown> {
  return { name: `${spec.name}${tag}`, adset_id: ctx.adsetId, creative: { creative_id: ctx.creativeId }, status: "PAUSED" };
}

/** sha256 of the draft with its keys in a fixed order: what was confirmed is what is sent. */
export function draftFingerprint(spec: AdDraftSpec): string {
  const ordered = {
    destination: spec.destination,
    account_id: spec.account_id,
    name: spec.name,
    headline: spec.headline,
    primary_text: spec.primary_text,
    description: spec.description,
    image_key: spec.image_key,
    greeting: spec.greeting,
    prefilled_message: spec.prefilled_message,
    audience: {
      area: spec.audience.area,
      radius_km: spec.audience.radius_km,
      age_min: spec.audience.age_min,
      age_max: spec.audience.age_max,
    },
    daily_budget: spec.daily_budget,
    start_at: spec.start_at,
    end_at: spec.end_at,
    special_category: spec.special_category,
  };
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export interface DraftTargets {
  accountLabel: string;
  pageId: string;
  whatsappNumber: string | null;
  instagramAccountId: string | null;
}

/** The Page, number or Instagram account an advert opens a chat with. */
export async function resolveDraftTargets(db: DbExecutor, spec: AdDraftSpec): Promise<DraftTargets> {
  const [row] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, spec.account_id));
  const wantKind = spec.destination === "whatsapp" ? "phone" : spec.destination;
  if (!row || !row.isActive || row.kind !== wantKind) {
    throw new AdsManageError("invalid", "Choose a channel that is connected and switched on.");
  }
  if (spec.destination === "whatsapp") {
    if (!row.e164 || !row.wabaId) throw new AdsManageError("invalid", "This line is not a WhatsApp number.");
    // A WhatsApp advert is published by the Facebook Page linked to the number. With exactly one Page connected there is no doubt which.
    const pages = (await listChannelAccounts(db, "messenger")).filter((p) => p.isActive && p.externalId);
    if (pages.length !== 1) {
      throw new AdsManageError(
        "invalid",
        pages.length === 0
          ? "Connect the Facebook Page under Channels first. A WhatsApp advert is published by the Page linked to the number."
          : "More than one Facebook Page is connected, so the suite cannot tell which one publishes this advert. Create it in Meta Ads Manager.",
      );
    }
    return { accountLabel: row.label, pageId: pages[0]!.externalId!, whatsappNumber: row.e164, instagramAccountId: null };
  }
  if (spec.destination === "messenger") {
    if (!row.externalId) throw new AdsManageError("invalid", "This Page is not connected.");
    return { accountLabel: row.label, pageId: row.externalId, whatsappNumber: null, instagramAccountId: null };
  }
  if (!row.externalId || !row.pageExternalId) throw new AdsManageError("invalid", "This Instagram account is not connected.");
  return { accountLabel: row.label, pageId: row.pageExternalId, whatsappNumber: null, instagramAccountId: row.externalId };
}

export function parseDraftSpec(raw: unknown): AdDraftSpec {
  const parsed = adDraftSpecSchema.safeParse(raw);
  if (!parsed.success) throw new AdsManageError("invalid", "This advert is not complete. Open it and check each field.");
  return parsed.data;
}

/** Everything the summary dialog shows. Makes no change anywhere; reads Meta only for the cap line. */
export async function previewDraft(
  db: DbClient,
  cfg: MetaConfig,
  draft: AdDraftRow,
  now: Date = new Date(),
): Promise<{
  lines: string[];
  maxSpend: number;
  confirmText: string;
  contentHash: string;
  cap: CapResult;
  minDaily: number | null;
  problems: string[];
}> {
  const { link, settings } = await assertCanManage(db);
  const spec = parseDraftSpec(draft.spec);
  const targets = await resolveDraftTargets(db, spec);
  const summary = buildAdSummary(spec, {
    accountLabel: targets.accountLabel,
    adAccountName: link.name,
    currency: link.currency,
    shopName: ADS_SHOP_NAME,
  });
  const cap = await checkCap(cfg, link, settings, { requestedDaily: spec.daily_budget, now });
  return {
    ...summary,
    contentHash: draftFingerprint(spec),
    cap,
    minDaily: minDailyNaira(link),
    problems: draftProblems(spec, now),
  };
}

/**
 * The cap and Meta's minimum for a draft's budget, checked with no call to
 * Meta at all. A budget over the cap is logged as blocked and refused. Returns
 * the budget in Meta's unit.
 */
export async function assertDraftBudgetAllowed(
  db: DbClient,
  link: AdAccountLinkRow,
  settings: AdsSettingsValue,
  spec: AdDraftSpec,
  actor: PersonActor,
): Promise<number> {
  const alone = evaluateCap({ cap: settings.daily_cap, othersActiveDaily: [], requestedDaily: spec.daily_budget });
  if (!alone.ok) throw await blockedByCap(db, link, actor, "create_advert", "draft", null, alone);
  const budgetUnits = unitsFor(spec.daily_budget, link);
  const minDaily = minDailyNaira(link);
  if (minDaily !== null && spec.daily_budget < minDaily) {
    throw new AdsManageError("below_minimum", `Meta's minimum for this account is ${money(minDaily, "NGN")} a day.`);
  }
  return budgetUnits;
}

const TAG_EDGES = { campaign: "campaigns", adset: "adsets", ad: "ads", creative: "adcreatives" } as const;

/** Look for an object the suite may already have created, by the name tag of its draft. Read-only. */
async function findByTag(cfg: MetaConfig, act: string, level: keyof typeof TAG_EDGES, tag: string): Promise<string | null> {
  let path: string | null = `${act}/${TAG_EDGES[level]}?fields=id,name&limit=100`;
  const base = `${cfg.baseUrl ?? "https://graph.facebook.com"}/`;
  for (let page = 0; page < 20 && path; page++) {
    const res: { data?: { id?: unknown; name?: unknown }[]; paging?: { next?: string } } = await adsGraph(cfg, "GET", path);
    const hit = (res?.data ?? []).find((o) => typeof o.name === "string" && o.name.endsWith(tag));
    if (hit?.id != null) return String(hit.id);
    const next: string | undefined = res?.paging?.next;
    path = typeof next === "string" && next.startsWith(base) ? next : null;
  }
  return null;
}

export interface CreateAdDeps {
  /** The picture's bytes from our own storage (apps/api/src/lib/r2.ts). */
  loadImage: (key: string) => Promise<Uint8Array>;
  /** The shop's position (env ADS_SHOP_LAT / ADS_SHOP_LNG), or null. */
  shop: { lat: number; lng: number } | null;
  now?: Date;
}

const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Create the campaign, ad set, creative and ad for a confirmed draft, all
 * switched off. `mode` "continue" resumes a failed or unconfirmed run without
 * repeating a finished step. Returns the draft row: status 'created',
 * 'failed' (with the reason) or 'needs_check' (Meta did not answer).
 */
export async function createAdFromDraft(
  db: DbClient,
  cfg: MetaConfig,
  draftId: string,
  actor: PersonActor,
  deps: CreateAdDeps,
  mode: "create" | "continue" = "create",
): Promise<AdDraftRow> {
  const now = deps.now ?? new Date();
  await assertActorMayManage(db, actor);
  const { link, settings } = await assertCanManage(db);
  const [found] = await db.select().from(adDraft).where(eq(adDraft.id, draftId));
  if (!found) throw new AdsManageError("not_found", "This advert draft no longer exists.");
  const spec = parseDraftSpec(found.spec);
  const fingerprint = draftFingerprint(spec);
  if (!found.confirmedHash || !found.confirmedBy || found.confirmedHash !== fingerprint) {
    throw new AdsManageError("not_confirmed", "This advert changed while you were looking at it. Check it again.");
  }
  if (!ENABLED_DESTINATIONS.includes(spec.destination)) {
    throw new AdsManageError("invalid", "The suite can only create adverts that open a WhatsApp chat for now. Create this one in Meta Ads Manager.");
  }
  // On a first run every date rule applies; when resuming, only that it has not already ended.
  const problems = mode === "create" && !found.adsetExternalId ? draftProblems(spec, now) : [];
  if (problems.length) throw new AdsManageError("invalid", problems[0]!);
  if (new Date(spec.end_at).getTime() <= now.getTime()) throw new AdsManageError("ended", "This advert's end date has passed. Create a new one.");

  // The cap, before anything is sent: an advert that could never be turned on is not created.
  const budgetUnits = await assertDraftBudgetAllowed(db, link, settings, spec, actor);
  const targets = await resolveDraftTargets(db, spec);
  const tag = nameTag(found.id);
  const act = link.adAccountId;

  // Claim the draft. A second identical request finds nothing to claim.
  const claimable =
    mode === "create"
      ? inArray(adDraft.status, ["draft", "failed"])
      : or(
          inArray(adDraft.status, ["failed", "needs_check"]),
          and(eq(adDraft.status, "creating"), lt(adDraft.lockedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
        );
  const [claimed] = await db
    .update(adDraft)
    .set({ status: "creating", lockedAt: new Date(), errorCode: null, errorMessage: null, updatedAt: new Date() })
    .where(and(eq(adDraft.id, draftId), claimable, eq(adDraft.confirmedHash, fingerprint)))
    .returning();
  if (!claimed) throw new AdsManageError("in_progress", ADS_IN_PROGRESS);
  // After a run with no answer (or one that stopped half-way), look before creating again.
  let lookFirst = found.status === "needs_check" || found.status === "creating";
  let d = claimed;
  const save = async (set: Partial<typeof adDraft.$inferInsert>): Promise<void> => {
    const [row] = await db.update(adDraft).set({ ...set, updatedAt: new Date() }).where(eq(adDraft.id, draftId)).returning();
    if (row) d = row;
  };
  const summary = buildAdSummary(spec, { accountLabel: targets.accountLabel, adAccountName: link.name, currency: link.currency, shopName: ADS_SHOP_NAME });
  const maxSpendUnits = summary.maxSpend * (link.budgetFactor ?? 1);
  const create = async (
    action: WriteAction,
    level: MetaWrite["level"],
    path: string,
    body: Record<string, unknown>,
    what: string,
  ): Promise<Record<string, unknown>> =>
    metaWrite<Record<string, unknown>>(db, cfg, {
      actor,
      action,
      link,
      level,
      externalId: null,
      path,
      body,
      summary: `${what} for the advert "${spec.name}", switched off. The most the advert can spend: ${money(summary.maxSpend, "NGN")}.`,
      maxSpendUnits,
      confirmText: summary.confirmText,
    });
  const idOf = (res: Record<string, unknown>): string => {
    if (res?.id == null || String(res.id) === "") throw new MetaApiError("Meta did not return an ID", 200, null, false, "unknown");
    return String(res.id);
  };
  /** One step: skip if its ID is saved; after an unanswered run, adopt what Meta already holds; else create. */
  const step = async (
    saved: string | null,
    level: "campaign" | "adset" | "creative" | "ad",
    make: () => Promise<string>,
  ): Promise<string> => {
    if (saved) return saved;
    if (lookFirst) {
      lookFirst = false;
      const existing = await findByTag(cfg, act, level, tag);
      if (existing) return existing;
    }
    return make();
  };

  try {
    setAdsUsageAccount(act);
    // image
    if (!d.imageHash) {
      lookFirst = false; // an upload of the same picture gives the same hash and costs nothing
      await save({ step: "image" });
      const bytes = await deps.loadImage(spec.image_key);
      const res = await metaWrite<{ images?: Record<string, { hash?: string }> }>(db, cfg, {
        actor,
        action: "upload_image",
        link,
        level: "image",
        externalId: null,
        path: `${act}/adimages`,
        body: { bytes: Buffer.from(bytes).toString("base64") },
        summary: `Uploaded the picture for the advert "${spec.name}".`,
      });
      const hash = Object.values(res?.images ?? {})[0]?.hash;
      if (!hash) throw new MetaApiError("Meta did not return the picture's code", 200, null, false, "not_sent");
      await save({ imageHash: hash, step: "campaign" });
    }
    // campaign
    const campaignId = await step(d.campaignExternalId, "campaign", async () =>
      idOf(await create("create_campaign", "campaign", `${act}/campaigns`, buildCampaignBody(spec, tag), "Created the campaign")),
    );
    await save({ campaignExternalId: campaignId, step: "adset" });
    // ad set (the only object that carries a budget)
    const adsetId = await step(d.adsetExternalId, "adset", async () =>
      idOf(
        await create(
          "create_adset",
          "adset",
          `${act}/adsets`,
          buildAdsetBody(spec, { campaignId, pageId: targets.pageId, whatsappNumber: targets.whatsappNumber, account: account(link), shop: deps.shop }, tag),
          `Created the ad set with a budget of ${money(spec.daily_budget, "NGN")} a day`,
        ),
      ),
    );
    await save({ adsetExternalId: adsetId, step: "creative" });
    // creative
    const creativeId = await step(d.creativeExternalId, "creative", async () =>
      idOf(
        await create(
          "create_creative",
          "creative",
          `${act}/adcreatives`,
          buildCreativeBody(spec, { pageId: targets.pageId, instagramAccountId: targets.instagramAccountId, imageHash: d.imageHash! }, tag),
          "Created the picture and text",
        ),
      ),
    );
    await save({ creativeExternalId: creativeId, step: "ad" });
    // ad
    const adId = await step(d.adExternalId, "ad", async () =>
      idOf(await create("create_ad", "ad", `${act}/ads`, buildAdBody(spec, { adsetId, creativeId }, tag), "Created the advert")),
    );
    await save({ adExternalId: adId, step: "verify" });

    // verify: read back what Meta saved. Anything but our budget, switched off, blocks the advert.
    const [camp, aset, ad] = await Promise.all([
      adsGraph<Record<string, unknown>>(cfg, "GET", `${campaignId}?fields=id,name,status,effective_status,objective`),
      adsGraph<Record<string, unknown>>(
        cfg,
        "GET",
        `${adsetId}?fields=id,name,campaign_id,status,effective_status,destination_type,daily_budget,lifetime_budget,start_time,end_time`,
      ),
      adsGraph<Record<string, unknown>>(cfg, "GET", `${adId}?fields=id,name,adset_id,campaign_id,status,effective_status`),
    ]);
    const allOff = camp?.status === "PAUSED" && aset?.status === "PAUSED" && ad?.status === "PAUSED";
    if (intOf(aset?.daily_budget) !== budgetUnits || !allOff) {
      if (!allOff) {
        // Something is not switched off. Pausing can only reduce spending, so do it now.
        await pauseAtMeta(db, cfg, link, "campaign", campaignId, actor, `Paused "${spec.name}": Meta did not save it switched off.`).catch(() => undefined);
      }
      await save({ status: "failed", errorCode: "mismatch", errorMessage: ADS_VERIFY_MISMATCH, lockedAt: null });
      return d;
    }
    await upsertAdObjects(db, act, "campaign", [camp], now);
    await upsertAdObjects(db, act, "adset", [aset], now);
    await upsertAdObjects(db, act, "ad", [{ ...ad, creative: { title: spec.headline, body: spec.primary_text } }], now);
    await db
      .update(adCampaignCache)
      .set({ createdBySuite: true })
      .where(
        or(
          and(eq(adCampaignCache.level, "campaign"), eq(adCampaignCache.externalId, campaignId)),
          and(eq(adCampaignCache.level, "adset"), eq(adCampaignCache.externalId, adsetId)),
          and(eq(adCampaignCache.level, "ad"), eq(adCampaignCache.externalId, adId)),
        ),
      );
    await save({ status: "created", step: "done", lockedAt: null, errorCode: null, errorMessage: null });
    return d;
  } catch (err) {
    if (err instanceof AdWriteForbiddenError) {
      await save({ status: "failed", errorCode: "forbidden", errorMessage: "The suite stopped this advert because it did not pass its own safety rules.", lockedAt: null });
      throw err;
    }
    if (err instanceof AdsManageError) {
      await save({ status: "failed", errorCode: err.code, errorMessage: err.staffMessage, lockedAt: null });
      return d;
    }
    if (!(err instanceof MetaApiError)) {
      // Our own failure part-way: Meta may hold something we did not record, so look before creating again.
      await save({
        status: "needs_check",
        errorCode: "interrupted",
        errorMessage: "The suite was interrupted. Nothing can have been spent, because adverts are created switched off. Press Continue and we will check what was created.",
        lockedAt: null,
      });
      throw err;
    }
    const cls = classifyAdsError(err);
    const code = adsMetaCode(err);
    if (cls === "unknown") {
      await save({
        status: "needs_check",
        errorCode: code ?? "no_answer",
        errorMessage: "Meta did not answer. Nothing can have been spent, because adverts are created switched off. Press Continue and we will check what was created.",
        lockedAt: null,
      });
    } else if (cls === "temporary") {
      await save({ status: "failed", errorCode: code ?? "busy", errorMessage: "Meta is busy. Press Continue in a few minutes.", lockedAt: null });
    } else {
      await save({ status: "failed", errorCode: code ?? "refused", errorMessage: `Meta refused this step: ${err.message}`.slice(0, 1000), lockedAt: null });
    }
    return d;
  }
}

// ── Turning on, pausing, changing a budget (section 5.12) ────────────────────

async function linkedAccount(db: DbExecutor): Promise<AdAccountLinkRow> {
  const link = await getActiveAdLink(db);
  if (!link) throw new AdsManageError("no_account", "No ad account is linked yet. The owner can link one in Ads → Settings.");
  return link;
}

/** One POST { status: "PAUSED" } with its log pair; a missing answer is settled by one read. */
async function pauseAtMeta(
  db: DbClient,
  cfg: MetaConfig,
  link: AdAccountLinkRow,
  level: "campaign" | "adset" | "ad",
  externalId: string,
  actor: PauseActor,
  summary: string,
): Promise<void> {
  try {
    await metaWrite(db, cfg, { actor, action: "pause", link, level, externalId, path: externalId, body: { status: "PAUSED" }, summary });
  } catch (err) {
    if (!(err instanceof MetaApiError) || classifyAdsError(err) !== "unknown") throw err;
    const seen = await adsGraph<{ status?: string }>(cfg, "GET", `${externalId}?fields=status`).catch(() => null);
    if (seen?.status !== "PAUSED") throw err;
  }
  // Keep our own list honest until the next sync: the object is off, and so is everything under a paused campaign.
  await db
    .update(adCampaignCache)
    .set({ status: "PAUSED", effectiveStatus: "PAUSED", syncedAt: new Date() })
    .where(and(eq(adCampaignCache.level, level), eq(adCampaignCache.externalId, externalId)));
  if (level === "campaign") {
    await db
      .update(adCampaignCache)
      .set({ effectiveStatus: "CAMPAIGN_PAUSED", syncedAt: new Date() })
      .where(
        and(
          inArray(adCampaignCache.level, ["adset", "ad"]),
          eq(adCampaignCache.campaignExternalId, externalId),
          inArray(adCampaignCache.effectiveStatus, ["ACTIVE", "PENDING_REVIEW", "IN_PROCESS"]),
        ),
      );
  }
}

/**
 * Pause a campaign, ad set or ad of the linked account, suite-made or not.
 * Never blocked by the cap, and never by the master switch being off: pausing
 * must always be possible. A person needs ads.manage.
 */
export async function pauseObject(
  db: DbClient,
  cfg: MetaConfig,
  level: "campaign" | "adset" | "ad",
  externalId: string,
  actor: PauseActor,
  reason: string,
): Promise<void> {
  if (actor.kind === "person") await assertActorMayManage(db, actor);
  const link = await linkedAccount(db);
  if (!/^\d{3,32}$/.test(externalId)) throw new AdsManageError("not_found", "That advert was not found in the linked ad account.");
  const [cached] = await db
    .select({ id: adCampaignCache.id })
    .from(adCampaignCache)
    .where(and(eq(adCampaignCache.level, level), eq(adCampaignCache.externalId, externalId), eq(adCampaignCache.adAccountId, link.adAccountId)));
  if (!cached) {
    // Not in our list yet: ask Meta whose it is before touching it.
    setAdsUsageAccount(link.adAccountId);
    const seen = await adsGraph<{ account_id?: unknown }>(cfg, "GET", `${externalId}?fields=account_id`).catch(() => null);
    if (!seen || `act_${String(seen.account_id ?? "")}` !== link.adAccountId) {
      throw new AdsManageError("not_found", "That advert was not found in the linked ad account.");
    }
  }
  await pauseAtMeta(db, cfg, link, level, externalId, actor, reason);
}

interface SuiteAdvert {
  link: AdAccountLinkRow;
  settings: AdsSettingsValue;
  draft: AdDraftRow;
  campaign: typeof adCampaignCache.$inferSelect;
  adsetId: string;
  adId: string;
}

/** A campaign the suite created AND verified. Anything else cannot be turned on or re-budgeted from the suite. */
async function suiteAdvert(db: DbExecutor, by: { campaignExternalId: string } | { adsetExternalId: string }): Promise<SuiteAdvert> {
  const { link, settings } = await assertCanManage(db);
  const notMade = () => new AdsManageError("not_suite_made", "This advert was not made in the suite. Turn it on in Meta Ads Manager.");
  const [draft] = await db
    .select()
    .from(adDraft)
    .where(
      and(
        eq(adDraft.status, "created"),
        "campaignExternalId" in by ? eq(adDraft.campaignExternalId, by.campaignExternalId) : eq(adDraft.adsetExternalId, by.adsetExternalId),
      ),
    );
  if (!draft?.campaignExternalId || !draft.adsetExternalId || !draft.adExternalId) throw notMade();
  const rows = await db
    .select()
    .from(adCampaignCache)
    .where(
      and(
        eq(adCampaignCache.adAccountId, link.adAccountId),
        eq(adCampaignCache.createdBySuite, true),
        isNull(adCampaignCache.goneAt),
        or(
          and(eq(adCampaignCache.level, "campaign"), eq(adCampaignCache.externalId, draft.campaignExternalId)),
          and(eq(adCampaignCache.level, "adset"), eq(adCampaignCache.externalId, draft.adsetExternalId)),
          and(eq(adCampaignCache.level, "ad"), eq(adCampaignCache.externalId, draft.adExternalId)),
        ),
      ),
    );
  const campaign = rows.find((r) => r.level === "campaign");
  if (!campaign || rows.length !== 3) throw notMade();
  return { link, settings, draft, campaign, adsetId: draft.adsetExternalId, adId: draft.adExternalId };
}

interface FreshAdset {
  dailyNaira: number;
  status: string;
  end: Date;
  campaignStatus: string;
}

/** The ad set and its campaign as Meta holds them right now. */
async function readAdsetFresh(cfg: MetaConfig, a: SuiteAdvert): Promise<FreshAdset> {
  let aset: Record<string, unknown>;
  let camp: Record<string, unknown>;
  try {
    setAdsUsageAccount(a.link.adAccountId);
    aset = await adsGraph(cfg, "GET", `${a.adsetId}?fields=daily_budget,status,end_time,campaign_id`);
    camp = await adsGraph(cfg, "GET", `${a.campaign.externalId}?fields=status`);
  } catch {
    throw new AdsManageError("cap_unknown", ADS_CAP_UNKNOWN);
  }
  const units = intOf(aset?.daily_budget);
  const f = a.link.budgetFactor === 100 ? 100 : 1;
  const end = dateOf(aset?.end_time);
  // A budget that is not a whole number of naira, or no end date, was not set by the suite: refuse rather than round.
  if (units === null || units <= 0 || units % f !== 0 || !end || String(aset?.campaign_id ?? "") !== a.campaign.externalId) {
    throw new AdsManageError("mismatch", "Meta shows a budget or dates for this advert that the suite did not set. Check it in Meta Ads Manager.");
  }
  return { dailyNaira: units / f, status: String(aset.status ?? ""), end, campaignStatus: String(camp?.status ?? "") };
}

/** Claim the advert for one action so a double click cannot run it twice. Released by time (30 seconds, A7). */
async function claimAdvert(db: DbExecutor, draftId: string): Promise<void> {
  const [row] = await db
    .update(adDraft)
    .set({ lockedAt: new Date() })
    .where(and(eq(adDraft.id, draftId), or(isNull(adDraft.lockedAt), lt(adDraft.lockedAt, new Date(Date.now() - 30_000)))))
    .returning({ id: adDraft.id });
  if (!row) throw new AdsManageError("in_progress", ADS_IN_PROGRESS);
}

export interface TurnOnPreview {
  name: string;
  daily: number;
  end_time: string;
  remaining_max: number;
  confirm_text: string;
  cap: CapResult;
}

/** What the "Turn on" dialog shows, from a fresh read of Meta. Changes nothing. */
export async function turnOnPreview(db: DbClient, cfg: MetaConfig, campaignExternalId: string, now: Date = new Date()): Promise<TurnOnPreview> {
  const a = await suiteAdvert(db, { campaignExternalId });
  const fresh = await readAdsetFresh(cfg, a);
  if (fresh.end.getTime() <= now.getTime()) throw new AdsManageError("ended", "This advert's end date has passed. Create a new one.");
  const cap = await checkCap(cfg, a.link, a.settings, { requestedDaily: fresh.dailyNaira, excludeAdsetExternalId: a.adsetId, now });
  const remaining = remainingMaxSpend(fresh.dailyNaira, now, fresh.end);
  return {
    name: a.campaign.name ?? "",
    daily: fresh.dailyNaira,
    end_time: fresh.end.toISOString(),
    remaining_max: remaining,
    confirm_text: confirmTextFor(remaining),
    cap,
  };
}

/**
 * Turn on an advert the suite made. The person's typed total is checked here
 * against the remaining maximum worked out from a fresh read of Meta; the cap
 * is checked from the same fresh read; then the ad, the ad set and LAST the
 * campaign are switched on (nothing can deliver until the campaign is on).
 */
export async function turnOnAdvert(
  db: DbClient,
  cfg: MetaConfig,
  campaignExternalId: string,
  actor: PersonActor,
  opts: { typed: string; now?: Date },
): Promise<void> {
  const now = opts.now ?? new Date();
  await assertActorMayManage(db, actor);
  const a = await suiteAdvert(db, { campaignExternalId });
  const fresh = await readAdsetFresh(cfg, a);
  if (fresh.end.getTime() <= now.getTime()) throw new AdsManageError("ended", "This advert's end date has passed. Create a new one.");
  const remaining = remainingMaxSpend(fresh.dailyNaira, now, fresh.end);
  const confirmText = confirmTextFor(remaining);
  if (normaliseTyped(opts.typed) !== confirmText) throw new AdsManageError("wrong_total", "Type the total exactly as shown to confirm.");
  const cap = await checkCap(cfg, a.link, a.settings, { requestedDaily: fresh.dailyNaira, excludeAdsetExternalId: a.adsetId, now });
  if (!cap.ok) throw await blockedByCap(db, a.link, actor, "turn_on", "campaign", campaignExternalId, cap);
  await claimAdvert(db, a.draft.id);

  const name = a.campaign.name ?? "advert";
  const summary = `Turned on "${name}": up to ${money(fresh.dailyNaira, "NGN")} a day until ${lagosDateTime(fresh.end)}, ${money(remaining, "NGN")} in total.`;
  const on = (level: "ad" | "adset" | "campaign", externalId: string) =>
    metaWrite(db, cfg, {
      actor,
      action: "turn_on",
      link: a.link,
      level,
      externalId,
      path: externalId,
      body: { status: "ACTIVE" },
      summary,
      maxSpendUnits: remaining * (a.link.budgetFactor ?? 1),
      confirmText,
    });
  try {
    await on("ad", a.adId);
    await on("adset", a.adsetId);
    await on("campaign", campaignExternalId);
  } catch (err) {
    if (!(err instanceof MetaApiError) || classifyAdsError(err) !== "unknown") throw err;
    // Setting ACTIVE twice is harmless, but we do not re-send: one read tells us where it stands.
    const seen = await adsGraph<{ status?: string }>(cfg, "GET", `${campaignExternalId}?fields=status`).catch(() => null);
    if (seen?.status !== "ACTIVE") {
      throw new AdsManageError("not_confirmed_by_meta", "Meta did not confirm. The advert is still off. Try again.");
    }
  }
  // Our own list, until the next sync reads Meta's: switched on, and the advert itself waiting for Meta's check (R8).
  await db
    .update(adCampaignCache)
    .set({ status: "ACTIVE", effectiveStatus: "ACTIVE", syncedAt: new Date() })
    .where(
      or(
        and(eq(adCampaignCache.level, "campaign"), eq(adCampaignCache.externalId, campaignExternalId)),
        and(eq(adCampaignCache.level, "adset"), eq(adCampaignCache.externalId, a.adsetId)),
      ),
    );
  await db
    .update(adCampaignCache)
    .set({ status: "ACTIVE", effectiveStatus: "PENDING_REVIEW", syncedAt: new Date() })
    .where(and(eq(adCampaignCache.level, "ad"), eq(adCampaignCache.externalId, a.adId)));
}

export interface BudgetPreview {
  name: string;
  current_daily: number;
  new_daily: number;
  end_time: string;
  remaining_max: number;
  confirm_text: string;
  live: boolean;
  cap: CapResult;
  min_daily: number | null;
}

async function budgetPlan(db: DbClient, cfg: MetaConfig, adsetExternalId: string, newDaily: number, now: Date) {
  const a = await suiteAdvert(db, { adsetExternalId });
  if (!Number.isSafeInteger(newDaily) || newDaily < 1) throw new AdsManageError("invalid", "A daily budget must be a whole number of naira, at least ₦1.");
  const minDaily = minDailyNaira(a.link);
  if (minDaily !== null && newDaily < minDaily) {
    throw new AdsManageError("below_minimum", `Meta's minimum for this account is ${money(minDaily, "NGN")} a day.`);
  }
  const fresh = await readAdsetFresh(cfg, a);
  if (fresh.end.getTime() <= now.getTime()) throw new AdsManageError("ended", "This advert's end date has passed. Create a new one.");
  const live = fresh.status === "ACTIVE" && fresh.campaignStatus === "ACTIVE";
  // Live: everything else that is live, plus this. Not live: it must at least fit under the cap alone.
  const cap = live
    ? await checkCap(cfg, a.link, a.settings, { requestedDaily: newDaily, excludeAdsetExternalId: a.adsetId, now })
    : evaluateCap({ cap: a.settings.daily_cap, othersActiveDaily: [], requestedDaily: newDaily });
  const remaining = remainingMaxSpend(newDaily, now, fresh.end);
  return { a, fresh, live, cap, remaining, minDaily };
}

export async function budgetPreview(db: DbClient, cfg: MetaConfig, adsetExternalId: string, newDaily: number, now: Date = new Date()): Promise<BudgetPreview> {
  const p = await budgetPlan(db, cfg, adsetExternalId, newDaily, now);
  return {
    name: p.a.campaign.name ?? "",
    current_daily: p.fresh.dailyNaira,
    new_daily: newDaily,
    end_time: p.fresh.end.toISOString(),
    remaining_max: p.remaining,
    confirm_text: confirmTextFor(p.remaining),
    live: p.live,
    cap: p.cap,
    min_daily: p.minDaily,
  };
}

/** Change the daily budget of an ad set the suite made. Returns the budget before and after, in whole naira. */
export async function changeDailyBudget(
  db: DbClient,
  cfg: MetaConfig,
  adsetExternalId: string,
  newDaily: number,
  actor: PersonActor,
  opts: { typed: string; now?: Date },
): Promise<{ before: number; after: number }> {
  const now = opts.now ?? new Date();
  await assertActorMayManage(db, actor);
  const { a, fresh, cap, remaining } = await budgetPlan(db, cfg, adsetExternalId, newDaily, now);
  const confirmText = confirmTextFor(remaining);
  if (normaliseTyped(opts.typed) !== confirmText) throw new AdsManageError("wrong_total", "Type the total exactly as shown to confirm.");
  if (!cap.ok) throw await blockedByCap(db, a.link, actor, "budget_change", "adset", adsetExternalId, cap);
  // Meta allows 4 budget changes an hour per ad set (A7). Counted from the log: only requests that went to Meta.
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adActionLog)
    .where(
      and(
        eq(adActionLog.phase, "requested"),
        eq(adActionLog.action, "budget_change"),
        eq(adActionLog.objectExternalId, adsetExternalId),
        gt(adActionLog.at, new Date(Date.now() - 3600_000)),
        sql`${adActionLog.request} ? 'path'`,
      ),
    );
  if ((recent?.n ?? 0) >= 4) throw new AdsManageError("too_many_changes", "Meta allows a budget to change 4 times an hour. Try again later.");
  await claimAdvert(db, a.draft.id);

  const units = unitsFor(newDaily, a.link);
  let unanswered = false;
  try {
    await metaWrite(db, cfg, {
      actor,
      action: "budget_change",
      link: a.link,
      level: "adset",
      externalId: adsetExternalId,
      path: adsetExternalId,
      body: { daily_budget: units },
      summary: `Changed the daily budget of "${a.campaign.name ?? "advert"}" from ${money(fresh.dailyNaira, "NGN")} to ${money(newDaily, "NGN")}: ${money(remaining, "NGN")} at most from now until it ends.`,
      maxSpendUnits: remaining * (a.link.budgetFactor ?? 1),
      confirmText,
    });
  } catch (err) {
    if (!(err instanceof MetaApiError) || classifyAdsError(err) !== "unknown") throw err;
    unanswered = true;
  }
  // Read it back once. What Meta holds must be exactly what we sent (or, after no answer, what was there before).
  const seen = await adsGraph<{ daily_budget?: unknown }>(cfg, "GET", `${adsetExternalId}?fields=daily_budget,status`).catch(() => null);
  const seenUnits = intOf(seen?.daily_budget);
  if (seenUnits === units) {
    await db
      .update(adCampaignCache)
      .set({ dailyBudgetUnits: units, syncedAt: new Date() })
      .where(and(eq(adCampaignCache.level, "adset"), eq(adCampaignCache.externalId, adsetExternalId)));
    return { before: fresh.dailyNaira, after: newDaily };
  }
  if (unanswered && seenUnits === unitsFor(fresh.dailyNaira, a.link)) {
    throw new AdsManageError("not_confirmed_by_meta", "Meta did not confirm. The budget is unchanged. Try again.");
  }
  if (seenUnits === null) {
    // The read-back itself failed: we cannot say what Meta holds. Nothing more is sent.
    throw new AdsManageError("not_confirmed_by_meta", "Meta did not confirm the new budget. Open the advert in a few minutes to check it before doing anything else.");
  }
  // Meta holds a budget nobody confirmed: stop the advert and take it out of the suite's hands.
  await pauseAtMeta(db, cfg, a.link, "campaign", a.campaign.externalId, actor, `Paused "${a.campaign.name ?? "advert"}": Meta saved a different budget than we sent.`).catch(() => undefined);
  await db
    .update(adCampaignCache)
    .set({ createdBySuite: false })
    .where(
      and(
        eq(adCampaignCache.adAccountId, a.link.adAccountId),
        or(
          eq(adCampaignCache.campaignExternalId, a.campaign.externalId),
          inArray(adCampaignCache.externalId, [a.campaign.externalId, a.adsetId, a.adId]),
        ),
      ),
    );
  throw new AdsManageError("mismatch", ADS_VERIFY_MISMATCH);
}

// ── Rules and the safety stop: these can only pause ──────────────────────────

/** Suite-made campaigns that Meta says are switched on right now. Read-only. */
async function liveSuiteCampaigns(
  db: DbExecutor,
  cfg: MetaConfig,
  link: AdAccountLinkRow,
  onlyCampaign: string | null,
): Promise<{ externalId: string; name: string }[]> {
  const rows = await db
    .select({ externalId: adCampaignCache.externalId, name: adCampaignCache.name })
    .from(adCampaignCache)
    .where(
      and(
        eq(adCampaignCache.adAccountId, link.adAccountId),
        eq(adCampaignCache.level, "campaign"),
        eq(adCampaignCache.createdBySuite, true),
        isNull(adCampaignCache.goneAt),
        ...(onlyCampaign ? [eq(adCampaignCache.externalId, onlyCampaign)] : []),
      ),
    );
  const live: { externalId: string; name: string }[] = [];
  for (const r of rows) {
    const seen = await adsGraph<{ status?: string; name?: string }>(cfg, "GET", `${r.externalId}?fields=status,name`);
    if (seen?.status === "ACTIVE") live.push({ externalId: r.externalId, name: r.name ?? seen.name ?? "advert" });
  }
  return live;
}

/**
 * Check each active rule against fresh figures and PAUSE what breaks it.
 * Runs only when the owner has both switches on. Returns how many adverts
 * were paused. Nothing here can turn an advert on or change a budget.
 */
export async function evaluateRules(db: DbClient, cfg: MetaConfig, log: AdsLog, now: Date = new Date()): Promise<number> {
  const settings = await getAdsSettings(db);
  if (settings.manage_enabled !== true || settings.rules_enabled !== true) return 0;
  const link = await getActiveAdLink(db);
  if (!link) return 0;
  setAdsUsageAccount(link.adAccountId);
  const rules = await db.select().from(adRule).where(eq(adRule.isActive, true));
  let paused = 0;
  for (const rule of rules) {
    try {
      if (rule.currency !== link.currency) {
        log.warn({ rule: rule.id }, "ads: rule skipped, its currency is not the ad account's");
        continue;
      }
      const threshold = Number(rule.threshold);
      const minSpend = Number(rule.minSpend);
      const until = dayInZone(now, link.timezoneName);
      const range = encodeURIComponent(JSON.stringify({ since: addDays(until, -(rule.lookbackDays - 1)), until }));
      for (const c of await liveSuiteCampaigns(db, cfg, link, rule.scopeCampaignExternalId)) {
        const res = await adsGraph<{ data?: { spend?: unknown; actions?: AdAction[] }[] }>(
          cfg,
          "GET",
          `${c.externalId}/insights?fields=spend,actions&time_range=${range}`,
        );
        const row = res?.data?.[0];
        const spend = Number(row?.spend ?? 0);
        if (!Number.isFinite(spend) || spend <= 0 || spend < minSpend) continue;
        const chats = summariseActions(row?.actions, undefined).conversationsStarted;
        const each = costPerConversation(spend, chats);
        if (each !== null && each <= threshold) continue;
        const n = rule.lookbackDays;
        const over = `over the last ${n} ${n === 1 ? "day" : "days"}`;
        const summary =
          each === null
            ? `Rule '${rule.name}' paused '${c.name}': ${money(spend, link.currency)} spent and no chats started ${over}.`
            : `Rule '${rule.name}' paused '${c.name}': each chat cost ${money(Math.round(each), link.currency)} ${over}, above your limit of ${money(threshold, link.currency)}.`;
        await pauseAtMeta(db, cfg, link, "campaign", c.externalId, { kind: "rule", userId: null, name: rule.name }, summary);
        paused++;
        await db.update(adRule).set({ lastFiredAt: now }).where(eq(adRule.id, rule.id));
        await writeAdLogPair(db, {
          actorKind: "rule",
          actorName: rule.name,
          action: "rule_check",
          adAccountId: link.adAccountId,
          objectLevel: "campaign",
          objectExternalId: c.externalId,
          summary,
          currency: link.currency,
          request: { rule_id: rule.id, spend, chats, threshold, lookback_days: n },
          outcome: "ok",
        });
        await raiseAdsAlert(db, "ads.rule_fired", { account: link.adAccountId, rule: rule.name, advert: c.name, summary }, null);
      }
    } catch (err) {
      // A failed read or a refused pause: say so and move on. Never anything but a pause.
      if (err instanceof AdWriteForbiddenError) throw err;
      log.warn({ rule: rule.id, err: err instanceof Error ? err.message : String(err) }, "ads: rule check failed");
    } finally {
      await db.update(adRule).set({ lastEvaluatedAt: now }).where(eq(adRule.id, rule.id));
    }
  }
  return paused;
}

/**
 * The safety stop: when today's spend has reached the owner's cap, PAUSE every
 * running advert the suite made, and tell the owner once that day. It can only
 * pause, so it runs whenever an ad account is linked and a cap above 0 is set,
 * whether or not creating adverts is still switched on.
 */
export async function safetyBrake(db: DbClient, cfg: MetaConfig, log: AdsLog, now: Date = new Date()): Promise<number> {
  const settings = await getAdsSettings(db);
  const link = await getActiveAdLink(db);
  if (!link || !(settings.daily_cap > 0)) return 0;
  const [anySuiteMade] = await db
    .select({ id: adCampaignCache.id })
    .from(adCampaignCache)
    .where(and(eq(adCampaignCache.adAccountId, link.adAccountId), eq(adCampaignCache.level, "campaign"), eq(adCampaignCache.createdBySuite, true)))
    .limit(1);
  // Nothing the suite made: nothing it may pause on its own, so no reason to ask Meta.
  if (!anySuiteMade) return 0;
  setAdsUsageAccount(link.adAccountId);
  const res = await adsGraph<{ data?: { spend?: unknown }[] }>(cfg, "GET", `${link.adAccountId}/insights?date_preset=today&fields=spend&level=account`);
  const spend = Number(res?.data?.[0]?.spend ?? 0);
  if (!Number.isFinite(spend) || spend < settings.daily_cap) return 0;
  let paused = 0;
  for (const c of await liveSuiteCampaigns(db, cfg, link, null)) {
    try {
      await pauseAtMeta(
        db,
        cfg,
        link,
        "campaign",
        c.externalId,
        { kind: "safety", userId: null, name: "Safety stop" },
        `Safety stop: ${money(spend, link.currency)} spent today, at or over the cap of ${money(settings.daily_cap, link.currency)}. '${c.name}' was paused.`,
      );
      paused++;
    } catch (err) {
      if (err instanceof AdWriteForbiddenError) throw err;
      log.error({ campaign: c.externalId, err: err instanceof Error ? err.message : String(err) }, "ads: the safety stop could not pause an advert");
    }
  }
  const day = dayInZone(now, link.timezoneName);
  await raiseAdsAlert(
    db,
    "ads.safety_stop",
    { account: link.adAccountId, day, spend, cap: settings.daily_cap, currency: link.currency, paused },
    `${link.adAccountId}:${day}`,
  );
  return paused;
}
