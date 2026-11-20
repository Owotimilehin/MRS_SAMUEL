/**
 * Plain helpers for the switchboard page: wording, order and which buttons
 * show. No React here, so it is all unit-tested (switchboard-logic.test.ts).
 */
import { prettyPhone, staffLabel } from "@admin/lib/inbox-logic.js";
import type { BoardLine, BoardStaff, LineState, MonitorMode, StaffState } from "./switchboard-api.js";

export const LINE_LABEL: Record<LineState, string> = {
  ringing: "Ringing",
  waiting: "Waiting",
  on_call: "On a call",
  on_hold: "On hold",
};

/** The pill class for a state (the admin's pill colours). */
export type Tone = "warning" | "accent" | "success" | "plain";
export function pillClass(t: Tone): string {
  return t === "plain" ? "pill" : `pill pill--${t}`;
}

export const LINE_TONE: Record<LineState, Tone> = {
  ringing: "warning",
  waiting: "warning",
  on_call: "success",
  on_hold: "accent",
};

export const STAFF_LABEL: Record<StaffState, string> = {
  available: "Available",
  on_call: "On a call",
  away: "Away",
  offline: "Not connected",
};

export const STAFF_TONE: Record<StaffState, Tone> = {
  available: "success",
  on_call: "accent",
  away: "plain",
  offline: "warning",
};

/** A live timer: "0:07", "12:34", "1:02:03". Negative (clock skew) shows 0:00. */
export function timer(sinceIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(sinceIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The caller's name, else their number. */
export function lineWho(l: BoardLine): string {
  return l.customer_name?.trim() || prettyPhone(l.customer_phone) || "Unknown caller";
}

/** "Main line · Orders" or "Calling out on Main line". */
export function lineWhere(l: BoardLine): string {
  if (l.direction === "out") return `Calling out on ${l.number_label}`;
  return [l.number_label, l.team_name, l.ivr_choice ? `pressed ${l.ivr_choice}` : null].filter(Boolean).join(" · ");
}

/** Who has the call, or who it is ringing for. */
export function lineStaff(l: BoardLine): string | null {
  if (l.state === "on_call" || l.state === "on_hold") return l.staff_name ? `with ${staffLabel(l.staff_name)}` : null;
  if (l.state === "ringing" && l.ringing_for) return `ringing for ${staffLabel(l.ringing_for)}`;
  return null;
}

/** Ringing calls first (they need someone now), then waiting, then the rest; oldest first in each. */
export function sortLines(lines: readonly BoardLine[]): BoardLine[] {
  const rank: Record<LineState, number> = { ringing: 0, waiting: 1, on_hold: 2, on_call: 3 };
  return [...lines].sort((a, b) => rank[a.state] - rank[b.state] || a.since.localeCompare(b.since));
}

/** Free first, then on a call, then not connected, then away; by name in each. */
export function sortStaff(staff: readonly BoardStaff[]): BoardStaff[] {
  const rank: Record<StaffState, number> = { available: 0, on_call: 1, offline: 2, away: 3 };
  return [...staff].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

/** "2 ringing · 1 waiting · 3 on calls" — the line above the board. */
export function summaryLine(lines: readonly BoardLine[], staff: readonly BoardStaff[]): string {
  const n = (s: LineState): number => lines.filter((l) => l.state === s).length;
  const free = staff.filter((s) => s.state === "available").length;
  const parts = [
    n("ringing") ? `${n("ringing")} ringing` : null,
    n("waiting") ? `${n("waiting")} waiting` : null,
    n("on_call") + n("on_hold") ? `${n("on_call") + n("on_hold")} on ${n("on_call") + n("on_hold") === 1 ? "a call" : "calls"}` : null,
  ].filter(Boolean);
  const calls = parts.length ? parts.join(" · ") : "No calls right now";
  return `${calls}. ${free} ${free === 1 ? "person" : "people"} free to take a call.`;
}

/** Can I pick this call up? Only an unanswered incoming call not already coming to me. */
export function canPickUp(l: BoardLine, meId: string, canAnswer: boolean): boolean {
  if (!canAnswer || l.direction !== "in") return false;
  if (l.state !== "ringing" && l.state !== "waiting") return false;
  return l.ringing_for_id !== meId;
}

/** A call someone is talking on can be handed to a team or a person. */
export function canTransfer(l: BoardLine): boolean {
  return l.direction === "in" && (l.state === "on_call" || l.state === "on_hold");
}

/** People a call can be put through to: free, and not the one already on it. */
export function transferPeople(l: BoardLine, staff: readonly BoardStaff[]): BoardStaff[] {
  return sortStaff(staff.filter((s) => s.state === "available" && s.id !== l.staff_id));
}

/** The button for a staff member: mark away, or mark available. Null while they are on a call. */
export function presenceAction(s: BoardStaff): { available: boolean; label: string } | null {
  if (s.state === "on_call") return null;
  return s.state === "away" ? { available: true, label: "Mark available" } : { available: false, label: "Mark away" };
}

// ── Call queue and supervisor tools (beta) ──

/** How many callers are waiting in the queue. */
export function waitingCount(lines: readonly BoardLine[]): number {
  return lines.filter((l) => l.state === "waiting").length;
}

export const MODE_LABEL: Record<MonitorMode, string> = {
  listen: "Listen",
  whisper: "Whisper",
  join: "Join",
};

export const MODE_HINT: Record<MonitorMode, string> = {
  listen: "You hear both sides. Nobody hears you.",
  whisper: "Only your colleague hears you. The customer doesn't.",
  join: "Everyone hears you, like a three-way call.",
};

export type ListenView =
  /** The tools are off, or this isn't a call someone is talking on. */
  | { kind: "none" }
  /** Nobody listening: offer to start. */
  | { kind: "start" }
  /** Someone else is listening. */
  | { kind: "other"; name: string }
  /** I am listening (or my app is still joining). */
  | { kind: "mine"; mode: MonitorMode; connected: boolean };

/** What the listen-in area of a line shows for me. */
export function listenView(l: BoardLine, meId: string, toolsOn: boolean): ListenView {
  if (!toolsOn || l.direction !== "in" || (l.state !== "on_call" && l.state !== "on_hold")) return { kind: "none" };
  if (l.staff_id === meId) return { kind: "none" };
  if (!l.monitor_user_id) return { kind: "start" };
  if (l.monitor_user_id !== meId) return { kind: "other", name: staffLabel(l.monitor_name, "Someone") };
  return { kind: "mine", mode: l.monitor_mode ?? "listen", connected: l.monitor_connected };
}

/** "1 minute", "5 minutes" — the queue's longest wait setting. */
export function minutesLabel(seconds: number): string {
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** The small line under a staff member's name. */
export function staffSub(s: BoardStaff): string {
  const bits = [s.teams.join(", ") || null];
  if (s.state === "away" && s.away_set_by) bits.push(`marked away by ${staffLabel(s.away_set_by)}`);
  if (s.state === "offline") bits.push("switched on, but no app is open");
  return bits.filter(Boolean).join(" · ");
}
