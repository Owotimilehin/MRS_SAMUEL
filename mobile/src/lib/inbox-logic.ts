/**
 * Pure helpers for the mobile inbox (no React, no fetch), unit-tested in
 * inbox-logic.test.ts.
 *
 * COPIED from apps/admin/src/lib/inbox-logic.ts (the mobile app is outside the
 * pnpm workspace and can't import @ms/* or the admin app). Mobile changes:
 *   - list tabs are Mine / Unassigned / Team / All (closed chats via a toggle)
 *   - waWindowRemainingMs / WA_WINDOW_MS copied from packages/shared/src/inbox.ts
 *   - messageTicks uses plain glyphs (no emoji) for the queued state
 * Keep in step with those files when the rules change.
 */
import type { CallOutcome, MessageStatus, TimelineItem } from "./inbox-types";

/** Business time zone; staff are in Nigeria. */
export const INBOX_TZ = "Africa/Lagos";

// ── List tabs ────────────────────────────────────────────────────────────────

export type InboxTabKey = "mine" | "unassigned" | "team" | "all";

export interface InboxTab {
  key: InboxTabKey;
  label: string;
}

/**
 * Which list tabs make sense for this person. Everyone with inbox access sees
 * their own work and the unassigned queue. "Team" needs team membership plus a
 * team/all view; "All" only adds anything for people who can see beyond their
 * own and unassigned work. (Admin web also has a "Closed" tab; on mobile closed
 * chats are a toggle above the list, so the tab key is always the API `view`.)
 */
export function inboxTabsFor(caps: readonly string[], teamIds: readonly string[]): InboxTab[] {
  const wide = caps.includes("inbox.view_all") || caps.includes("inbox.view_team");
  const tabs: InboxTab[] = [
    { key: "mine", label: "Mine" },
    { key: "unassigned", label: "Unassigned" },
  ];
  if (wide && teamIds.length > 0) tabs.push({ key: "team", label: "Team" });
  if (wide) tabs.push({ key: "all", label: "All" });
  return tabs;
}

// ── WhatsApp 24-hour window (copied from packages/shared/src/inbox.ts) ───────

/** WhatsApp's customer-service window: free-form replies only within 24h. */
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Milliseconds left in the window (0 when closed). */
export function waWindowRemainingMs(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (!lastInboundAt) return 0;
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t + WA_WINDOW_MS - now.getTime());
}

/** The composer's state for a conversation. Mobile-only. */
export type ComposerMode =
  | { kind: "text" }
  | { kind: "template_only"; reason: string }
  | { kind: "disabled"; reason: string };

export function composerMode(args: {
  caps: readonly string[];
  canUseNumber: boolean;
  channels: "voice" | "whatsapp" | "both" | null | undefined;
  windowRemainingMs: number;
}): ComposerMode {
  if (!args.caps.includes("inbox.reply")) return { kind: "disabled", reason: "You can read this chat but not reply." };
  if (!args.canUseNumber) return { kind: "disabled", reason: "You can't reply from this business number." };
  if (args.channels === "voice") return { kind: "disabled", reason: "This business number is for calls only." };
  if (args.windowRemainingMs > 0) return { kind: "text" };
  if (args.caps.includes("inbox.templates")) {
    return { kind: "template_only", reason: "The 24-hour reply window is closed. Send a template to restart the chat." };
  }
  return { kind: "disabled", reason: "The 24-hour reply window is closed and you can't send templates." };
}

// ── Push notification payload (mobile-only) ──────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation a tapped push should open, from `data.conversationId` (see apps/worker/src/jobs/inbox-push.ts). */
export function conversationIdFromPush(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const id = (data as { conversationId?: unknown }).conversationId;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}

/** When to refresh the Twilio voice token: 5 minutes before expiry, never sooner than 30s. Mobile-only. */
export function tokenRefreshDelayMs(ttlSeconds: number): number {
  return Math.max(30_000, (ttlSeconds - 5 * 60) * 1000);
}

// ── Reconnect backoff ────────────────────────────────────────────────────────

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential from `baseMs`,
 * capped at `maxMs`, with jitter in [50%, 100%] so many phones reconnecting
 * after a server restart don't all hit it at the same instant.
 */
export function backoffDelay(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number } = {},
  rand: () => number = Math.random,
): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30_000;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(exp * (0.5 + rand() * 0.5));
}

// ── Dates and times ──────────────────────────────────────────────────────────

/** YYYY-MM-DD of `d` in Lagos. */
export function lagosDayKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INBOX_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Today", "Yesterday", or e.g. "Mon 3 Nov" (year added when not this year). */
export function dayLabel(key: string, now: Date = new Date()): string {
  const today = lagosDayKey(now);
  if (key === today) return "Today";
  if (key === shiftDay(today, -1)) return "Yesterday";
  const d = new Date(`${key}T12:00:00Z`);
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: INBOX_TZ, hour: "2-digit", minute: "2-digit" });
}

