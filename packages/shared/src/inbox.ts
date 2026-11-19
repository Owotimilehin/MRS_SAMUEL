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

/**
 * Channel accounts (suite spec 01, foundation D1/D2). A row of
 * inbox_phone_number is a "channel account": a phone line, a Facebook Page,
 * or an Instagram account. The values are enforced here and in zod, not by a
 * database CHECK, so later specs can add values without a drop.
 */
export const CHANNEL_KINDS = ["phone", "messenger", "instagram"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** The channel a customer identity (and a conversation, and a message) is on. */
export const IDENTITY_CHANNELS = ["whatsapp", "messenger", "instagram"] as const;
export type IdentityChannel = (typeof IDENTITY_CHANNELS)[number];

/** account_external_id of every WhatsApp identity (a WhatsApp ID is not scoped to one line). */
export const WHATSAPP_ACCOUNT_KEY = "global";

/** The conversation channel for a line: a phone line talks WhatsApp; the others are themselves. */
export function channelForKind(kind: ChannelKind): IdentityChannel {
  return kind === "phone" ? "whatsapp" : kind;
}

const BSUID_RE = /^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$/;

/**
 * A WhatsApp business-scoped user ID ("US.1349…" or "US.ENT.1181…"), as
 * opposed to a digits-only wa_id (a phone number).
 */
export function isBsuid(id: string | null | undefined): boolean {
  return typeof id === "string" && BSUID_RE.test(id);
}

/** Plain name of a channel for screens. */
export function channelLabel(channel: IdentityChannel): string {
  switch (channel) {
    case "whatsapp":
      return "WhatsApp";
    case "messenger":
      return "Facebook Messenger";
    case "instagram":
      return "Instagram";
  }
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

/** Messenger/Instagram "Human Agent": a person may answer up to 7 days after the customer wrote (spec 02, S5). */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Milliseconds left of the 7-day human-agent window (0 when closed or never opened). */
export function humanAgentRemainingMs(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (!lastInboundAt) return 0;
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t + HUMAN_AGENT_WINDOW_MS - now.getTime());
}

/** How long a reply may be on each channel (spec 02, 3.6). Instagram counts UTF-8 bytes. */
export const TEXT_LIMIT: Record<"whatsapp" | "messenger" | "instagram", { max: number; unit: "characters" | "bytes" }> = {
  whatsapp: { max: 4096, unit: "characters" },
  messenger: { max: 1999, unit: "characters" },
  instagram: { max: 1000, unit: "bytes" },
};

/** UTF-8 length of a string, without Node's Buffer (the front ends use this too). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** True when `text` fits the channel's limit. */
export function fitsTextLimit(channel: "whatsapp" | "messenger" | "instagram", text: string): boolean {
  const lim = TEXT_LIMIT[channel];
  return (lim.unit === "bytes" ? utf8Bytes(text) : [...text].length) <= lim.max;
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
