/**
 * Tasks and reminders (suite spec 15): rules shared by the API, the worker and
 * the staff apps. Pure functions, no I/O.
 */
import { localParts, type HoursRule } from "./inbox.js";

// ── Reply-time target ────────────────────────────────────────────────────────

/** app_settings key holding `{ minutes: number | null }`. A missing row means off. */
export const REPLY_TARGET_KEY = "inbox_reply_target";
export const REPLY_TARGET_MIN = 5;
export const REPLY_TARGET_MAX = 1440;

export interface ReplyTargetValue {
  /** Reply within this many minutes during opening hours; null = off. */
  minutes: number | null;
}

/** Read the stored setting defensively: anything odd counts as off. */
export function readReplyTarget(value: unknown): number | null {
  const m = (value as { minutes?: unknown } | null | undefined)?.minutes;
  if (typeof m !== "number" || !Number.isInteger(m)) return null;
  if (m < REPLY_TARGET_MIN || m > REPLY_TARGET_MAX) return null;
  return m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How far back the opening-hours count looks; older waits are counted as at least this. */
const MAX_DAYS = 31;

/**
 * Whole minutes of [from, to) that fall inside opening windows, skipping
 * holiday dates (YYYY-MM-DD, local). Reads the hours tables the same way as
 * isOpenNow: a window whose close is not after its open is closed, and there
 * are no overnight windows. `hours` null (the line has no schedule) counts
 * every minute. Day arithmetic assumes the zone's UTC offset is steady, as
 * closedSince does (true for Africa/Lagos).
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  hours: { rules: readonly HoursRule[]; holidays: readonly string[]; timeZone?: string } | null,
): number {
  const a = from.getTime();
  const b = to.getTime();
  if (!(b > a)) return 0;
  if (!hours) return Math.floor((b - a) / 60_000);
  const tz = hours.timeZone ?? "Africa/Lagos";
  const start = Math.max(a, b - MAX_DAYS * 86_400_000);
  const first = localParts(new Date(start), tz);
  // Local midnight of the first day (the zone's offset is a whole number of minutes).
  const dayStart0 = start - (start % 60_000) - first.minutes * 60_000;
  let ms = 0;
  for (let d = 0; ; d++) {
    const dayStart = dayStart0 + d * 86_400_000;
    if (dayStart >= b) break;
    const date = shiftDay(first.date, d);
    if (hours.holidays.includes(date)) continue;
    const weekday = (first.weekday + d) % 7;
    for (const r of hours.rules) {
      if (r.weekday !== weekday) continue;
      const open = toMinutes(r.openTime);
      const close = toMinutes(r.closeTime);
      if (!(close > open)) continue;
      const winStart = dayStart + open * 60_000;
      const winEnd = dayStart + close * 60_000;
      const overlap = Math.min(b, winEnd) - Math.max(start, winStart);
      if (overlap > 0) ms += overlap;
    }
  }
  return Math.floor(ms / 60_000);
}

/** "42 min", "1 h", "1 h 5 min", "2 days 3 h". */
export function waitWords(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const days = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return `${days} ${days === 1 ? "day" : "days"}${h ? ` ${h} h` : ""}`;
}

export interface ReplyFlag {
  tone: "warning" | "danger";
  text: string;
}

/**
 * The "Waiting 42 min" flag on a chat: amber at or over the target, red at
 * twice it. Null when the target is off, nothing is waiting, or it is under.
 */
export function replyFlag(waitingMinutes: number | null | undefined, targetMinutes: number | null | undefined): ReplyFlag | null {
  if (waitingMinutes == null || !targetMinutes || targetMinutes <= 0) return null;
  if (waitingMinutes < targetMinutes) return null;
  return { tone: waitingMinutes >= targetMinutes * 2 ? "danger" : "warning", text: `Waiting ${waitWords(waitingMinutes)}` };
}

// ── Snooze and reminders ─────────────────────────────────────────────────────

/** A snooze or reminder time must be at least this far ahead. */
export const SNOOZE_MIN_AHEAD_MS = 60_000;
/** …and at most this far. */
export const SNOOZE_MAX_DAYS = 90;
export const REMINDER_NOTE_MAX = 500;

/** Null when `until` is an acceptable snooze time, else what is wrong in plain English. */
export function snoozeTimeProblem(until: Date, now: Date = new Date()): string | null {
  const t = until.getTime();
  if (Number.isNaN(t)) return "Pick a date and time.";
  if (t < now.getTime() + SNOOZE_MIN_AHEAD_MS) return "Pick a time in the future.";
  if (t > now.getTime() + SNOOZE_MAX_DAYS * 86_400_000) return `Pick a time within ${SNOOZE_MAX_DAYS} days.`;
  return null;
}

/** Reminders may be set for any time up to a year ahead (a past time is "due now"). */
export function reminderTimeProblem(due: Date, now: Date = new Date()): string | null {
  const t = due.getTime();
  if (Number.isNaN(t)) return "Pick a date and time.";
  if (t > now.getTime() + 366 * 86_400_000) return "Pick a time within a year.";
  return null;
}
