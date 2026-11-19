/**
 * Pure helpers for the unified inbox UI (no React, no fetch) so they can be
 * unit-tested: list tabs per capability, timeline day grouping, reconnect
 * backoff, template variables, and the small label/format helpers.
 */
import { TEXT_LIMIT, headerMediaLabel, uploadAccept, type TemplateHeaderMedia, type TemplateNeeds } from "@ms/shared";
import type {
  CallOutcome,
  Channels,
  ChannelKind,
  IdentityChannel,
  IdentityRow,
  MessageStatus,
  TimelineItem,
  TimelinePage,
} from "./inbox-types.js";

/** Business time zone; staff are in Nigeria. */
export const INBOX_TZ = "Africa/Lagos";

// ── List tabs ────────────────────────────────────────────────────────────────

export type InboxTabKey = "mine" | "unassigned" | "team" | "all" | "closed";

export interface InboxTab {
  key: InboxTabKey;
  label: string;
  status: "open" | "closed";
  view: "mine" | "unassigned" | "team" | "all";
}

/**
 * Which list tabs make sense for this person. Everyone with inbox access sees
 * their own work, the unassigned queue and closed chats. "Team" needs team
 * membership plus a team/all view; "All open" only adds anything for people
 * who can see beyond their own and unassigned work.
 */
export function inboxTabsFor(caps: readonly string[], teamIds: readonly string[]): InboxTab[] {
  const wide = caps.includes("inbox.view_all") || caps.includes("inbox.view_team");
  const tabs: InboxTab[] = [
    { key: "mine", label: "Mine", status: "open", view: "mine" },
    { key: "unassigned", label: "Unassigned", status: "open", view: "unassigned" },
  ];
  if (wide && teamIds.length > 0) tabs.push({ key: "team", label: "Team", status: "open", view: "team" });
  if (wide) tabs.push({ key: "all", label: "All open", status: "open", view: "all" });
  tabs.push({ key: "closed", label: "Closed", status: "closed", view: "all" });
  return tabs;
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

// ── Timeline paging ──────────────────────────────────────────────────────────

/** Everything loaded so far for one conversation, oldest → newest. */
export interface LoadedTimeline {
  items: TimelineItem[];
  /** True when there are older items on the server than the oldest one loaded. */
  hasMore: boolean;
  /** `before` cursor for the next "Load earlier messages". */
  nextBefore: string | null;
}

/** Stable identity of a timeline item (ids are only unique per kind). */
export function timelineKey(item: TimelineItem): string {
  return `${item.kind}:${item.data.id}`;
}

function sortedUnique(items: readonly TimelineItem[]): TimelineItem[] {
  // Later entries win, so callers put the fresher copy last.
  const byKey = new Map<string, TimelineItem>();
  for (const it of items) byKey.set(timelineKey(it), it);
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at) || timelineKey(a).localeCompare(timelineKey(b)));
}

/**
 * Fold a fresh "newest" page (first load or a live refetch) into what is
 * already loaded, so earlier pages the person fetched are kept.
 *
 *  - The fresh page is the truth for the stretch of time it covers: loaded
 *    items inside that stretch that the server no longer returns (a deleted
 *    note, say) are dropped; everything in the page replaces the older copy.
 *  - If the page reports nothing older (`has_more: false`) it IS the whole
 *    timeline, so it replaces everything.
 *  - If so much arrived that the page no longer touches what was loaded, the
 *    loaded items are dropped rather than showing a silent gap in the chat.
 */
export function applyNewestPage(prev: LoadedTimeline | undefined, page: TimelinePage): LoadedTimeline {
  const fresh: LoadedTimeline = { items: sortedUnique(page.data), hasMore: page.has_more, nextBefore: page.next_before };
  if (!prev || prev.items.length === 0 || !page.has_more || fresh.items.length === 0) return fresh;
  const pageStart = fresh.items[0]!.at;
  const prevNewest = prev.items[prev.items.length - 1]!.at;
  if (pageStart > prevNewest) return fresh;
  const older = prev.items.filter((it) => it.at <= pageStart);
  // Nothing loaded reaches back past this page: the page's own cursor applies.
  if (older.length === 0 || prev.items[0]!.at >= pageStart) {
    return { ...fresh, items: sortedUnique([...older, ...fresh.items]) };
  }
  return { items: sortedUnique([...older, ...fresh.items]), hasMore: prev.hasMore, nextBefore: prev.nextBefore };
}

