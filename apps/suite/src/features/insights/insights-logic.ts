/**
 * Wording and small rules for the Insights screen (suite spec 11, section 7). Pure:
 * nothing here calls the server or reads the clock unless a "now" is passed in.
 */
import { addDays, daysInRange, lagosDayOf } from "@ms/shared";
import type { Point, PostRow, Tile } from "./insights-api.js";

export const DASH = "—";

/** 12345 → "12,345"; null → "—". Averages are rounded to a whole number. */
export function formatFigure(value: number | null | undefined, opts: { money?: boolean; currency?: string | null } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (opts.money) {
    const amount = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return opts.currency ? `${amount} ${opts.currency}` : `${amount} in your WhatsApp account's currency`;
  }
  return Math.round(value).toLocaleString("en-US");
}

/** "+12%" / "-5%" for the tile's badge; undefined when there is nothing honest to say. */
export function deltaBadge(value: number | null, previous: number | null): string | undefined {
  if (value === null || previous === null || previous === 0) return undefined;
  const pct = Math.round(((value - previous) / Math.abs(previous)) * 100);
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct)}%`;
}

const before = (days: number): string => (days === 1 ? "the day before" : `the ${days} days before`);

/** "+12% on the 30 days before" / "−5% on the 30 days before"; "" when either value is missing or the earlier one is 0. */
export function deltaText(value: number | null, previous: number | null, days: number): string {
  const badge = deltaBadge(value, previous);
  if (!badge) return "";
  return `${badge.replace("-", "−")} on ${before(days)}`;
}

/** What a tile shows: its value, its badge and the line under it. */
export function tileText(tile: Tile, opts: { days: number; currency: string | null }): { value: string; delta?: string; hint: string } {
  const value = formatFigure(tile.value, tile.key === "wa_cost" ? { money: true, currency: opts.currency } : {});
  if (tile.value === null) return { value: DASH, hint: tile.note ? `No figure yet. ${tile.note}` : "No figure yet" };
  const delta = deltaBadge(tile.value, tile.previous);
  const compared = delta ? `on ${before(opts.days)}` : "";
  const hint = [compared, tile.note].filter(Boolean).join(". ");
  return { value, ...(delta ? { delta } : {}), hint };
}

export const ZONE_NOTES: Record<string, string> = {
  "America/Los_Angeles":
    "Facebook counts each day on United States Pacific time, which is 8 or 9 hours behind Lagos. A day here runs from about 8 or 9 in the morning Lagos time to the same time the next day.",
  "Africa/Lagos": "Days are Lagos days. Instagram can take up to two days to finish counting, so the last two days may still rise.",
  UTC: "WhatsApp counts each day from 1 am to 1 am Lagos time.",
};

/** The fixed sentence that says which clock a chart's days follow. */
export function zoneNote(zone: string): string {
  return ZONE_NOTES[zone] ?? `These days follow the ${zone} clock, not Lagos time.`;
}

export const FIXED = {
  tooSmall: "Facebook only shares these figures once the Page has 100 likes.",
  noFollowerFigures: "Instagram only shares new-follower figures once the account has 100 followers.",
  bottom: "Figures from Meta and figures counted by the suite are shown separately on purpose. Do not add them together.",
  inboxChart: "Counted by the suite from the conversations you can see, on all channels. Not from Meta.",
  inboxRow:
    "Counted by the suite. WhatsApp's 'sent' figure above also includes messages sent to customers by anything else connected to the account, so the two will not match.",
  charges: "These are WhatsApp's own estimates and can differ slightly from the invoice.",
  nothingYet: "Figures are collected once a day, mid-morning. Press 'Refresh figures' to fetch them now.",
  connect: "Connect a Facebook Page or Instagram account in Channels to see their figures.",
  templatesOff: "Template figures are switched off at WhatsApp.",
} as const;

export const gapText = (network: string): string => `No figure from ${network} for this day.`;

/** At most `max` date marks, always including the last day. */
export function chartTicks(days: readonly string[], max = 6): string[] {
  if (days.length <= max) return [...days];
  const step = Math.ceil((days.length - 1) / (max - 1));
  const out: string[] = [];
  for (let i = days.length - 1; i >= 0; i -= step) out.unshift(days[i]!);
  return out;
}

/** The default dates: 30 days ending yesterday (Lagos). */
export function presetRange(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = addDays(lagosDayOf(now), -1);
  return { from: addDays(to, -(days - 1)), to };
}

export const rangeDays = (from: string, to: string): number => daysInRange(from, to);
export const validRange = (from: string, to: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to && daysInRange(from, to) <= 400;

/** "Thu 19 Nov, 10:04 am", Lagos time. */
export function lastUpdatedText(iso: string | null): string {
  if (!iso) return "Not collected yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not collected yet";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  // The 12-hour clock is worked out here, not by the browser: some browsers
  // write half past midnight as "0:30 am" for British English.
  const hour24 = Number(get("hour")) % 24;
  const hour12 = hour24 % 12 || 12;
  return `${get("weekday")} ${get("day")} ${get("month")}, ${hour12}:${get("minute")} ${hour24 < 12 ? "am" : "pm"}`;
}

/** "10 Nov" from a post's publish time, in Lagos. */
export function postDate(iso: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short" });
}

export const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: "Marketing",
  UTILITY: "Order and account updates",
  AUTHENTICATION: "Sign-in codes",
  AUTHENTICATION_INTERNATIONAL: "Sign-in codes",
  SERVICE: "Customer service replies",
  MARKETING_LITE: "Marketing (light)",
  REFERRAL_CONVERSION: "Replies to adverts",
};
export const PRICING_TYPE_LABEL: Record<string, string> = {
  REGULAR: "Charged",
  FREE_CUSTOMER_SERVICE: "Free (customer wrote first)",
  FREE_ENTRY_POINT: "Free (came from an advert or Page button)",
};
const plain = (code: string): string => {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const categoryLabel = (c: string): string => CATEGORY_LABEL[c] ?? plain(c);
export const pricingTypeLabel = (t: string): string => PRICING_TYPE_LABEL[t] ?? plain(t);

/** "media_product_type=REEL" → "Reels". The order here is the fixed colour order of the parts. */
export const CONTENT_TYPES: { key: string; label: string }[] = [
  { key: "POST", label: "Posts" },
  { key: "REEL", label: "Reels" },
  { key: "STORY", label: "Stories" },
  { key: "CAROUSEL_CONTAINER", label: "Carousels" },
  { key: "AD", label: "Adverts" },
];
export function partLabel(breakdown: string): string {
  const value = breakdown.split("=")[1] ?? breakdown;
  return CONTENT_TYPES.find((t) => t.key === value)?.label ?? plain(value);
}
/** A part keeps its colour whatever else is on the chart. */
export function partColorIndex(breakdown: string): number {
  const i = CONTENT_TYPES.findIndex((t) => t.key === (breakdown.split("=")[1] ?? ""));
  return i >= 0 ? i : CONTENT_TYPES.length;
}

/** "42%" from 0.42; "—" when there is no rate. */
export const rateText = (rate: number | null): string => (rate === null ? DASH : `${Math.round(rate * 100)}%`);

/** True when no day in the series has a figure. */
export const allMissing = (points: readonly Point[] | undefined): boolean => !points || points.every((p) => p.value === null);

export type PostSortKey = "date" | "views" | "reach" | "interactions" | "comments" | "clicks";

/** Largest (or newest) first by default; a post with no figure always goes last. */
export function sortPosts(rows: readonly PostRow[], key: PostSortKey, descending = true): PostRow[] {
  const of = (p: PostRow): number | null => (key === "date" ? (p.published_at ? Date.parse(p.published_at) : null) : p[key]);
  return [...rows].sort((a, b) => {
    const ka = of(a);
    const kb = of(b);
    if (ka === kb) return a.subject_id.localeCompare(b.subject_id);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return descending ? kb - ka : ka - kb;
  });
}

/** The first 80 characters of a post's words, or what kind of post it is. */
export function postTitle(p: Pick<PostRow, "title" | "kind" | "network">): string {
  const t = (p.title ?? "").trim();
  if (t) return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  const kind = p.kind === "story" ? "Story" : p.kind === "reels" ? "Reel" : "Post";
  return `${kind} with no caption`;
}