/** Compact list timestamp: time today, "Yesterday", weekday this week, else date. */
export function listTime(iso: string, now: Date = new Date()): string {
  const key = lagosDayKey(iso);
  const today = lagosDayKey(now);
  if (key === today) return timeOfDay(iso);
  if (key === shiftDay(today, -1)) return "Yesterday";
  const ageDays = (now.getTime() - new Date(iso).getTime()) / 86_400_000;
  const d = new Date(`${key}T12:00:00Z`);
  if (ageDays < 6) return d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short" });
  return d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
}

export interface TimelineDay {
  key: string;
  label: string;
  items: TimelineItem[];
}

/** Split a time-ordered timeline into Lagos calendar days, oldest first. */
export function groupTimelineByDay(items: readonly TimelineItem[], now: Date = new Date()): TimelineDay[] {
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  const days: TimelineDay[] = [];
  for (const item of sorted) {
    const key = lagosDayKey(item.at);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(key, now), items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}

/** "45s", "2m 05s", "1h 02m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

/** Reply-window text for the composer. */
export function windowText(remainingMs: number): { open: boolean; text: string } {
  if (remainingMs <= 0) {
    return { open: false, text: "The 24-hour reply window is closed. Send a template to restart the chat." };
  }
  const mins = Math.floor(remainingMs / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const left = h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  return { open: true, text: `Reply window open — ${left} left` };
}

// ── Messages and calls ───────────────────────────────────────────────────────

/** Tick marks for an outgoing message. */
export function messageTicks(status: MessageStatus): { marks: string; read: boolean; label: string } {
  switch (status) {
    case "queued":
      return { marks: "…", read: false, label: "Sending" };
    case "sent":
      return { marks: "✓", read: false, label: "Sent" };
    case "delivered":
      return { marks: "✓✓", read: false, label: "Delivered" };
    case "read":
      return { marks: "✓✓", read: true, label: "Read" };
    case "failed":
      return { marks: "!", read: false, label: "Not sent" };
    default:
      return { marks: "", read: false, label: "" };
  }
}

export function callOutcomeLabel(outcome: CallOutcome, direction: "in" | "out"): string {
  switch (outcome) {
    case "in_progress":
      return "In progress";
    case "answered":
      return direction === "in" ? "Answered" : "Connected";
    case "missed":
      return direction === "in" ? "Missed call" : "No answer";
    case "voicemail":
      return "Voicemail left";
    case "after_hours":
      return "After hours";
    case "failed":
      return "Call failed";
  }
}

export type MediaKind = "image" | "audio" | "video" | "document";

export function mediaKind(type: string, mime: string | null): MediaKind {
  const m = (mime ?? "").toLowerCase();
  if (type === "image" || type === "sticker" || m.startsWith("image/")) return "image";
  if (type === "audio" || m.startsWith("audio/")) return "audio";
  if (type === "video" || m.startsWith("video/")) return "video";
  return "document";
}

/** Map a browser File type to the WhatsApp message type we send it as. */
export function sendTypeForMime(mime: string): "image" | "audio" | "video" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** "VIP, delivery , vip" → ["vip", "delivery"]. Mirrors the server's lowercase + dedupe. */
export function parseLabels(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const l = raw.trim().toLowerCase().slice(0, 40);
    if (l && !out.includes(l)) out.push(l);
  }
  return out.slice(0, 20);
}

// ── Templates ────────────────────────────────────────────────────────────────

/** The BODY text of a WhatsApp template's components, or null. */
export function templateBodyText(components: readonly unknown[] | null | undefined): string | null {
  const body = (components ?? []).find(
    (c): c is { type: string; text?: string } =>
      typeof c === "object" && c !== null && String((c as { type?: unknown }).type).toUpperCase() === "BODY",
  );
  return body?.text ?? null;
}

/** Highest {{n}} in the body (WhatsApp numbers variables from 1). */
export function countTemplateParams(components: readonly unknown[] | null | undefined): number {
  const text = templateBodyText(components) ?? "";
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** Fill {{1}}, {{2}}… with params; unfilled ones stay as "{{n}}" so the preview shows the gap. */
export function fillTemplate(text: string, params: readonly string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (m, n: string) => {
    const v = params[Number(n) - 1];
    return v && v.trim() ? v : m;
  });
}

/** Every variable has a non-blank value. */
export function templateParamsComplete(params: readonly string[], count: number): boolean {
  if (count === 0) return true;
  if (params.length < count) return false;
  return params.slice(0, count).every((p) => p.trim().length > 0);
}

// ── Typing indicator ─────────────────────────────────────────────────────────

/** Throttle for POST /typing: at most once per `intervalMs` while the user types. */
export function shouldSendTyping(lastSentAt: number | null, now: number, intervalMs = 3000): boolean {
  return lastSentAt === null || now - lastSentAt >= intervalMs;
}

/** Display name for a customer row. */
export function contactName(name: string | null | undefined, phone: string | null | undefined): string {
  const n = name?.trim();
  if (n) return n;
  return phone?.trim() || "Unknown customer";
}

// ── Business hours editor ────────────────────────────────────────────────────

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface DayWindow {
  open: string;
  close: string;
}
/** Seven entries, Sunday first; an empty list = closed all day. */
export type WeekHours = DayWindow[][];

export function rulesToWeek(rules: ReadonlyArray<{ weekday: number; openTime: string; closeTime: string }>): WeekHours {
  const week: WeekHours = Array.from({ length: 7 }, () => []);
  for (const r of rules) {
    if (r.weekday >= 0 && r.weekday <= 6) week[r.weekday]!.push({ open: r.openTime, close: r.closeTime });
  }
  for (const day of week) day.sort((a, b) => a.open.localeCompare(b.open));
  return week;
}

export function weekToRules(week: WeekHours): Array<{ weekday: number; open_time: string; close_time: string }> {
  return week.flatMap((day, weekday) => day.map((w) => ({ weekday, open_time: w.open, close_time: w.close })));
}

const HHMM_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** First problem with the week, in plain English, or null when it's fine. */
export function validateWeek(week: WeekHours): string | null {
  for (let d = 0; d < 7; d++) {
    const day = [...(week[d] ?? [])].sort((a, b) => a.open.localeCompare(b.open));
    for (let i = 0; i < day.length; i++) {
      const w = day[i]!;
      if (!HHMM_RE.test(w.open) || !HHMM_RE.test(w.close)) return `${WEEKDAYS[d]}: use times like 08:00.`;
      if (w.close <= w.open) return `${WEEKDAYS[d]}: closing time must be after opening time.`;
      const prev = day[i - 1];
      if (prev && w.open < prev.close) return `${WEEKDAYS[d]}: two time slots overlap.`;
    }
  }
  return null;
}

// ── Phone menu editor ────────────────────────────────────────────────────────

export interface MenuOptionDraft {
  digit: string;
  label: string;
  action: "ring_team" | "voicemail" | "play";
  team_id: string | null;
  play_text: string | null;
}

/** Mirrors the server's checks so staff see the problem before saving. */
export function validateMenu(m: { name: string; greeting_text: string; options: readonly MenuOptionDraft[] }): string | null {
  if (!m.name.trim()) return "Give the menu a name.";
  if (!m.greeting_text.trim()) return "Add the greeting callers hear.";
  if (m.options.length > 10) return "A menu can have at most 10 options.";
  const seen = new Set<string>();
  for (const o of m.options) {
    if (!/^\d$/.test(o.digit)) return "Each option needs a single key from 0 to 9.";
    if (seen.has(o.digit)) return `Key ${o.digit} is used twice.`;
    seen.add(o.digit);
    if (!o.label.trim()) return `Key ${o.digit} needs a label.`;
    if (o.action === "ring_team" && !o.team_id) return `Key ${o.digit}: pick which team to ring.`;
    if (o.action === "play" && !o.play_text?.trim()) return `Key ${o.digit}: add the message to read out.`;
  }
  return null;
}

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * One row per calendar day from `from` to `to` (inclusive, YYYY-MM-DD), taking
 * values from `rows` keyed by `day` and zero-filling the gaps so a quiet day
 * shows as an empty bar instead of vanishing from the chart.
 */
export function fillDays<K extends string>(
  from: string,
  to: string,
  rows: ReadonlyArray<{ day: string } & Record<K, number>>,
  keys: readonly K[],
): Array<{ day: string } & Record<K, number>> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: Array<{ day: string } & Record<K, number>> = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return out;
  for (let day = from; day <= to && out.length < 400; day = shiftDay(day, 1)) {
    const src = byDay.get(day);
    const row = { day } as { day: string } & Record<K, number>;
    for (const k of keys) (row as Record<string, number | string>)[k] = src ? Number(src[k]) || 0 : 0;
    out.push(row);
  }
  return out;
}

/** "12m", "3h 20m", "2d 4h" for response-time tiles. */
export function formatSpan(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Lagos-calendar YYYY-MM-DD `days` before today. */
export function lagosDaysAgo(days: number, now: Date = new Date()): string {
  return shiftDay(lagosDayKey(now), -days);
}