/** Put an older page (from "Load earlier messages") in front of what is loaded. */
export function applyEarlierPage(prev: LoadedTimeline | undefined, page: TimelinePage): LoadedTimeline {
  return {
    // Loaded items go last so they win over a stale duplicate in the older page.
    items: sortedUnique([...page.data, ...(prev?.items ?? [])]),
    hasMore: page.has_more,
    nextBefore: page.next_before,
  };
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

/**
 * Tick marks for an outgoing message. Instagram has no "delivered" state
 * (spec 02, 3.6): one tick when sent, blue double ticks when read.
 */
export function messageTicks(status: MessageStatus, channel?: IdentityChannel): { marks: string; read: boolean; label: string } {
  if (channel === "instagram" && status === "delivered") return { marks: "✓", read: false, label: "Sent" };
  switch (status) {
    case "queued":
      return { marks: "🕓", read: false, label: "Sending" };
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

export type SendProblem = "failed" | "unconfirmed" | null;

/**
 * What went wrong with a message, if anything. "unconfirmed" = we never heard
 * back from WhatsApp, so it may have reached the customer (amber, not red).
 */
export function sendProblem(m: { status: MessageStatus; unconfirmed?: boolean | null }): SendProblem {
  if (m.status !== "failed") return null;
  return m.unconfirmed ? "unconfirmed" : "failed";
}

export const UNCONFIRMED_TEXT = "Not confirmed — it may have been delivered. Check with the customer before sending again.";

/** Digits only, for comparing phone numbers typed with spaces, dashes or a +. */
export function phoneDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** The typed number matches the customer's (ignoring spaces, dashes and "+"). */
export function phoneConfirmMatches(typed: string, phone: string | null | undefined): boolean {
  const want = phoneDigits(phone);
  return want.length > 0 && phoneDigits(typed) === want;
}

// ── Greeting recordings ──────────────────────────────────────────────────────

export const GREETING_MAX_BYTES = 5 * 1024 * 1024;
export type GreetingContentType = "audio/mpeg" | "audio/wav" | "audio/x-wav";

/**
 * The content type to upload a greeting as, or null when it isn't MP3/WAV.
 * Browsers disagree ("audio/mp3", "audio/wave", or nothing at all), so fall
 * back to the file extension.
 */
export function greetingContentType(filename: string, type: string): GreetingContentType | null {
  const t = type.toLowerCase().split(";")[0]!.trim();
  if (t === "audio/mpeg" || t === "audio/mp3") return "audio/mpeg";
  if (t === "audio/x-wav") return "audio/x-wav";
  if (t === "audio/wav" || t === "audio/wave" || t === "audio/vnd.wave") return "audio/wav";
  if (t && t !== "application/octet-stream") return null;
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  return null;
}

/** Why this file can't be used as a greeting, in plain English, or null. */
export function greetingFileProblem(f: { name: string; type: string; size: number }): string | null {
  if (!greetingContentType(f.name, f.type)) return "Use an MP3 or WAV file.";
  if (f.size <= 0) return "That file is empty.";
  if (f.size > GREETING_MAX_BYTES) return "That recording is too big. Keep it under 5 MB.";
  return null;
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

/** What staff have filled in so far for a template. */
export interface TemplateDraft {
  /** Body blanks, in order. */
  params: readonly string[];
  /** The blank in a text heading. */
  headerParam: string;
  /** The end of each link button's link, keyed by the button's position. */
  buttonParams: Readonly<Record<number, string>>;
  /** Is a file chosen for the heading? */
  hasFile: boolean;
}

/**
 * The first thing still missing before a template can be sent, in plain
 * words, or null when everything is there. Send stays disabled until null.
 */
export function templateDraftProblem(needs: TemplateNeeds, draft: TemplateDraft): string | null {
  if (!needs.sendable) return needs.reason ?? "This template can't be sent from the inbox yet";
  if (needs.headerMedia && !draft.hasFile) return `Add a ${headerMediaLabel(needs.headerMedia)} to send this template.`;
  if (needs.headerParams > 0 && !draft.headerParam.trim()) return "Fill in the blank in the heading.";
  if (!templateParamsComplete(draft.params, needs.bodyParams)) return "Fill in every blank in the message.";
  const button = needs.urlButtons.find((b) => !(draft.buttonParams[b.index] ?? "").trim());
  if (button) return `Fill in the end of the link for the "${button.text}" button.`;
  return null;
}

/** What may be attached for each kind of template heading (mirrors the server's upload rules). */
const HEADER_FILE_RULES: Record<TemplateHeaderMedia, { types: readonly string[]; maxMb: number; accept: string; hint: string }> = {
  image: { types: ["image/jpeg", "image/png"], maxMb: 5, accept: "image/jpeg,image/png", hint: "JPG or PNG, up to 5 MB" },
  video: { types: ["video/mp4"], maxMb: 16, accept: "video/mp4", hint: "MP4, up to 16 MB" },
  document: { types: ["application/pdf"], maxMb: 16, accept: "application/pdf", hint: "PDF, up to 16 MB" },
};

export function headerFileRule(kind: TemplateHeaderMedia): { accept: string; hint: string } {
  const { accept, hint } = HEADER_FILE_RULES[kind];
  return { accept, hint };
}

/** Why this file can't be the template's picture/video/document, or null when it can. */
export function headerFileProblem(kind: TemplateHeaderMedia, f: { type: string; size: number }): string | null {
  const rule = HEADER_FILE_RULES[kind];
  if (!rule.types.includes(f.type)) return `This template needs a ${headerMediaLabel(kind)} (${rule.hint}).`;
  if (f.size > rule.maxMb * 1024 * 1024) return `That file is too large. Use a ${headerMediaLabel(kind)} of ${rule.maxMb} MB or less.`;
  if (f.size <= 0) return "That file is empty.";
  return null;
}

/** "Add picture" / "Add video" / "Add document". */
export function addHeaderFileLabel(kind: TemplateHeaderMedia): string {
  return `Add ${headerMediaLabel(kind)}`;
}

/** How many things staff type in for this template (message, heading and link blanks). */
export function templateBlankCount(needs: TemplateNeeds): number {
  return needs.bodyParams + needs.headerParams + needs.urlButtons.length;
}

/** A link button's address with its blank filled, for the preview. */
export function fillButtonUrl(url: string, value: string): string {
  return url.replace(/\{\{\s*1\s*\}\}/g, value.trim() || "…");
}

// ── Automatic messages ───────────────────────────────────────────────────────

/**
 * Label for a message no member of staff sent. "after_hours" is the reply to
 * customers who write when closed; anything else (e.g. the missed-call
 * follow-up) is an automatic message. Null for messages a person sent.
 */
export function autoMessageLabel(auto: string | null | undefined): string | null {
  if (!auto) return null;
  return auto === "after_hours" ? "Automatic reply" : "Automatic message";
}

/** Help text under the number form's after-hours message, for the channels the number uses. */
export function afterHoursHelp(channels: "voice" | "whatsapp" | "both"): string {
  const wa = "Sent automatically on WhatsApp to a customer who writes when you're closed (once per closed period)";
  if (channels === "whatsapp") return `${wa}.`;
  if (channels === "voice") return "Read out to callers who ring when you're closed.";
  return `${wa}, and read out to callers who ring when you're closed.`;
}

// ── Typing indicator ─────────────────────────────────────────────────────────

/** Throttle for POST /typing: at most once per `intervalMs` while the user types. */
export function shouldSendTyping(lastSentAt: number | null, now: number, intervalMs = 3000): boolean {
  return lastSentAt === null || now - lastSentAt >= intervalMs;
}

/**
 * Display name for a customer row: their name, else their phone, else what
 * Meta calls them on the channel (`fallback`: a Facebook name or "@username"),
 * else "Unknown customer".
 */
export function contactName(
  name: string | null | undefined,
  phone: string | null | undefined,
  fallback?: string | null,
): string {
  const n = name?.trim();
  if (n) return n;
  return prettyPhone(phone) || fallback?.trim() || "Unknown customer";
}

type IdentityLike = Pick<IdentityRow, "channel" | "display_name" | "username" | "phone">;

/** What Meta calls the customer on a thread: their display name, else "@username". */
export function identityName(i: { display_name: string | null; username: string | null } | null | undefined): string | null {
  if (!i) return null;
  return i.display_name?.trim() || (i.username?.trim() ? `@${i.username.trim()}` : null);
}

/** A short handle for an identity: "@username", else its display name, else its phone. */
export function identityHandle(i: IdentityLike): string | null {
  if (i.username?.trim()) return `@${i.username.trim()}`;
  if (i.display_name?.trim()) return i.display_name.trim();
  return i.phone ? prettyPhone(i.phone) : null;
}

/** The first handle among a contact's identities, for the heading when the contact has no name or phone. */
export function firstIdentityHandle(identities: readonly IdentityLike[] | null | undefined): string | null {
  for (const i of identities ?? []) {
    const h = identityHandle(i);
    if (h) return h;
  }
  return null;
}

/** The main text of a "Reaches you on" line (spec 01, 7.4). */
export function identityLine(i: IdentityLike & Pick<IdentityRow, "account_label">): string {
  switch (i.channel) {
    case "whatsapp":
      if (i.phone) return prettyPhone(i.phone);
      return `WhatsApp (number hidden)${i.username ? ` · @${i.username}` : ""}`;
    case "messenger":
      return `${i.display_name ?? "Facebook user"} · ${i.account_label}`;
    case "instagram":
      return `${i.username ? `@${i.username}` : (i.display_name ?? "Instagram user")} · ${i.account_label}`;
  }
}

export interface EraseTarget {
  kind: "phone" | "username" | "name" | "word";
  /** What the person must type (a username is shown with "@"). */
  show: string;
}

/**
 * What a person must type to erase a contact (rule R10, checked again on the
 * server): the phone if there is one; else the first username; else the name;
 * else the word DELETE.
 */
export function eraseConfirmTarget(
  customer: { name: string | null; phone: string | null },
  identities: readonly Pick<IdentityRow, "username">[] | null | undefined,
): EraseTarget {
  if (phoneDigits(customer.phone)) return { kind: "phone", show: prettyPhone(customer.phone) };
  const username = (identities ?? []).map((i) => i.username?.trim().replace(/^@/, "")).find((u) => !!u);
  if (username) return { kind: "username", show: `@${username}` };
  if (customer.name?.trim()) return { kind: "name", show: customer.name.trim() };
  return { kind: "word", show: "DELETE" };
}

/** Does what was typed match the erase target? */
export function eraseConfirmMatches(typed: string, target: EraseTarget, phone?: string | null): boolean {
  switch (target.kind) {
    case "phone":
      return phoneConfirmMatches(typed, phone ?? target.show);
    case "username":
      return typed.trim().replace(/^@/, "").toLowerCase() === target.show.replace(/^@/, "").toLowerCase();
    case "name":
      return typed.trim().toLowerCase() === target.show.toLowerCase();
    case "word":
      return typed === "DELETE";
  }
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
  /** Uploaded recording played instead of reading `play_text` out. */
  audio_key?: string | null;
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
    if (o.action === "play" && !o.play_text?.trim() && !o.audio_key) {
      return `Key ${o.digit}: add the message to read out, or upload a recording.`;
    }
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

// ── Display helpers (wording only; nothing here changes what is stored) ──────

/**
 * A readable phone number: "+2349033330003" → "+234 903 333 0003",
 * "08031234567" → "0803 123 4567". Anything that isn't a plain number comes
 * back unchanged.
 */
export function prettyPhone(phone: string | null | undefined): string {
  const raw = phone?.trim() ?? "";
  if (!raw) return "";
  const compact = raw.replace(/[\s().-]/g, "");
  if (!/^\+?\d{7,15}$/.test(compact)) return raw;
  const plus = compact.startsWith("+");
  const d = plus ? compact.slice(1) : compact;
  const tail = (s: string): string => `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}`;
  if (plus && d.length > 10) return `+${d.slice(0, d.length - 10)} ${tail(d.slice(-10))}`;
  if (!plus && d.length === 13 && d.startsWith("234")) return `+234 ${tail(d.slice(3))}`;
  if (!plus && d.length === 11 && d.startsWith("0")) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return raw;
}

/**
 * Name to show for a member of staff. People without a display name come back
 * from the server as their email; show the part before the @ instead.
 */
export function staffLabel(name: string | null | undefined, fallback = "Staff"): string {
  const n = name?.trim();
  if (!n) return fallback;
  if (/^[^\s@]+@[^\s@]+$/.test(n)) return n.slice(0, n.indexOf("@"));
  return n;
}

/** "2026-12-25" → "25 Dec 2026". Anything else comes back unchanged. */
export function humanDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(day)) return day;
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

/** "missed_call_followup" → "Missed call follow-up". */
export function humanTemplateName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim().replace(/\bfollowup\b/gi, "follow-up").replace(/\bwhatsapp\b/gi, "WhatsApp");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** "en" → "English", "en_US" → "American English". Unknown codes come back unchanged. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code.replace(/_/g, "-"));
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

const TEMPLATE_CATEGORY: Record<string, string> = {
  UTILITY: "Service update",
  MARKETING: "Marketing",
  AUTHENTICATION: "Login code",
};

/** WhatsApp's template category in plain words. */
export function templateCategoryLabel(category: string | null | undefined): string {
  const c = (category ?? "").trim();
  if (!c) return "Not set";
  return TEMPLATE_CATEGORY[c.toUpperCase()] ?? sentenceCase(c);
}

/** "owner" → "Owner", "branch_manager" → "Branch manager". */
export function sentenceCase(value: string): string {
  const s = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : value;
}

/** WhatsApp's messaging limit ("TIER_1K") as a sentence staff can read. */
export function messagingLimitLabel(limit: string | null | undefined): string | null {
  const v = (limit ?? "").trim().toUpperCase();
  if (!v) return null;
  if (v.includes("UNLIMITED")) return "No daily limit on new chats";
  const m = /(\d+(?:\.\d+)?)\s*(K|M)?$/.exec(v.replace(/_/g, ""));
  if (!m) return `Limit: ${sentenceCase(v).toLowerCase()}`;
  const n = Number(m[1]) * (m[2] === "K" ? 1000 : m[2] === "M" ? 1_000_000 : 1);
  return `Up to ${n.toLocaleString("en-NG")} new chats a day`;
}

/** Empty-list wording that fits the tab the person is on. */
export function emptyListText(tab: InboxTabKey, searching: boolean): { title: string; hint: string } {
  if (searching) return { title: "No matches", hint: "Nobody matches that name or number." };
  switch (tab) {
    case "mine":
      return { title: "Nothing assigned to you", hint: "Chats you take or are given show here." };
    case "unassigned":
      return { title: "Nothing waiting", hint: "New chats nobody has taken yet show here." };
    case "team":
      return { title: "No open team chats", hint: "Open chats for your team show here." };
    case "closed":
      return { title: "No closed chats yet", hint: "Chats you close are kept here." };
    default:
      return { title: "No open chats", hint: "Every open chat shows here." };
  }
}

/** Up to `max` evenly spaced days, always ending on the last one, for a shared chart axis. */
export function axisDays(days: readonly string[], max = 6): string[] {
  if (days.length <= max) return [...days];
  const step = Math.ceil((days.length - 1) / (max - 1));
  const out: string[] = [];
  for (let i = days.length - 1; i >= 0; i -= step) out.unshift(days[i]!);
  return out;
}

// ── New-message alerts ───────────────────────────────────────────────────────

export interface AlertContext {
  /** The signed-in staff member. */
  userId: string;
  /** Their saved choice: every chat they can see, their own and unassigned ones, or none. */
  level: "all" | "assigned" | "none";
  /** The conversation open on screen, if any. */
  openConversationId: string | null;
  /** Is this tab on screen and in front? */
  tabActive: boolean;
}

/**
 * Should a live event sound and show an alert for this person?
 *
 * Only a customer's message alerts. The server has already checked that this
 * person may see the conversation. "assigned" means their own chats plus ones
 * nobody has picked up yet, so a new customer is never met with silence.
 * Nothing fires for the chat they are already reading.
 */
export function shouldAlertForEvent(
  e: { event: string; direction?: "in" | "out"; conversationId?: string; assigneeId?: string | null },
  ctx: AlertContext,
): boolean {
  if (e.event !== "message.created" || e.direction !== "in" || !e.conversationId) return false;
  if (ctx.level === "none") return false;
  if (ctx.level === "assigned" && e.assigneeId && e.assigneeId !== ctx.userId) return false;
  if (ctx.tabActive && ctx.openConversationId === e.conversationId) return false;
  return true;
}

/** Tab title while messages are waiting: "(3) Inbox" style, so a pinned tab still shows it. */
export function titleWithCount(baseTitle: string, waiting: number): string {
  const clean = baseTitle.replace(/^\(\d+\+?\)\s+/, "");
  if (waiting <= 0) return clean;
  return `(${waiting > 99 ? "99+" : waiting}) ${clean}`;
}

/** The conversation id in an inbox address, e.g. /inbox/1234 → "1234". */
export function conversationIdFromPath(pathname: string): string | null {
  const m = /^\/inbox\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  return m[1] === "reports" || m[1] === "settings" ? null : m[1]!;
}

// ── Reply box per channel (suite spec 02, 7.3) ──────────────────────────────

/** The plain name of a channel, as staff see it in sentences. */
export function channelName(channel: IdentityChannel): "WhatsApp" | "Messenger" | "Instagram" {
  return channel === "whatsapp" ? "WhatsApp" : channel === "messenger" ? "Messenger" : "Instagram";
}

/** What the composer needs to know about a conversation. */
export interface ReplyStateInput {
  channel?: IdentityChannel;
  number: { label: string; channels: Channels; kind?: ChannelKind; is_active?: boolean; problem_text?: string | null } | null;
  window_remaining_ms: number;
  human_agent_remaining_ms?: number;
  human_agent_enabled?: boolean;
}

export interface ReplyState {
  channel: IdentityChannel;
  mode: "open" | "human_agent" | "closed" | "calls_only" | "off";
  /** "WhatsApp reply" | "Messenger reply" | "Instagram reply". */
  tabLabel: string;
  statusText: string;
  canTemplate: boolean;
  canCaption: boolean;
  textLimit: { max: number; unit: "characters" | "bytes" };
  /** The file picker's accept list. */
  accept: string;
  /** Red banner above the box: messages on this line are not going out. */
  banner: string | null;
  /** In the closed notice: "24 hours", or "7 days" with Human Agent on. */
  closedWindow: "24 hours" | "7 days";
}

/** The attach button's list on WhatsApp, unchanged from before spec 02. */
export const WHATSAPP_ACCEPT = "image/*,audio/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the composer shows for a conversation's channel and reply
 * window, so the rules are tested without React. WhatsApp behaves exactly as
 * before; Messenger and Instagram follow spec 02 table 7.3.
 */
export function replyState(conv: ReplyStateInput): ReplyState {
  const channel: IdentityChannel = conv.channel ?? "whatsapp";
  const name = channelName(channel);
  const label = conv.number?.label ?? name;
  const win = windowText(conv.window_remaining_ms);
  const base = {
    channel,
    tabLabel: `${name} reply`,
    textLimit: TEXT_LIMIT[channel],
    banner: null as string | null,
    closedWindow: "24 hours" as const,
  };

  if (channel === "whatsapp") {
    const callsOnly = !conv.number || conv.number.channels === "voice" || (conv.number.kind ?? "phone") !== "phone";
    return {
      ...base,
      mode: callsOnly ? "calls_only" : win.open ? "open" : "closed",
      statusText: win.text,
      canTemplate: true,
      canCaption: true,
      accept: WHATSAPP_ACCEPT,
    };
  }

  const meta = {
    ...base,
    canTemplate: false,
    canCaption: false,
    accept: uploadAccept(channel),
    banner: conv.number?.problem_text ? `Messages on ${label} are not going out: ${conv.number.problem_text}` : null,
    closedWindow: (conv.human_agent_enabled ? "7 days" : "24 hours") as "24 hours" | "7 days",
  };
  if (conv.number?.is_active === false) {
    return { ...meta, mode: "off", statusText: `${label} is switched off, so replies can't be sent. Switch it on under Channels.` };
  }
  if (win.open) return { ...meta, mode: "open", statusText: win.text };
  const agentMs = conv.human_agent_remaining_ms ?? 0;
  if (conv.human_agent_enabled && agentMs > 0) {
    const days = Math.max(1, Math.ceil(agentMs / DAY_MS));
    return {
      ...meta,
      mode: "human_agent",
      statusText: `More than 24 hours since they wrote. You can still reply for ${days} more ${days === 1 ? "day" : "days"}, by hand only.`,
    };
  }
  return { ...meta, mode: "closed", statusText: "Reply window closed" };
}

/** The live byte or character count for the Instagram counter, and whether it is over the limit. */
export function textUsage(text: string, limit: { max: number; unit: "characters" | "bytes" }): { used: number; over: boolean } {
  const used = limit.unit === "bytes" ? new TextEncoder().encode(text).length : [...text].length;
  return { used, over: used > limit.max };
}
