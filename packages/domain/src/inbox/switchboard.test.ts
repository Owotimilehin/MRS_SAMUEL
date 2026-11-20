import { describe, expect, it } from "vitest";
import { isLiveCall, lineSince, lineState, nextPresence, staffState } from "./switchboard.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("lineState", () => {
  const base = { endedAt: null, startedAt: ago(60_000), heldAt: null, queuedAt: null };
  it("an unanswered call is ringing, or waiting once it is in the queue", () => {
    expect(lineState({ ...base, outcome: "in_progress" })).toBe("ringing");
    expect(lineState({ ...base, outcome: "in_progress", queuedAt: ago(10_000) })).toBe("waiting");
  });
  it("an answered call is on call, or on hold while held", () => {
    expect(lineState({ ...base, outcome: "answered" })).toBe("on_call");
    expect(lineState({ ...base, outcome: "answered", heldAt: ago(5_000) })).toBe("on_hold");
  });
  it("the timer counts from the moment the state began", () => {
    const answeredAt = ago(30_000);
    expect(lineSince({ ...base, outcome: "in_progress", answeredAt: null })).toEqual(base.startedAt);
    expect(lineSince({ ...base, outcome: "answered", answeredAt })).toEqual(answeredAt);
    expect(lineSince({ ...base, outcome: "answered", answeredAt, heldAt: ago(5_000) })).toEqual(ago(5_000));
    expect(lineSince({ ...base, outcome: "in_progress", answeredAt: null, queuedAt: ago(10_000) })).toEqual(ago(10_000));
  });
});

describe("isLiveCall", () => {
  it("only ringing or answered calls that have not ended", () => {
    expect(isLiveCall({ outcome: "in_progress", endedAt: null, startedAt: ago(1000) }, NOW)).toBe(true);
    expect(isLiveCall({ outcome: "answered", endedAt: null, startedAt: ago(1000) }, NOW)).toBe(true);
    expect(isLiveCall({ outcome: "answered", endedAt: ago(10), startedAt: ago(1000) }, NOW)).toBe(false);
    expect(isLiveCall({ outcome: "missed", endedAt: null, startedAt: ago(1000) }, NOW)).toBe(false);
    expect(isLiveCall({ outcome: "voicemail", endedAt: null, startedAt: ago(1000) }, NOW)).toBe(false);
  });
  it("drops a call whose end was never reported after four hours", () => {
    expect(isLiveCall({ outcome: "answered", endedAt: null, startedAt: ago(4 * 3600_000 + 1) }, NOW)).toBe(false);
  });
});

describe("staffState", () => {
  const off = { available: false, lastSeenAt: ago(1000), mobileSeenAt: null, onCall: false };
  it("on a call wins over everything", () => {
    expect(staffState({ ...off, onCall: true }, NOW)).toBe("on_call");
  });
  it("switched off, or never switched on, is away", () => {
    expect(staffState(off, NOW)).toBe("away");
    expect(staffState({ ...off, available: null, lastSeenAt: null }, NOW)).toBe("away");
  });
  it("switched on with an open app in the last 90 seconds is available", () => {
    expect(staffState({ ...off, available: true }, NOW)).toBe("available");
    expect(staffState({ ...off, available: true, lastSeenAt: ago(91_000) }, NOW)).toBe("offline");
  });
  it("a phone with the app can be woken, so it counts as available", () => {
    expect(staffState({ ...off, available: true, lastSeenAt: ago(3600_000), mobileSeenAt: ago(86_400_000) }, NOW)).toBe("available");
  });
});

describe("nextPresence", () => {
  it("a heartbeat does not undo a manager's away", () => {
    expect(nextPresence({ available: false, awaySetBy: "m" }, { available: true, heartbeat: true })).toEqual({
      available: false,
      keepManagerAway: true,
    });
  });
  it("the person's own switch always wins", () => {
    expect(nextPresence({ available: false, awaySetBy: "m" }, { available: true, heartbeat: false })).toEqual({
      available: true,
      keepManagerAway: false,
    });
  });
  it("without a manager's mark a heartbeat sets what it says", () => {
    expect(nextPresence({ available: false, awaySetBy: null }, { available: true, heartbeat: true }).available).toBe(true);
    expect(nextPresence(null, { available: true, heartbeat: true }).available).toBe(true);
  });
});
