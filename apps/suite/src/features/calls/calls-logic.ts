/** Pure helpers for the Calls page: periods, wording and the busiest-times grid. Tests beside this file. */

export type CallPeriod = "today" | "7" | "30" | "90";

export const PERIODS: { key: CallPeriod; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
];

/** Today's date in Lagos as YYYY-MM-DD. */
export function lagosToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shift(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** The Lagos days a period covers, both ends included. "7 days" = today and the six before it. */
export function periodRange(p: CallPeriod, now: Date = new Date()): { from: string; to: string } {
  const to = lagosToday(now);
  if (p === "today") return { from: to, to };
  return { from: shift(to, -(Number(p) - 1)), to };
}

/** "62%", or "—" when there is nothing to divide by. */
export function percent(part: number, whole: number): string {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** How long ago, in the words people use: "just now", "12 min ago", "3 h ago", "2 days ago". */
export function waitingFor(iso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** "18s", "4 min", "2 h 10 min": for averages and waits. */
export function shortDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** Total talk time: "3 h 20 min", "45 min". */
export function talkTime(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : shortDuration(seconds);
}

export type OutcomeTone = "success" | "warning" | "danger" | "accent";

/** The result of a call in plain English, and the pill colour for it. */
export function outcomeText(outcome: string, direction: "in" | "out"): { label: string; tone: OutcomeTone } {
  switch (outcome) {
    case "answered":
      return { label: direction === "in" ? "Answered" : "Connected", tone: "success" };
    case "missed":
      return { label: direction === "in" ? "Missed" : "No answer", tone: "danger" };
    case "voicemail":
      return { label: "Voicemail", tone: "warning" };
    case "after_hours":
      return { label: "After hours", tone: "warning" };
    case "information":
      return { label: "Heard a message", tone: "accent" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    default:
      return { label: "In progress", tone: "accent" };
  }
}

/** Weekdays Monday first, for the busiest-times grid. dow is Postgres's 0 = Sunday. */
export const WEEKDAYS: { dow: number; label: string }[] = [
  { dow: 1, label: "Mon" },
  { dow: 2, label: "Tue" },
  { dow: 3, label: "Wed" },
  { dow: 4, label: "Thu" },
  { dow: 5, label: "Fri" },
  { dow: 6, label: "Sat" },
  { dow: 0, label: "Sun" },
];

/**
 * The hours to draw: 7am to 9pm always, widened to include any hour that had calls,
 * so a 6am caller is never hidden.
 */
export function heatHours(cells: { hour: number; calls: number }[]): number[] {
  let lo = 7;
  let hi = 21;
  for (const c of cells) {
    if (c.calls > 0) {
      lo = Math.min(lo, c.hour);
      hi = Math.max(hi, c.hour);
    }
  }
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** 0..1 shade for a cell, against the busiest cell. */
export function heatLevel(calls: number, max: number): number {
  if (!max || !calls) return 0;
  return Math.max(0.12, calls / max);
}

/** "9am", "12pm", "3pm". */
export function hourLabel(h: number): string {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}
