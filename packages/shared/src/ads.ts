/**
 * Ads (suite spec 12): the pure rules shared by the server, the worker and the
 * screens. Nothing here talks to Meta or the database.
 *
 * Money. Budgets and the daily cap are WHOLE NAIRA in our database and on
 * screen. The only place a naira amount becomes the integer Meta's API takes
 * is budgetToMetaUnits() below; it refuses anything it would have to guess
 * (an ad account that is not in naira, a budget unit nobody has checked, a
 * fraction of a naira).
 */
import { z } from "zod";

export type AdDestination = "whatsapp" | "messenger" | "instagram";

/**
 * Where the suite may create adverts today. Messenger and Instagram creatives
 * are documented inconsistently by Meta (spec 12: C11, C12, Q7) and have not
 * been checked against a real ad account, so only WhatsApp is switched on.
 * The server refuses a draft for any destination not listed here, and the form
 * does not offer it. Add a destination only after a switched-off test advert
 * for it has been created successfully (work order 18).
 */
export const ENABLED_DESTINATIONS: readonly AdDestination[] = ["whatsapp"];

/** The shop's currency. Phase B only works for an ad account in this currency. */
export const SHOP_CURRENCY = "NGN";

export interface AdAction {
  action_type: string;
  value: string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function pick(list: AdAction[] | undefined, type: string): number | null {
  if (!Array.isArray(list)) return null;
  const hit = list.find((a) => a && a.action_type === type);
  return hit ? num(hit.value) : null;
}

/** Pick our counted figures out of Meta's actions lists. */
export function summariseActions(
  actions: AdAction[] | undefined,
  actionValues: AdAction[] | undefined,
): { conversationsStarted: number; firstReplies: number; metaPurchases: number; metaPurchaseValue: number } {
  // omni_purchase already includes the other purchase types: never add them together.
  const purchaseType =
    pick(actions, "omni_purchase") !== null
      ? "omni_purchase"
      : pick(actions, "onsite_conversion.purchase") !== null
        ? "onsite_conversion.purchase"
        : null;
  return {
    conversationsStarted: pick(actions, "onsite_conversion.messaging_conversation_started_7d") ?? 0,
    firstReplies: pick(actions, "onsite_conversion.messaging_first_reply") ?? 0,
    metaPurchases: purchaseType ? (pick(actions, purchaseType) ?? 0) : 0,
    metaPurchaseValue: purchaseType ? (pick(actionValues, purchaseType) ?? 0) : 0,
  };
}

export function toUnits(amount: number, factor: number): number {
  return Math.round(amount * factor);
}

export function fromUnits(units: number, factor: number): number {
  return units / factor;
}

/** Thrown by budgetToMetaUnits when a budget cannot be converted without guessing. */
export class BudgetUnitError extends Error {
  constructor(
    public readonly reason: "currency" | "not_calibrated" | "amount",
    message: string,
  ) {
    super(message);
    this.name = "BudgetUnitError";
  }
}

/**
 * THE one conversion from a whole-naira budget to the integer Meta's API takes
 * for an ad set's daily_budget. Every budget the suite sends goes through here.
 *
 *   - the ad account must be in naira (the shop's currency): a dollar account
 *     would need an exchange rate, which we refuse to guess;
 *   - the unit factor must be the one an owner checked against Ads Manager,
 *     exactly 1 (Meta takes whole naira) or exactly 100 (Meta takes kobo);
 *   - the amount must be a whole number of naira, at least 1.
 */
export function budgetToMetaUnits(amountNgn: number, account: { currency: string; budgetFactor: number | null }): number {
  if (account.currency !== SHOP_CURRENCY) {
    throw new BudgetUnitError(
      "currency",
      `This ad account is in ${account.currency || "another currency"}, not naira. The suite only sets budgets for an ad account in naira.`,
    );
  }
  if (account.budgetFactor !== 1 && account.budgetFactor !== 100) {
    throw new BudgetUnitError("not_calibrated", "The budget unit for this ad account has not been checked yet.");
  }
  if (!Number.isSafeInteger(amountNgn) || amountNgn < 1) {
    throw new BudgetUnitError("amount", "A daily budget must be a whole number of naira, at least ₦1.");
  }
  const units = amountNgn * account.budgetFactor;
  if (!Number.isSafeInteger(units)) throw new BudgetUnitError("amount", "That budget is too large.");
  return units;
}

/** The reverse, for reading a budget back from Meta. Null when the units are not a whole number of naira. */
export function metaUnitsToNaira(units: number, account: { currency: string; budgetFactor: number | null }): number | null {
  if (account.currency !== SHOP_CURRENCY) return null;
  if (account.budgetFactor !== 1 && account.budgetFactor !== 100) return null;
  if (!Number.isSafeInteger(units) || units < 0) return null;
  const amount = units / account.budgetFactor;
  return Number.isInteger(amount) ? amount : null;
}

const DAY_MS = 24 * 3600_000;

/** Whole days an advert runs: ceil((end - start) / 24h), at least 1. */
export function runDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

/** The most an advert can spend: daily amount x runDays. */
export function maxSpend(dailyAmount: number, start: Date, end: Date): number {
  return dailyAmount * runDays(start, end);
}

export interface CapInput {
  cap: number;
  othersActiveDaily: number[];
  requestedDaily: number;
}
export interface CapResult {
  ok: boolean;
  cap: number;
  alreadyCommitted: number;
  requested: number;
  room: number;
}

/** ok only when cap > 0 and sum(othersActiveDaily) + requestedDaily <= cap. Anything not a number refuses. */
export function evaluateCap(input: CapInput): CapResult {
  const cap = Number.isFinite(input.cap) ? input.cap : 0;
  const allNumbers = input.othersActiveDaily.every((n) => Number.isFinite(n) && n >= 0);
  const alreadyCommitted = allNumbers ? input.othersActiveDaily.reduce((a, b) => a + b, 0) : Number.POSITIVE_INFINITY;
  const requested = input.requestedDaily;
  const ok = cap > 0 && Number.isFinite(requested) && requested >= 0 && alreadyCommitted + requested <= cap;
  return { ok, cap, alreadyCommitted, requested, room: Math.max(0, cap - alreadyCommitted) };
}

/** null when spend is 0 or conversations is 0. */
export function costPerConversation(spend: number, conversations: number): number | null {
  if (!(spend > 0) || !(conversations > 0)) return null;
  return spend / conversations;
}

function grouped(n: number, decimals: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "₦12,500" for NGN (kobo shown only when there are any), "$12.50" for USD, "12.50 XYZ" otherwise. */
export function money(amount: number, currency: string): string {
  const n = Number.isFinite(amount) ? amount : 0;
  if (currency === "NGN") return "₦" + grouped(n, Number.isInteger(n) ? 0 : 2);
  if (currency === "USD") return "$" + grouped(n, 2);
  return `${grouped(n, 2)} ${currency}`;
}

/** The object's name tag, " [ms-1a2b3c4d]", from the first 8 hex characters of a draft id. */
export function nameTag(draftId: string): string {
  const hex = draftId.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
  return ` [ms-${hex}]`;
}

export function destinationOf(destinationType: string | null | undefined): AdDestination | "other" {
  if (destinationType === "WHATSAPP") return "whatsapp";
  if (destinationType === "MESSENGER") return "messenger";
  if (destinationType === "INSTAGRAM_DIRECT") return "instagram";
  return "other";
}

export interface ExtractedAdReferral {
  /** The item's position across the whole payload. */
  index: number;
  accountExternalId: string;
  senderId: string;
  adId: string | null;
  headline: string | null;
  ref: string | null;
  /** When the tap happened; null when the event carried no time. */
  at: Date | null;
}

interface RawReferral {
  source?: unknown;
  ad_id?: unknown;
  ref?: unknown;
  ads_context_data?: { ad_title?: unknown } | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function eventTime(timestamp: unknown): Date | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  // Meta sends milliseconds on these events; a value below 10^12 is seconds.
  return new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
}

/**
 * Read every advert referral out of a stored Messenger or Instagram webhook
 * payload. Accepts the whole webhook body ({ object, entry: [{ id, messaging }] })
 * or a single entry ({ id, messaging }). For each messaging item it looks at
 * item.referral, item.message.referral and item.postback.referral (where a
 * brand-new Messenger thread carries it is unverified, spec 12 T5), and keeps
 * a referral only when its source is "ADS". `kind` is the stored label and is
 * not trusted for anything.
 */
export function extractAdReferrals(_kind: string, payload: unknown): ExtractedAdReferral[] {
  const body = asRecord(payload);
  if (!body) return [];
  const entries: unknown[] = Array.isArray(body.entry) ? body.entry : [body];
  const out: ExtractedAdReferral[] = [];
  let index = 0;
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const accountExternalId = entry.id != null ? String(entry.id) : "";
    const items: unknown[] = [
      ...(Array.isArray(entry.messaging) ? entry.messaging : []),
      ...(Array.isArray(entry.standby) ? entry.standby : []),
    ];
    for (const rawItem of items) {
      const i = index++;
      const item = asRecord(rawItem);
      if (!item || !accountExternalId) continue;
      const message = asRecord(item.message);
      // Our own messages echoed back are not the customer arriving.
      if (message?.is_echo) continue;
      const referral = (asRecord(item.referral) ??
        asRecord(message?.referral) ??
        asRecord(asRecord(item.postback)?.referral)) as RawReferral | null;
      if (!referral || referral.source !== "ADS") continue;
      const senderId = asRecord(item.sender)?.id;
      if (senderId == null || String(senderId) === "" || String(senderId) === accountExternalId) continue;
      const title = referral.ads_context_data?.ad_title;
      out.push({
        index: i,
        accountExternalId,
        senderId: String(senderId),
        adId: referral.ad_id != null && String(referral.ad_id) !== "" ? String(referral.ad_id) : null,
        headline: typeof title === "string" && title.trim() ? title.trim() : null,
        ref: typeof referral.ref === "string" && referral.ref ? referral.ref : null,
        at: eventTime(item.timestamp),
      });
    }
  }
  return out;
}

// ── Typed confirmation ───────────────────────────────────────────────────────

/**
 * What a person typed to confirm a total, with spaces, commas and currency
 * signs removed: "₦35,000" and " 35 000 " both give "35000". The server uses
 * the same function as the screen, and compares the result with the total it
 * worked out itself.
 */
export function normaliseTyped(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\s,₦$]/g, "").replace(/^NGN/i, "");
}

