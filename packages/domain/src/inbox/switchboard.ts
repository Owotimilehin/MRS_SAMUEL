/**
 * The live switchboard's rules, with no database or Twilio in them, so they
 * are unit-tested on their own (switchboard.test.ts).
 *
 *   lineState  – what a live call is doing right now
 *   staffState – whether a staff member can be rung right now
 */

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
