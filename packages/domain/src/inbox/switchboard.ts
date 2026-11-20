/**
 * The live switchboard's rules, with no database or Twilio in them, so they
 * are unit-tested on their own (switchboard.test.ts).
 *
 *   lineState  – what a live call is doing right now
 *   staffState – whether a staff member can be rung right now
 *   ringPlan   – ring, queue or voicemail (the queue only when switched on)
 */
import { CALL_FEATURES_DEFAULT, type CallFeaturesValue } from "@ms/db";
import type { ParticipantUpdate } from "./twilio.js";

/** "Online" = heartbeat within this window. The web app beats every 30s. */
export const PRESENCE_FRESH_MS = 90_000;
/**
 * A phone that opened the app within this window can be rung while closed
 * (Twilio wakes it by push). Same rule as ringing a team.
 */
export const MOBILE_REACHABLE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A call older than this with no end recorded is treated as over: Twilio's
 * final status callback was lost. Keeps a stuck row off the board forever.
 */
export const LIVE_CALL_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export type LineState = "ringing" | "waiting" | "on_call" | "on_hold";

export interface LineFacts {
  outcome: string;
  endedAt: Date | null;
  startedAt: Date;
  heldAt: Date | null;
  /** Waiting in the call queue since (queue switched on only). */
  queuedAt?: Date | null;
}

/** Is this call still live (on the board)? */
export function isLiveCall(c: Pick<LineFacts, "outcome" | "endedAt" | "startedAt">, now: Date = new Date()): boolean {
  if (c.endedAt) return false;
  if (c.outcome !== "in_progress" && c.outcome !== "answered") return false;
  return now.getTime() - c.startedAt.getTime() < LIVE_CALL_MAX_AGE_MS;
}

/** What a live call is doing: ringing, waiting in the queue, talking, or on hold. */
export function lineState(c: LineFacts): LineState {
  if (c.outcome === "answered") return c.heldAt ? "on_hold" : "on_call";
  return c.queuedAt ? "waiting" : "ringing";
}

/** When the state's timer starts: ringing/waiting count from the start (or queue), a call from when it was answered. */
export function lineSince(c: LineFacts & { answeredAt: Date | null }): Date {
  const s = lineState(c);
  if (s === "on_hold") return c.heldAt!;
  if (s === "on_call") return c.answeredAt ?? c.startedAt;
  if (s === "waiting") return c.queuedAt!;
  return c.startedAt;
}

export type StaffState = "available" | "on_call" | "away" | "offline";

export interface StaffFacts {
  /** The presence switch ("taking calls"). No presence row = never switched on = away. */
  available: boolean | null;
  lastSeenAt: Date | null;
  /** Last time a phone with the app checked in, if any. */
  mobileSeenAt: Date | null;
  /** On a live call right now (answered, or calling out). */
  onCall: boolean;
}

/**
 * - on_call: talking to a customer (whatever the switch says)
 * - away: switched off (by themselves or a manager)
 * - offline: switched on, but no open app has checked in and no phone can be woken
 * - available: will be rung
 */
export function staffState(s: StaffFacts, now: Date = new Date()): StaffState {
  if (s.onCall) return "on_call";
  if (!s.available) return "away";
  const fresh = !!s.lastSeenAt && now.getTime() - s.lastSeenAt.getTime() < PRESENCE_FRESH_MS;
  const phone = !!s.mobileSeenAt && now.getTime() - s.mobileSeenAt.getTime() < MOBILE_REACHABLE_MS;
  return fresh || phone ? "available" : "offline";
}

// ── Call queue and supervisor tools (behind the owner's beta switch) ─────────

/** Read the stored setting, filling gaps with the defaults (OFF). Never throws. */
export function readCallFeatures(value: unknown): CallFeaturesValue {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof CallFeaturesValue, unknown>>;
  const wait = typeof v.max_wait_s === "number" && Number.isFinite(v.max_wait_s) ? Math.round(v.max_wait_s) : CALL_FEATURES_DEFAULT.max_wait_s;
  return {
    enabled: v.enabled === true,
    hold_audio_key: typeof v.hold_audio_key === "string" && v.hold_audio_key ? v.hold_audio_key : null,
    max_wait_s: Math.min(1800, Math.max(60, wait)),
  };
}

export type RingPlan = { kind: "dial"; userIds: string[] } | { kind: "queue" } | { kind: "voicemail" };

/**
 * Who to ring for a team. `online` = staff who could be rung (today's rule).
 * With the queue OFF this is exactly today: ring everyone online, voicemail if
 * nobody. With it ON, people already on a call are skipped, and if everyone
 * online is busy the caller waits in the queue instead.
 */
export function ringPlan(online: readonly string[], busy: ReadonlySet<string>, queueOn: boolean): RingPlan {
  if (online.length === 0) return { kind: "voicemail" };
  if (!queueOn) return { kind: "dial", userIds: [...online] };
  const free = online.filter((id) => !busy.has(id));
  return free.length > 0 ? { kind: "dial", userIds: free } : { kind: "queue" };
}

/**
 * Each time the hold music ends Twilio asks again. Leave the queue (and ring
 * whoever is free, or go to voicemail) once someone is free or the caller has
 * waited too long; otherwise keep waiting.
 */
export function queueWaitPlan(input: { queueTimeS: number; maxWaitS: number; freeNow: boolean }): "leave" | "wait" {
  if (input.freeNow) return "leave";
  return input.queueTimeS >= input.maxWaitS ? "leave" : "wait";
}

/** What a waiting caller hears between the music. */
export function queuePositionMessage(position: number | null): string {
  if (!position || position < 1) return "Thank you for waiting. All our team are busy, please stay on the line.";
  if (position === 1) return "Thank you for waiting. You are next in line.";
  return `Thank you for waiting. You are number ${position} in line.`;
}

/** Twilio queue for a business line (one queue per number). */
export function queueNameFor(numberId: string): string {
  return `line-${numberId}`;
}

/** Conference room a call moves into when a supervisor listens in. */
export function conferenceRoomFor(callId: string): string {
  return `call-${callId}`;
}

export const MONITOR_MODES = ["listen", "whisper", "join"] as const;
export type MonitorMode = (typeof MONITOR_MODES)[number];

/**
 * listen  – the supervisor is muted: hears both sides, nobody hears them
 * whisper – only the staff member hears the supervisor (Twilio "coaching")
 * join    – everyone hears everyone (barge)
 */
export function monitorParticipant(mode: MonitorMode, agentCallSid: string): ParticipantUpdate {
  if (mode === "listen") return { muted: true, coaching: false };
  if (mode === "whisper") return { muted: false, coaching: true, callSidToCoach: agentCallSid };
  return { muted: false, coaching: false };
}

/**
 * The presence a heartbeat or a switch should leave behind.
 *
 * A manager's "away" sticks: the person's own heartbeat (sent every 30s by an
 * open app) only refreshes `lastSeenAt` while it is set. Pressing their own
 * switch (not a heartbeat) always wins and clears the manager's mark.
 */
export function nextPresence(
  current: { available: boolean; awaySetBy: string | null } | null,
  input: { available: boolean; heartbeat: boolean },
): { available: boolean; keepManagerAway: boolean } {
  if (input.heartbeat && current && current.awaySetBy && !current.available) {
    return { available: false, keepManagerAway: true };
  }
  return { available: input.available, keepManagerAway: false };
}