/** The text a person must type to confirm an amount: the whole number, no separators. */
export function confirmTextFor(amount: number): string {
  return String(Math.round(amount));
}

/** The most a running advert can still spend: daily x whole days left (at least 1). */
export function remainingMaxSpend(dailyAmount: number, now: Date, end: Date): number {
  return dailyAmount * runDays(now, end);
}

// ── The advert form ──────────────────────────────────────────────────────────

export const AD_LIMITS = {
  name: { min: 3, max: 80 },
  headline: 40,
  primaryText: 500,
  description: 60,
  greeting: 300,
  prefilled: 300,
  ageMin: 18,
  ageMax: 65,
  radiusMin: 5,
  radiusMax: 80,
  maxRunDays: 30,
  imageMaxBytes: 8 * 1024 * 1024,
} as const;

export const AD_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const AD_IMAGE_KEY = /^ads\/images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|jpeg|png)$/;

/** Said whenever the special-category answer is not the literal "No" (rule 8.14). */
export const SPECIAL_CATEGORY_REFUSAL = "Create adverts on these subjects in Meta Ads Manager.";

/** The shape of ad_draft.spec. `special_category` must be the literal false. */
export const adDraftSpecSchema = z
  .object({
    destination: z.enum(["whatsapp", "messenger", "instagram"]),
    account_id: z.string().uuid(),
    name: z.string().trim().min(AD_LIMITS.name.min).max(AD_LIMITS.name.max),
    headline: z.string().trim().min(1).max(AD_LIMITS.headline),
    primary_text: z.string().trim().min(1).max(AD_LIMITS.primaryText),
    description: z.string().trim().max(AD_LIMITS.description).nullable(),
    image_key: z.string().regex(AD_IMAGE_KEY),
    greeting: z.string().trim().min(1).max(AD_LIMITS.greeting),
    prefilled_message: z.string().trim().min(1).max(AD_LIMITS.prefilled).nullable(),
    audience: z
      .object({
        area: z.enum(["nigeria", "near_shop"]),
        radius_km: z.number().int().min(AD_LIMITS.radiusMin).max(AD_LIMITS.radiusMax).nullable(),
        age_min: z.number().int().min(AD_LIMITS.ageMin).max(AD_LIMITS.ageMax),
        age_max: z.number().int().min(AD_LIMITS.ageMin).max(AD_LIMITS.ageMax),
      })
      .strict(),
    daily_budget: z.number().int().min(1).max(1_000_000_000),
    start_at: z.string().datetime({ offset: true }),
    end_at: z.string().datetime({ offset: true }),
    special_category: z.literal(false),
  })
  .strict();

