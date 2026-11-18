/**
 * Pure helpers for the unified inbox, shared by the API, the worker and the
 * admin app. No Node-only imports here: this file ships to the browser too.
 */
import { normalizeNigerianPhone } from "./phone.js";

/** WhatsApp's customer-service window: free-form replies only within 24h. */
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Normalise any phone input to E.164. Nigerian numbers in any local format
 * become +234…; anything else that already looks international (8–15 digits,
 * as WhatsApp's wa_id is) gets a leading "+". Returns null when it can't.
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const ng = normalizeNigerianPhone(input);
  if (ng) return ng;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  // A local Nigerian-looking number that failed above is not international.
  if (!trimmed.startsWith("+") && digits.startsWith("0")) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** WhatsApp's wa_id is the E.164 number without the "+". */
export function waIdFromE164(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** Is the 24-hour reply window open? */
export function waWindowOpen(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < WA_WINDOW_MS;
}

/** Milliseconds left in the window (0 when closed). */
export function waWindowRemainingMs(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (!lastInboundAt) return 0;
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t + WA_WINDOW_MS - now.getTime());
}

export interface HoursRule {
  /** 0 = Sunday … 6 = Saturday, in the profile's time zone. */
  weekday: number;
  /** "HH:MM", 24-hour. */
  openTime: string;
  /** "HH:MM", 24-hour; "24:00" = midnight end of day. */
  closeTime: string;
}

/** Local wall-clock parts of `now` in `timeZone`. */
export function localParts(now: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdays.indexOf(parts.weekday ?? ""),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Open right now? Closed on any holiday date (YYYY-MM-DD, local). A rule whose
 * close time is not after its open time is treated as closed (no overnight
 * windows; add two rules for that).
 */
export function isOpenNow(
  rules: readonly HoursRule[],
  holidays: readonly string[],
  now: Date = new Date(),
  timeZone = "Africa/Lagos",
): boolean {
  const { date, weekday, minutes } = localParts(now, timeZone);
  if (holidays.includes(date)) return false;
  return rules.some((r) => {
    if (r.weekday !== weekday) return false;
    const open = toMinutes(r.openTime);
    const close = toMinutes(r.closeTime);
    return close > open && minutes >= open && minutes < close;
  });
}

/** "YYYY-MM-DD" moved by a number of days. */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * When the current closed period began: the end of the most recent open
 * window, looking back at most `maxDaysBack` days. Null when open right now.
 * Same rules as isOpenNow (holidays closed all day, no overnight windows).
 * If the business was not open at all in the look-back, returns its start.
 * Day arithmetic assumes the zone's UTC offset did not change in between
 * (true for Africa/Lagos; elsewhere it can be an hour out across a clock change).
 */
export function closedSince(
  rules: readonly HoursRule[],
  holidays: readonly string[],
  now: Date = new Date(),
  timeZone = "Africa/Lagos",
  maxDaysBack = 14,
): Date | null {
  if (isOpenNow(rules, holidays, now, timeZone)) return null;
  const { date, weekday, minutes } = localParts(now, timeZone);
  const startOfLocalDay = now.getTime() - (now.getTime() % 60_000) - minutes * 60_000;
  for (let back = 0; back <= maxDaysBack; back++) {
    if (holidays.includes(shiftDay(date, -back))) continue;
    const wd = (((weekday - back) % 7) + 7) % 7;
    let latestClose = -1;
    for (const r of rules) {
      if (r.weekday !== wd) continue;
      const open = toMinutes(r.openTime);
      const close = toMinutes(r.closeTime);
      if (!(close > open)) continue;
      // Today: only windows that have already ended (later ones haven't opened yet).
      if (back === 0 && close > minutes) continue;
      latestClose = Math.max(latestClose, close);
    }
    if (latestClose >= 0) return new Date(startOfLocalDay - back * 86_400_000 + latestClose * 60_000);
  }
  return new Date(now.getTime() - maxDaysBack * 86_400_000);
}

/** Message types staff can send inside the window. */
export const INBOX_SEND_TYPES = ["text", "image", "document", "audio", "video"] as const;
export type InboxSendType = (typeof INBOX_SEND_TYPES)[number];

/** Short human preview for the inbox list. */
export function messagePreview(type: string, body: string | null | undefined): string {
  if (body && body.trim()) return body.trim().slice(0, 140);
  switch (type) {
    case "image":
      return "📷 Photo";
    case "audio":
      return "🎤 Voice note";
    case "video":
      return "🎬 Video";
    case "document":
      return "📄 Document";
    case "sticker":
      return "Sticker";
    case "location":
      return "📍 Location";
    case "template":
      return "Template message";
    default:
      return "Message";
  }
}

/** Real-time event names pushed to the staff apps. */
export const INBOX_EVENTS = [
  "message.created",
  "message.status",
  "conversation.updated",
  "note.created",
  "conversation.typing",
  "call.ringing",
  "call.updated",
  "recording.processed",
] as const;
export type InboxEventName = (typeof INBOX_EVENTS)[number];
