/**
 * Broadcasts on WhatsApp (suite spec 14, Phase B): the pure rules shared by the
 * API, the worker and the suite screens. Browser-safe: no Node imports.
 *
 * A broadcast is one approved WhatsApp template sent to a list of contacts.
 * Nothing in this file sends anything.
 */
import { localParts } from "./inbox.js";
import { templateNeeds, type TemplateNeeds } from "./inbox-templates.js";
import { consentKeyword, firstName } from "./contacts.js";

// ── Settings ─────────────────────────────────────────────────────────────────

export type BroadcastRoute = "cloud" | "mm";
export type BroadcastAudienceRule = "consent_only" | "consent_or_recent_customer";

export interface BroadcastSettings {
  /** The owner switch (foundation C6). Off by default: nothing is sent while it is off. */
  enabled: boolean;
  /** "HH:MM", Africa/Lagos. */
  send_from: string;
  send_until: string;
  /** 6..60 */
  rate_per_minute: number;
  /** 0..90 */
  min_days_between: number;
  /** 1..30 */
  attribution_days: number;
  audience_rule: BroadcastAudienceRule;
  /** 1..24 */
  recent_customer_months: number;
  /** 0.1..1: share of the WhatsApp limit a day's sending may use. */
  daily_share: number;
  route: BroadcastRoute;
}

export const DEFAULT_BROADCAST_SETTINGS: BroadcastSettings = {
  enabled: false,
  send_from: "09:00",
  send_until: "19:00",
  rate_per_minute: 20,
  min_days_between: 7,
  attribution_days: 7,
  audience_rule: "consent_only",
  recent_customer_months: 12,
  daily_share: 0.8,
  route: "cloud",
};

/** app_settings keys (no migration: rows in the existing table). */
export const BROADCAST_SETTINGS_KEY = "broadcast_settings";
/** { [waba id]: { waba_id, event, detail, at } }: written by the account_update webhook, cleared only by a person. */
export const BROADCAST_ACCOUNT_BLOCK_KEY = "broadcast_account_block";
/** { claimed_at, wabas: { [waba id]: { mm_status, checked_at } } }: what the health check last read. */
export const BROADCAST_META_STATE_KEY = "broadcast_meta_state";

export const BROADCAST_LIMITS = {
  name: 80,
  rateMin: 6,
  rateMax: 60,
  gapDaysMax: 90,
  attributionMin: 1,
  attributionMax: 30,
  recentMonthsMin: 1,
  recentMonthsMax: 24,
  shareMin: 0.1,
  shareMax: 1,
  /** A list bigger than this cannot be used for one broadcast (rule R50). */
  listMax: 20_000,
  /** An unlimited WhatsApp tier still sends at most this many a day (rule R51). */
  unlimitedPerDay: 20_000,
  /** A broadcast that would take longer than this many days is refused (rule R52). */
  maxDays: 14,
  /** Every filled blank is cut to this many characters (rule R45). */
  blankMax: 60,
  /** The first batch: this many go out, then the broadcast waits (section 6, step 8). */
  warmupCount: 20,
  warmupMinutes: 10,
  /** At most this many test sends per broadcast per hour (rule R43). */
  testsPerHour: 5,
  /** A test is good for this long (rule R44). */
  testValidHours: 24,
  /** A scheduled time must be at least this far ahead, and at most scheduleMaxDays ahead (7.9). */
  scheduleMinMinutes: 10,
  scheduleMaxDays: 30,
  /** Header picture: JPEG or PNG up to 5 MB (M30). */
  headerMaxBytes: 5 * 1024 * 1024,
  /** Meta keeps an uploaded picture for 30 days: re-upload after 20, stop after 25. */
  mediaReuploadDays: 20,
  mediaExpiredDays: 25,
} as const;

export const BROADCAST_HEADER_MIMES = ["image/jpeg", "image/png"] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function numberIn(v: unknown, min: number, max: number, fallback: number, whole = true): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (whole && !Number.isInteger(v)) return fallback;
  return v < min || v > max ? fallback : v;
}