export type AdDraftSpecInput = z.infer<typeof adDraftSpecSchema>;

/**
 * Problems zod cannot say in one line, as plain sentences. Empty when the
 * draft may go ahead. `now` matters: a draft saved yesterday may start in the past.
 */
export function draftProblems(spec: AdDraftSpecInput, now: Date = new Date()): string[] {
  const problems: string[] = [];
  if (!ENABLED_DESTINATIONS.includes(spec.destination)) {
    problems.push("The suite can only create adverts that open a WhatsApp chat for now. Create this one in Meta Ads Manager.");
  }
  if (spec.audience.age_min > spec.audience.age_max) problems.push("The youngest age must not be above the oldest age.");
  if (spec.audience.area === "near_shop" && spec.audience.radius_km == null) {
    problems.push(`Say how far from the shop, between ${AD_LIMITS.radiusMin} and ${AD_LIMITS.radiusMax} km.`);
  }
  if (spec.destination !== "whatsapp" && spec.prefilled_message != null) {
    problems.push("A message already typed for the customer only works on WhatsApp adverts.");
  }
  const start = new Date(spec.start_at);
  const end = new Date(spec.end_at);
  // Five minutes of grace so "start now" does not fail while the form is being filled in.
  if (start.getTime() < now.getTime() - 5 * 60_000) problems.push("The start time has passed. Choose a start time from now on.");
  if (end.getTime() <= start.getTime() + DAY_MS) problems.push("The advert must end more than a day after it starts.");
  if (end.getTime() > start.getTime() + AD_LIMITS.maxRunDays * DAY_MS) {
    problems.push(`The advert must end within ${AD_LIMITS.maxRunDays} days of starting.`);
  }
  return problems;
}
