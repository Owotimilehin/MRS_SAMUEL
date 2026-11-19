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

export type UploadKind = "image" | "document" | "audio" | "video";
export type UploadRule = { kind: UploadKind; maxBytes: number };

const MB = 1024 * 1024;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Which files each channel may send, and how big (spec 02, 5.6). The WhatsApp
 * entry is the list the inbox has always used (moved here unchanged). The
 * Messenger formats are [unverified] at Meta (S7), so the list is cautious.
 */
export const UPLOAD_RULES: Record<"whatsapp" | "messenger" | "instagram", Record<string, UploadRule>> = {
  whatsapp: {
    "image/jpeg": { kind: "image", maxBytes: 5 * MB },
    "image/png": { kind: "image", maxBytes: 5 * MB },
    "application/pdf": { kind: "document", maxBytes: 16 * MB },
    [DOCX]: { kind: "document", maxBytes: 16 * MB },
    [XLSX]: { kind: "document", maxBytes: 16 * MB },
    "text/plain": { kind: "document", maxBytes: 16 * MB },
    "audio/mpeg": { kind: "audio", maxBytes: 16 * MB },
    "audio/ogg": { kind: "audio", maxBytes: 16 * MB },
    "audio/aac": { kind: "audio", maxBytes: 16 * MB },
    "video/mp4": { kind: "video", maxBytes: 16 * MB },
  },
  messenger: {
    "image/jpeg": { kind: "image", maxBytes: 25 * MB },
    "image/png": { kind: "image", maxBytes: 25 * MB },
    "image/gif": { kind: "image", maxBytes: 25 * MB },
    "audio/mpeg": { kind: "audio", maxBytes: 25 * MB },
    "audio/mp4": { kind: "audio", maxBytes: 25 * MB },
    "audio/aac": { kind: "audio", maxBytes: 25 * MB },
    "video/mp4": { kind: "video", maxBytes: 25 * MB },
    "application/pdf": { kind: "document", maxBytes: 25 * MB },
    [DOCX]: { kind: "document", maxBytes: 25 * MB },
    [XLSX]: { kind: "document", maxBytes: 25 * MB },
    "text/plain": { kind: "document", maxBytes: 25 * MB },
  },
  instagram: {
    "image/jpeg": { kind: "image", maxBytes: 8 * MB },
    "image/png": { kind: "image", maxBytes: 8 * MB },
    "audio/aac": { kind: "audio", maxBytes: 25 * MB },
    "audio/mp4": { kind: "audio", maxBytes: 25 * MB },
    "audio/wav": { kind: "audio", maxBytes: 25 * MB },
    "audio/x-wav": { kind: "audio", maxBytes: 25 * MB },
    "video/mp4": { kind: "video", maxBytes: 25 * MB },
    "video/quicktime": { kind: "video", maxBytes: 25 * MB },
    "video/webm": { kind: "video", maxBytes: 25 * MB },
    "application/pdf": { kind: "document", maxBytes: 25 * MB },
  },
};

const UPLOAD_CHANNEL_NAME = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" } as const;

/** The file picker's accept list for a channel. */
export function uploadAccept(channel: "whatsapp" | "messenger" | "instagram"): string {
  return Object.keys(UPLOAD_RULES[channel]).join(",");
}

/**
 * Why this file can't be sent on this channel, in plain words, or null when it
 * can. Runs in the composer before any upload, and mirrors the server's check.
 */
export function uploadProblem(
  channel: "whatsapp" | "messenger" | "instagram",
  file: { type: string; size: number },
): string | null {
  const name = UPLOAD_CHANNEL_NAME[channel];
  const rule = UPLOAD_RULES[channel][file.type];
  if (channel === "instagram" && file.type.startsWith("image/") && (!rule || file.size > rule.maxBytes)) {
    return "Instagram only takes JPEG or PNG pictures up to 8 MB.";
  }
  if (!rule) return `${name} can't send this kind of file.`;
  if (file.size <= 0 || file.size > rule.maxBytes) {
    return `This file is too large for ${name} (limit ${Math.round(rule.maxBytes / MB)} MB).`;
  }
  return null;
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
    // Messenger and Instagram (suite spec 02).
    case "share":
      return "Shared a post";
    case "story_mention":
      return "Mentioned you in their story";
    case "reaction":
      return "Reacted to a message";
    case "interactive":
      return "Tapped a button";
    case "referral":
      return "Opened the chat";
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
  // Comments on Facebook and Instagram posts (suite spec 03): `id` is the thread's root comment.
  "comment.created",
  "comment.updated",
] as const;
export type InboxEventName = (typeof INBOX_EVENTS)[number];