/**
 * Settings as stored, with the default for anything missing or out of range.
 * `enabled` is true only when the stored value is exactly `true`: a missing or
 * damaged row means broadcasts are off.
 */
export function readBroadcastSettings(value: unknown): BroadcastSettings {
  const d = DEFAULT_BROADCAST_SETTINGS;
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const from = typeof v.send_from === "string" && HHMM.test(v.send_from) ? v.send_from : d.send_from;
  const until = typeof v.send_until === "string" && HHMM.test(v.send_until) ? v.send_until : d.send_until;
  const hoursOk = minutesOf(from) < minutesOf(until);
  const L = BROADCAST_LIMITS;
  return {
    enabled: v.enabled === true,
    send_from: hoursOk ? from : d.send_from,
    send_until: hoursOk ? until : d.send_until,
    rate_per_minute: numberIn(v.rate_per_minute, L.rateMin, L.rateMax, d.rate_per_minute),
    min_days_between: numberIn(v.min_days_between, 0, L.gapDaysMax, d.min_days_between),
    attribution_days: numberIn(v.attribution_days, L.attributionMin, L.attributionMax, d.attribution_days),
    audience_rule: v.audience_rule === "consent_or_recent_customer" ? "consent_or_recent_customer" : "consent_only",
    recent_customer_months: numberIn(v.recent_customer_months, L.recentMonthsMin, L.recentMonthsMax, d.recent_customer_months),
    daily_share: numberIn(v.daily_share, L.shareMin, L.shareMax, d.daily_share, false),
    route: v.route === "mm" ? "mm" : "cloud",
  };
}

/** A plain sentence when settings typed by a person are not allowed; null when they are fine. */
export function broadcastSettingsProblem(s: BroadcastSettings): string | null {
  const L = BROADCAST_LIMITS;
  if (!HHMM.test(s.send_from) || !HHMM.test(s.send_until)) return "Enter the sending hours as two times, like 09:00 and 19:00.";
  if (minutesOf(s.send_from) >= minutesOf(s.send_until)) return "The first sending time must be earlier than the second.";
  if (!Number.isInteger(s.rate_per_minute) || s.rate_per_minute < L.rateMin || s.rate_per_minute > L.rateMax) {
    return `Speed must be between ${L.rateMin} and ${L.rateMax} messages a minute.`;
  }
  if (!Number.isInteger(s.min_days_between) || s.min_days_between < 0 || s.min_days_between > L.gapDaysMax) {
    return `The gap between broadcasts to the same person must be between 0 and ${L.gapDaysMax} days.`;
  }
  if (!Number.isInteger(s.attribution_days) || s.attribution_days < L.attributionMin || s.attribution_days > L.attributionMax) {
    return `Orders can be counted for between ${L.attributionMin} and ${L.attributionMax} days.`;
  }
  if (!Number.isInteger(s.recent_customer_months) || s.recent_customer_months < L.recentMonthsMin || s.recent_customer_months > L.recentMonthsMax) {
    return `"Ordered in the last" must be between ${L.recentMonthsMin} and ${L.recentMonthsMax} months.`;
  }
  if (!Number.isFinite(s.daily_share) || s.daily_share < L.shareMin || s.daily_share > L.shareMax) {
    return "The share of the daily WhatsApp limit must be between 10% and 100%.";
  }
  return null;
}

// ── The WhatsApp limit and sending hours ─────────────────────────────────────

/**
 * "TIER_250" -> 250, "TIER_2K" -> 2000, "TIER_10K", "TIER_100K", "TIER_UNLIMITED" -> Infinity;
 * "TIER_50" -> 50; a bare number as text or integer -> that number; anything else, null or
 * "TIER_NOT_SET" -> 250 (the lowest real tier, the safe side).
 */
export function tierToNumber(tier: string | number | null | undefined): number {
  if (typeof tier === "number") return Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 250;
  const t = (tier ?? "").trim().toUpperCase();
  if (/^\d+$/.test(t)) return Number(t) > 0 ? Number(t) : 250;
  switch (t) {
    case "TIER_50":
      return 50;
    case "TIER_250":
      return 250;
    case "TIER_2K":
      return 2_000;
    case "TIER_10K":
      return 10_000;
    case "TIER_100K":
      return 100_000;
    case "TIER_UNLIMITED":
      return Infinity;
    default:
      return 250;
  }
}

