/** Pure rules for the Posts screens (suite spec 09, section 7). No React in here. */
import { effectiveCaption, networkName, type SocialNetwork } from "@ms/shared";

// Lagos is UTC+1 all year (no daylight saving), so times are shifted by a fixed hour.
const LAGOS_OFFSET_MS = 3_600_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const two = (n: number): string => String(n).padStart(2, "0");

/** A Date whose UTC fields read as the Lagos clock. */
function lagosClock(d: Date | string): Date {
  return new Date(new Date(d).getTime() + LAGOS_OFFSET_MS);
}

/** "2026-11-24T09:00" typed as Lagos time becomes "2026-11-24T08:00:00.000Z". Empty string when it is not a time. */
export function lagosInputToIso(input: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(input);
  if (!m) return "";
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - LAGOS_OFFSET_MS;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/** The reverse: an ISO time as the value of a datetime-local box showing Lagos time. */
export function isoToLagosInput(iso: string): string {
  const d = lagosClock(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** "9:00 am", Lagos time. */
export function lagosTime(iso: string): string {
  const d = lagosClock(iso);
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${two(d.getUTCMinutes())} ${h < 12 ? "am" : "pm"}`;
}

/** "Tue 24 Nov, 9:00 am" (or "Tue 24 Nov 2026, 9:00 am" with the year), Lagos time. */
export function lagosDayTime(iso: string, withYear = false): string {
  const d = lagosClock(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${withYear ? ` ${d.getUTCFullYear()}` : ""}, ${lagosTime(iso)}`;
}

/** The Lagos day ("2026-11-24") an ISO time falls on. */
export function lagosDay(iso: string | Date): string {
  const d = lagosClock(iso);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

export function monthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

/** "Tue 24 Nov" for a day key. */
export function dayTitle(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The month as rows of seven day keys, Monday first, padded with the days of the
 * months either side. `month` is 1 to 12.
 */
export function calendarWeeks(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const back = (first.getUTCDay() + 6) % 7; // days since Monday
  const cursor = new Date(first.getTime() - back * 86_400_000);
  const weeks: string[][] = [];
  for (;;) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
    if (cursor.getUTCMonth() !== month - 1 || cursor.getUTCFullYear() !== year) break;
  }
  return weeks;
}

export const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "partly_published", "failed", "needs_check", "missed"] as const;

export function statusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "scheduled":
      return "Scheduled";
    case "publishing":
      return "Going out now…";
    case "published":
      return "Posted";
    case "partly_published":
      return "Posted to some, not all";
    case "failed":
      return "Did not post";
    case "needs_check":
      return "Please check";
    case "missed":
      return "Missed its time";
    default:
      return status;
  }
}

export type Tone = "neutral" | "info" | "ok" | "warn" | "bad";

export function statusTone(status: string): Tone {
  switch (status) {
    case "scheduled":
    case "publishing":
      return "info";
    case "published":
      return "ok";
    case "partly_published":
    case "needs_check":
    case "missed":
      return "warn";
    case "failed":
      return "bad";
    default:
      return "neutral";
  }
}

interface TargetLike {
  network: SocialNetwork;
  status: string;
  external_id: string | null;
  error_message: string | null;
  published_at: string | null;
  removed_at: string | null;
  removed_by: { name: string } | null;
}

/** The place a person should look: "Page" or "Instagram account". */
export function placeName(network: SocialNetwork): string {
  return network === "facebook" ? "Page" : "Instagram account";
}

/** The sentence shown beside one network on the post's page (section 7.5). */
export function targetLine(t: TargetLike): string {
  switch (t.status) {
    case "pending":
    case "publishing":
      return "Going out…";
    case "published":
      if (!t.external_id) return "Posted (not linked to statistics)";
      return t.published_at ? `Posted ${lagosDayTime(t.published_at)}` : "Posted";
    case "failed":
      return `Did not post: ${t.error_message ?? "no reason was given"}`;
    case "unknown":
      return `We could not tell whether this posted. Please look at the ${placeName(t.network)} before doing anything.`;
    case "removed":
      return `Taken down${t.removed_at ? ` ${lagosDayTime(t.removed_at)}` : ""}${t.removed_by ? ` by ${t.removed_by.name}` : ""}`;
    default:
      return t.status;
  }
}

/** The short state shown beside a network icon in the list. */
export function targetShort(t: { network: SocialNetwork; status: string }): string {
  const state =
    t.status === "published"
      ? "posted"
      : t.status === "failed"
        ? "did not post"
        : t.status === "unknown"
          ? "please check"
          : t.status === "removed"
            ? "taken down"
            : t.status === "publishing"
              ? "going out"
              : "waiting";
  return `${networkName(t.network)}: ${state}`;
}

interface PostLike {
  status: string;
  scheduled_at: string | null;
  updated_at: string;
  targets: { published_at: string | null }[];
}

/** "Goes out Tue 24 Nov, 9:00 am", "Posted …" or "Edited …" (section 7.1). */
export function timeLine(p: PostLike): string {
  if (p.status === "scheduled" && p.scheduled_at) return `Goes out ${lagosDayTime(p.scheduled_at)}`;
  if (p.status === "missed" && p.scheduled_at) return `Was due ${lagosDayTime(p.scheduled_at)}`;
  const posted = p.targets
    .map((t) => t.published_at)
    .filter((x): x is string => !!x)
    .sort()[0];
  if (posted) return `Posted ${lagosDayTime(posted)}`;
  if (p.status === "publishing") return "Going out now…";
  return `Edited ${lagosDayTime(p.updated_at)}`;
}

/** When a post sits in the calendar: its scheduled time, else when it was written. */
export function calendarTime(p: { scheduled_at: string | null; created_at: string }): string {
  return p.scheduled_at ?? p.created_at;
}

export function captionStart(caption: string, max = 90): string {
  const flat = caption.replace(/\s+/g, " ").trim();
  if (flat === "") return "No text";
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** The size a picture is drawn at before upload: at most `maxWidth` wide, same shape, whole pixels. */
export function prepareImageSize(width: number, height: number, maxWidth = 1440): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

/** The earliest and latest times the schedule picker allows, as datetime-local values in Lagos time. */
export function scheduleBounds(now: Date): { min: string; max: string } {
  return {
    min: isoToLagosInput(new Date(now.getTime() + 10 * 60_000 + 59_999).toISOString()),
    max: isoToLagosInput(new Date(now.getTime() + 90 * 86_400_000).toISOString()),
  };
}

/** The text one network will show. A story carries none. */
export function shownCaption(kind: string, base: string, override: string | null | undefined): string {
  return kind === "story" ? "" : effectiveCaption(base, override);
}

/** Split text into plain runs and hashtags, mentions (so the preview can colour them). */
export function captionRuns(text: string): { text: string; tag: boolean }[] {
  const out: { text: string; tag: boolean }[] = [];
  const re = /(^|\s)([#@][\p{L}\p{N}_.]+)/gu;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + (m[1]?.length ?? 0);
    if (start > last) out.push({ text: text.slice(last, start), tag: false });
    out.push({ text: m[2]!, tag: true });
    last = start + m[2]!.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), tag: false });
  return out;
}
