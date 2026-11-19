/**
 * Pure rules for the Leads screens (suite spec 13, section 7), kept apart from
 * React so they can be tested.
 */
import { dayLabel, lagosDayKey, timeOfDay } from "@admin/lib/inbox-logic.js";
import type { FollowUpBlock, LeadRow, LeadStatus, LostReason } from "./leads-api.js";

export const STATUS_ORDER: readonly LeadStatus[] = ["new", "contacted", "won", "lost"];

/** The status chip: its word and its colour class (a .pill modifier). */
export function statusChip(status: LeadStatus): { label: string; tone: "accent" | "warning" | "success" | "ink" } {
  switch (status) {
    case "new":
      return { label: "New", tone: "accent" };
    case "contacted":
      return { label: "Contacted", tone: "warning" };
    case "won":
      return { label: "Won", tone: "success" };
    case "lost":
    default:
      return { label: "Lost", tone: "ink" };
  }
}

/** The "Why?" choices when a lead is marked Lost, in the order shown. */
export const LOST_REASONS: readonly { value: LostReason; label: string }[] = [
  { value: "not_interested", label: "Not interested" },
  { value: "no_answer", label: "No answer" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "duplicate", label: "Already a lead" },
  { value: "test", label: "Test lead" },
  { value: "other", label: "Other" },
];

export function lostReasonLabel(reason: LostReason | null): string {
  return LOST_REASONS.find((r) => r.value === reason)?.label ?? "";
}

/** Why the follow-up button is switched off, shown under it. "Already sent" is not a block: the button reads "Send again". */
export function followUpBlockedText(code: FollowUpBlock | null): string | null {
  switch (code) {
    case "no_phone":
      return "No phone number was given.";
    case "no_consent":
      return "This form did not ask permission to message on WhatsApp. Call or email instead, or ask the owner to update the form's settings.";
    case "no_template":
      return "The “lead_followup” template is not approved yet. See Templates.";
    case "no_line":
      return "No WhatsApp number is set up.";
    case "no_permission":
      return "You need permission to send templates.";
    case "already_sent":
    case null:
    default:
      return null;
  }
}

/** The grey line under a lead's name: where it came from. */
export function rowSubLine(l: Pick<LeadRow, "form_name" | "ad_name" | "is_organic">): string {
  if (l.is_organic) return `${l.form_name} · Not from an advert`;
  return l.ad_name ? `${l.form_name} · from ${l.ad_name}` : l.form_name;
}

/** The drawer's advert line. */
export function advertLine(l: Pick<LeadRow, "ad_name" | "campaign_name" | "is_organic">): string | null {
  if (l.is_organic) return "Not from an advert";
  if (!l.ad_name && !l.campaign_name) return null;
  return `Advert: ${[l.ad_name, l.campaign_name].filter(Boolean).join(" · ")}`;
}

export function leadName(l: Pick<LeadRow, "full_name">): string {
  return l.full_name?.trim() || "No name given";
}

/** "Today 14:05", "Yesterday 09:30", "Mon 3 Nov 16:20" — always Lagos time. */
export function receivedLabel(iso: string, now: Date = new Date()): string {
  return `${dayLabel(lagosDayKey(iso), now)} ${timeOfDay(iso)}`;
}

/** A date with no time, in Lagos: "Today", "Mon 3 Nov". */
export function dateLabel(iso: string, now: Date = new Date()): string {
  return dayLabel(lagosDayKey(iso), now);
}

/** Win rate as a whole percentage, or "–" when nothing is closed yet. */
export function winRateText(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "–";
  return `${Math.round(rate * 100)}%`;
}

/** "12 min", "3 h 20 min", "2 days", or "–". */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "–";
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  return `${Math.round(m / 1440)} days`;
}

/** Up to two initials for the owner badge. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").split("@")[0]!.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** The amber "still being fetched" banner shows only when the oldest waiting lead is more than 10 minutes old. */
export function pendingIsSlow(p: { pending: number; oldest_pending_at: string | null }, now: Date = new Date()): boolean {
  if (p.pending <= 0 || !p.oldest_pending_at) return false;
  return now.getTime() - new Date(p.oldest_pending_at).getTime() > 10 * 60_000;
}

/** Which empty message the list shows. */
export function emptyMessage(o: { forms: number; filtered: boolean }): string {
  if (o.filtered) return "Nothing matches these filters.";
  if (o.forms === 0) return "No lead forms found yet. Create a form for your Page in Meta, then press Forms → Refresh forms.";
  return "No leads yet. When someone fills in a form you'll see them here and hear the new-message sound.";
}

/** Meta's form status in plain words. */
export function formStatusLabel(status: string | null): string {
  if (!status) return "";
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "Active";
  if (s === "ARCHIVED") return "Archived";
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

/** The line under "Fetch earlier leads". */
export function backfillLine(b: { requested_at: string | null; done_at: string | null; count: number; stopped: boolean }, now: Date = new Date()): string | null {
  if (!b.requested_at) return null;
  if (!b.done_at) return `Fetching… ${b.count} so far.`;
  if (b.stopped) return "Stopped: Meta would not let us read this form's leads.";
  return `Fetched ${b.count} earlier leads on ${plainDate(b.done_at, now)}.`;
}

/** "20 Nov" in Lagos, with the year when it is not this year. */
export function plainDate(iso: string, now: Date = new Date()): string {
  const sameYear = lagosDayKey(iso).slice(0, 4) === lagosDayKey(now).slice(0, 4);
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** YYYY-MM-DD `days` days before the Lagos day of `now` (0 = today). */
export function lagosDayAgo(days: number, now: Date = new Date()): string {
  const d = new Date(`${lagosDayKey(now)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Bar heights (0–100) for the per-day chart. */
export function barHeights(days: readonly { day: string; leads: number }[]): { day: string; leads: number; pct: number }[] {
  const max = Math.max(0, ...days.map((d) => d.leads));
  return days.map((d) => ({ ...d, pct: max > 0 ? Math.max(4, Math.round((d.leads / max) * 100)) : 0 }));
}