/** How many new people a day's sending may reach (rule R51). */
export function perDayFor(tier: string | number | null | undefined, dailyShare: number): number {
  const n = tierToNumber(tier);
  if (!Number.isFinite(n)) return BROADCAST_LIMITS.unlimitedPerDay;
  return Math.max(0, Math.floor(n * dailyShare));
}

const LAGOS = "Africa/Lagos";
/** Lagos is UTC+1 all year (no daylight saving). */
const LAGOS_OFFSET = "+01:00";

/** Is `now` inside the sending hours, Lagos time? From `send_from` (included) to `send_until` (not included). */
export function withinSendingHours(now: Date, s: Pick<BroadcastSettings, "send_from" | "send_until">): boolean {
  if (!HHMM.test(s.send_from) || !HHMM.test(s.send_until)) return false;
  const from = minutesOf(s.send_from);
  const until = minutesOf(s.send_until);
  if (from >= until) return false;
  const m = localParts(now, LAGOS).minutes;
  return m >= from && m < until;
}

/** The next moment sending may happen: `now` when inside the hours, else the next `send_from`. */
export function nextSendingStart(now: Date, s: Pick<BroadcastSettings, "send_from" | "send_until">): Date {
  if (withinSendingHours(now, s)) return now;
  const from = HHMM.test(s.send_from) ? s.send_from : DEFAULT_BROADCAST_SETTINGS.send_from;
  const parts = localParts(now, LAGOS);
  const today = new Date(`${parts.date}T${from}:00${LAGOS_OFFSET}`);
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + 24 * 3600_000);
}

/** Why a time picked for "Send later" is refused (7.9); null when it is fine. */
export function scheduleProblem(scheduledAt: Date | null, now: Date, s: Pick<BroadcastSettings, "send_from" | "send_until">): string | null {
  const L = BROADCAST_LIMITS;
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) return "Pick a date and time.";
  if (scheduledAt.getTime() < now.getTime() + L.scheduleMinMinutes * 60_000) return `Pick a time at least ${L.scheduleMinMinutes} minutes from now.`;
  if (scheduledAt.getTime() > now.getTime() + L.scheduleMaxDays * 24 * 3600_000) return `Pick a time in the next ${L.scheduleMaxDays} days.`;
  if (!withinSendingHours(scheduledAt, s)) return `Pick a time between ${s.send_from} and ${s.send_until}.`;
  return null;
}

/** Days a broadcast to `willSend` people takes at `perDay` a day (rule R52). */
export function estimateDays(willSend: number, perDay: number): number {
  if (willSend <= 0) return 0;
  if (perDay <= 0) return Infinity;
  return Math.ceil(willSend / perDay);
}

/** How many recipients one five-second tick may take (section 6, step 6). */
export function tickBatch(ratePerMinute: number): number {
  return Math.max(1, Math.ceil(ratePerMinute / 12));
}

// ── Blanks ───────────────────────────────────────────────────────────────────

export type BlankSource = { from: "first_name" | "full_name"; fallback: string } | { from: "fixed"; text: string };

export interface BroadcastBlanks {
  body: BlankSource[];
  header?: BlankSource;
  buttons?: { index: number; text: string }[];
}

export interface FilledBlanks {
  body: string[];
  header?: string;
}

/** Trim, turn line breaks, tabs and runs of spaces into one space, cut to 60 characters. */
export function tidyBlank(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, BROADCAST_LIMITS.blankMax).trim();
}

/** Words that are never a person's name: the text a careless program writes for "nothing". */
const NOT_A_NAME = new Set(["undefined", "null", "nan"]);

function usableName(name: string | null | undefined): string | null {
  const t = (name ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.startsWith("@") || NOT_A_NAME.has(t.toLowerCase())) return null;
  return t;
}

function fillOne(src: BlankSource, contact: { name: string | null }): string {
  if (src.from === "fixed") return tidyBlank(src.text);
  const name = usableName(contact.name);
  const value = src.from === "first_name" ? firstName(name) : name;
  return tidyBlank(value) || tidyBlank(src.fallback);
}

/**
 * Fill a broadcast's blanks for one contact (rule R45). A missing name becomes
 * the fallback the owner typed; nothing here ever returns "undefined" or leaves
 * a "{{1}}" behind.
 */
export function fillBlanks(b: BroadcastBlanks, contact: { name: string | null }): FilledBlanks {
  const out: FilledBlanks = { body: (b.body ?? []).map((src) => fillOne(src, contact)) };
  if (b.header) out.header = fillOne(b.header, contact);
  return out;
}

/** The blanks of a new draft: blank 1 is the first name with "there"; every other blank is empty fixed text. */
export function defaultBlanks(needs: TemplateNeeds): BroadcastBlanks {
  const blanks: BroadcastBlanks = {
    body: Array.from({ length: needs.bodyParams }, (_, i): BlankSource => (i === 0 ? { from: "first_name", fallback: "there" } : { from: "fixed", text: "" })),
  };
  if (!needs.headerMedia && needs.headerParams > 0) blanks.header = { from: "fixed", text: "" };
  if (needs.urlButtons.length) blanks.buttons = needs.urlButtons.map((u) => ({ index: u.index, text: "" }));
  return blanks;
}

function isSource(v: unknown): v is BlankSource {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.from === "fixed") return typeof s.text === "string";
  return (s.from === "first_name" || s.from === "full_name") && typeof s.fallback === "string";
}

/** Read stored blanks defensively. Anything that is not the expected shape is dropped. */
export function readBlanks(value: unknown): BroadcastBlanks {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const out: BroadcastBlanks = { body: Array.isArray(v.body) ? v.body.filter(isSource) : [] };
  if (isSource(v.header)) out.header = v.header;
  if (Array.isArray(v.buttons)) {
    out.buttons = v.buttons
      .filter((b): b is { index: number; text: string } => typeof b === "object" && b !== null && Number.isInteger((b as { index?: unknown }).index) && typeof (b as { text?: unknown }).text === "string")
      .map((b) => ({ index: b.index, text: b.text }));
  }
  return out;
}

const BRACES = /\{\{|\}\}/;

function sourceFilled(src: BlankSource | undefined): boolean {
  if (!src) return false;
  const text = tidyBlank(src.from === "fixed" ? src.text : src.fallback);
  return text !== "" && !BRACES.test(text) && !NOT_A_NAME.has(text.toLowerCase());
}

/** Why these blanks cannot be confirmed for this template; null when every blank is filled. */
export function blanksProblem(blanks: BroadcastBlanks, needs: TemplateNeeds): string | null {
  const FILL = "Fill in every blank.";
  if (blanks.body.length !== needs.bodyParams) return FILL;
  if (!blanks.body.every(sourceFilled)) return FILL;
  if (!needs.headerMedia && needs.headerParams > 0 && !sourceFilled(blanks.header)) return FILL;
  for (const u of needs.urlButtons) {
    const given = tidyBlank(blanks.buttons?.find((b) => b.index === u.index)?.text);
    if (!given || BRACES.test(given)) return FILL;
    // A link ending is fixed text for everyone (7.9, section 4).
  }
  return null;
}

/**
 * The last check before a message leaves (rule h): the values kept for one
 * person must fit the template exactly, with no empty value, no "{{1}}" and no
 * "undefined". Returns a plain sentence when they do not.
 */
export function valuesProblem(values: FilledBlanks | null | undefined, needs: TemplateNeeds): string | null {
  const bad = (t: unknown): boolean => typeof t !== "string" || t.trim() === "" || BRACES.test(t) || NOT_A_NAME.has(t.trim().toLowerCase());
  if (!values || !Array.isArray(values.body)) return "The filled blanks for this person are missing.";
  if (values.body.length !== needs.bodyParams) return "The number of blanks no longer fits the template.";
  if (values.body.some(bad)) return "A blank in the message is empty or was not filled.";
  if (!needs.headerMedia && needs.headerParams > 0 && bad(values.header)) return "The blank in the heading is empty or was not filled.";
  return null;
}

/** How many blanks use a name (so the editor can say how many people will get the fallback). */
export function usesName(blanks: BroadcastBlanks): boolean {
  return [...blanks.body, ...(blanks.header ? [blanks.header] : [])].some((s) => s.from !== "fixed");
}

// ── Which templates can be broadcast (rules R41, R42) ────────────────────────

export const BROADCAST_CATEGORIES = ["MARKETING", "UTILITY"] as const;

export const TEMPLATE_WHY_NOT = {
  not_approved: "WhatsApp has not approved this template.",
  category: "Only promotion and update templates can be broadcast.",
  paused: "WhatsApp has paused this template.",
  low_quality: "WhatsApp rates this template as low quality.",
  unsupported: "This template has a part broadcasts can't send yet.",
  header_kind: "Broadcasts can only carry a picture heading for now.",
  no_stop: "This template does not tell people how to stop. Add the footer “Reply STOP to stop these messages” in Templates and send it for approval.",
} as const;

function componentText(components: readonly unknown[] | null | undefined, type: string): string {
  for (const raw of components ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as { type?: unknown; text?: unknown };
    if (String(c.type ?? "").toUpperCase() === type && typeof c.text === "string") return c.text;
  }
  return "";
}

export function templateBodyText(components: readonly unknown[] | null | undefined): string {
  return componentText(components, "BODY");
}

/** Does a promotion say how to stop? The word STOP in the body or footer, or a quick-reply button that is a stop word. */
export function hasStopWording(components: readonly unknown[] | null | undefined): boolean {
  const text = `${componentText(components, "BODY")}\n${componentText(components, "FOOTER")}`;
  if (/(^|[^\p{L}])stop([^\p{L}]|$)/iu.test(text)) return true;
  for (const raw of components ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as { type?: unknown; buttons?: unknown };
    if (String(c.type ?? "").toUpperCase() !== "BUTTONS" || !Array.isArray(c.buttons)) continue;
    for (const b of c.buttons as { type?: unknown; text?: unknown }[]) {
      if (String(b?.type ?? "").toUpperCase() === "QUICK_REPLY" && typeof b.text === "string" && consentKeyword(b.text) === "stop") return true;
    }
  }
  return false;
}

export interface TemplateBroadcastUse {
  usable: boolean;
  why_not: string | null;
  needs: TemplateNeeds;
  has_stop_wording: boolean;
}

/**
 * Can this template be broadcast? Only an APPROVED promotion or update
 * template, not paused, not rated low, with nothing the broadcast send cannot
 * supply (a form button needs a person's signed token; a video or document
 * heading is not carried yet), and, for a promotion, wording that says how to stop.
 */
export function templateBroadcastUse(t: {
  status: string | null;
  category: string | null;
  components: readonly unknown[] | null | undefined;
  qualityScore?: string | null;
  reviewInfo?: { pause?: unknown } | null;
}): TemplateBroadcastUse {
  const needs = templateNeeds(t.components, t.category);
  const has_stop_wording = hasStopWording(t.components);
  const category = (t.category ?? "").toUpperCase();
  let why: string | null = null;
  if ((t.status ?? "").toUpperCase() !== "APPROVED") why = TEMPLATE_WHY_NOT.not_approved;
  else if (!(BROADCAST_CATEGORIES as readonly string[]).includes(category)) why = TEMPLATE_WHY_NOT.category;
  else if (t.reviewInfo?.pause) why = TEMPLATE_WHY_NOT.paused;
  else if ((t.qualityScore ?? "").toUpperCase() === "RED") why = TEMPLATE_WHY_NOT.low_quality;
  else if (!needs.sendable || needs.flowButtons.length > 0) why = TEMPLATE_WHY_NOT.unsupported;
  else if (needs.headerMedia && needs.headerMedia !== "image") why = TEMPLATE_WHY_NOT.header_kind;
  else if (category === "MARKETING" && !has_stop_wording) why = TEMPLATE_WHY_NOT.no_stop;
  return { usable: why === null, why_not: why, needs, has_stop_wording };
}

/** The message as one person will read it: the body with the blanks filled. Unfilled blanks show as "…". */
export function previewText(components: readonly unknown[] | null | undefined, values: FilledBlanks): string {
  return templateBodyText(components).replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => values.body[Number(n) - 1] || "…");
}

// ── Wording ──────────────────────────────────────────────────────────────────

export const BROADCAST_STATUSES = ["draft", "scheduled", "sending", "paused", "stopped", "done", "cancelled"] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const RECIPIENT_STATES = ["pending", "skipped", "sending", "sent", "delivered", "read", "failed", "unknown"] as const;
export type RecipientState = (typeof RECIPIENT_STATES)[number];

export const SKIP_REASONS = ["no_phone", "opted_out", "not_whatsapp", "no_consent", "duplicate_number", "recent", "held_back", "erased", "cancelled"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** `<n>` in "recent" is the owner's gap in days: use skipReasonText() to fill it. */
export const SKIP_REASON_TEXT: Record<string, string> = {
  no_phone: "No phone number",
  opted_out: "Asked us to stop promotions",
  not_whatsapp: "This number is not on WhatsApp (an earlier message could not be delivered)",
  no_consent: "Has not agreed to promotions on WhatsApp",
  duplicate_number: "Same phone number as someone else on this list",
  recent: "Got a broadcast in the last <n> days",
  held_back: "WhatsApp held back our last promotion to them, so we are leaving them a day",
  erased: "Asked us to delete their history",
  cancelled: "The broadcast was cancelled before their turn",
};

export function skipReasonText(reason: string | null | undefined, gapDays: number): string {
  const text = SKIP_REASON_TEXT[reason ?? ""] ?? "Left out";
  return text.replace("<n>", String(gapDays));
}

export const STOP_REASONS = [
  "switched_off",
  "quality",
  "template",
  "account",
  "payment",
  "config",
  "blanks",
  "failure_spike",
  "optout_spike",
  "meta_busy",
  "media_expired",
  "too_long",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const STOP_REASON_TEXT: Record<string, string> = {
  switched_off: "Broadcasts were switched off.",
  quality: "WhatsApp lowered the quality rating of our number. Too many people blocked or reported us. Do not resume until it recovers.",
  template: "WhatsApp paused or removed this template.",
  account: "WhatsApp has restricted the business account. Open WhatsApp Manager to see why.",
  payment: "WhatsApp could not take payment. Fix the payment method in Meta Business Settings.",
  config: "Our connection to Meta needs attention. Tell Tes.",
  blanks: "The blanks did not fit the template. Open the broadcast and check them.",
  failure_spike: "Too many messages were failing, so we stopped to protect the number.",
  optout_spike: "Many people asked us to stop after this message.",
  meta_busy: "WhatsApp kept asking us to slow down.",
  media_expired: "The picture has expired at WhatsApp. Make a new broadcast.",
  too_long: "This broadcast ran for 14 days without finishing.",
};

export function stopReasonText(reason: string | null | undefined): string {
  return STOP_REASON_TEXT[reason ?? ""] ?? "The broadcast was stopped.";
}

/** A Meta failure code in plain words (7.10). */
export function plainFailure(code: string | null | undefined): string {
  switch (code) {
    case "131026":
      return "Not on WhatsApp, or their WhatsApp is out of date";
    case "131049":
      return "WhatsApp held it back: they have had enough promotions lately";
    case "131050":
      return "They have switched off promotions from us in WhatsApp";
    case "130472":
      return "WhatsApp left them out as part of its own test";
    case "131062":
      return "They hide their number, and WhatsApp can't deliver this kind of message to them";
    case "132015":
    case "132016":
      return "WhatsApp paused the template";
    case "131042":
      return "WhatsApp could not take payment";
    case null:
    case undefined:
    case "":
      return "It did not go";
    default:
      return `WhatsApp refused it (code ${code})`;
  }
}

/** The value sent with every broadcast message so Meta's delivery reports can be matched to a recipient (rule R58). */
export const BROADCAST_CALLBACK_PREFIX = "bc:";

// ── What the routes return (apps/api/src/routes/broadcasts.ts) ───────────────

export interface BroadcastCounts {
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  unknown: number;
  skipped: number;
  opted_out: number;
}

export interface BroadcastRow {
  id: string;
  name: string;
  status: BroadcastStatus;
  stop_reason: string | null;
  stop_text: string | null;
  list_name: string | null;
  template_name: string | null;
  template_category: string | null;
  line_label: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  confirmed_count: number | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
  counts: BroadcastCounts;
}

export interface BroadcastEventView {
  kind: string;
  detail: string | null;
  by_name: string | null;
  at: string;
}

export type BroadcastWaiting = "hours" | "limit" | "warmup" | "slow_down" | null;

export interface BroadcastDetail extends BroadcastRow {
  phone_number_id: string;
  list_id: string | null;
  template_id: string | null;
  template_language: string | null;
  stop_detail: string | null;
  blanks: BroadcastBlanks;
  /** The body filled for an example person (the fallback name). */
  preview_text: string;
  /** What the chosen template needs; null when no template is chosen or it is gone. */
  needs: TemplateNeeds | null;
  template_components: unknown[] | null;
  /** Why the chosen template cannot be used, when it cannot. */
  template_why_not: string | null;
  header_media: { key: string; mime: string | null } | null;
  test: { to: string | null; sent_at: string | null; status: string | null; matches: boolean; fresh: boolean } | null;
  can: { edit: boolean; test: boolean; confirm: boolean; pause: boolean; resume: boolean; cancel: boolean; delete: boolean };
  /** Why a sending broadcast is not sending right now. */
  waiting: BroadcastWaiting;
  send_from: string;
  send_until: string;
  rate_per_minute: number;
  enabled: boolean;
  events: BroadcastEventView[];
}

export interface BroadcastOptions {
  lines: { id: string; label: string; e164: string | null; quality_rating: string | null; waba_id: string | null }[];
  templates: {
    id: string;
    waba_id: string;
    name: string;
    language: string;
    category: string | null;
    quality_score: string | null;
    body_text: string;
    components: unknown[];
    needs: TemplateNeeds;
    has_stop_wording: boolean;
    usable: boolean;
    why_not: string | null;
  }[];
  lists: { id: string; name: string; kind: "static" | "smart"; count: number }[];
  /** The signed-in person's own phone, to pre-fill the test box (null when not set). */
  my_phone: string | null;
}

export interface BroadcastAudience {
  counts: { list: number; will_send: number; skipped: Record<string, number> };
  estimate: { per_day: number; days: number; first_day: number };
  /** How many of the people who will get it have no usable name (they get the fallback). */
  no_name: number;
  gap_days: number;
  people: { customer_id: string; name: string | null; phone: string | null; reason: string | null }[];
  next_cursor: string | null;
}

export interface BroadcastSettingsView extends BroadcastSettings {
  limit: { tier: string | null; per_day: number; used_24h: number; left_today: number } | null;
  quality_rating: string | null;
  mm_status: "ELIGIBLE" | "ONBOARDED" | null;
  /** Set when WhatsApp reported a restriction on the account; cleared only by a person. */
  account_block: { waba_id: string; event: string; detail: string | null; at: string } | null;
}

export interface BroadcastHealth {
  tier: string | null;
  quality_rating: string | null;
  status: string | null;
  mm_status: "ELIGIBLE" | "ONBOARDED" | null;
  problems: { code: string; plain: string }[];
}

export interface BroadcastResults {
  counts: BroadcastCounts & { list: number };
  failures: { code: string | null; plain: string; count: number }[];
  skipped: { reason: string; plain: string; count: number }[];
  orders: { days: number; people: number; orders: number; total_ngn: number };
  events: BroadcastEventView[];
}

export interface BroadcastRecipientRow {
  id: string;
  customer_id: string | null;
  name: string | null;
  phone: string | null;
  state: RecipientState;
  skip_reason: string | null;
  plain_reason: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  opted_out_at: string | null;
  conversation_id: string | null;
}
