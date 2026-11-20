import { describe, expect, it } from "vitest";
import {
  conferenceRoomFor,
  isLiveCall,
  lineSince,
  lineState,
  monitorParticipant,
  nextPresence,
  queueNameFor,
  queuePositionMessage,
  queueWaitPlan,
  readCallFeatures,
  ringPlan,
  staffState,
} from "./switchboard.js";

describe("readCallFeatures", () => {
  it("is OFF when nothing is stored or the value is junk", () => {
    expect(readCallFeatures(undefined)).toEqual({ enabled: false, hold_audio_key: null, max_wait_s: 300 });
    expect(readCallFeatures("yes")).toEqual({ enabled: false, hold_audio_key: null, max_wait_s: 300 });
    expect(readCallFeatures({ enabled: "true" }).enabled).toBe(false);
  });
  it("keeps the wait between one and thirty minutes", () => {
    expect(readCallFeatures({ enabled: true, max_wait_s: 5 }).max_wait_s).toBe(60);
    expect(readCallFeatures({ enabled: true, max_wait_s: 99_999 }).max_wait_s).toBe(1800);
    expect(readCallFeatures({ enabled: true, hold_audio_key: "inbox/greetings/x.mp3", max_wait_s: 120 })).toEqual({
      enabled: true,
      hold_audio_key: "inbox/greetings/x.mp3",
      max_wait_s: 120,
    });
  });
});

describe("ringPlan", () => {
  const busy = new Set(["b"]);
  it("OFF: exactly today — ring everyone online, busy or not; voicemail when nobody", () => {
    expect(ringPlan(["a", "b"], busy, false)).toEqual({ kind: "dial", userIds: ["a", "b"] });
    expect(ringPlan(["b"], busy, false)).toEqual({ kind: "dial", userIds: ["b"] });
    expect(ringPlan([], busy, false)).toEqual({ kind: "voicemail" });
  });
  it("ON: skip busy people; queue when everyone online is busy; voicemail when nobody is online", () => {
    expect(ringPlan(["a", "b"], busy, true)).toEqual({ kind: "dial", userIds: ["a"] });
    expect(ringPlan(["b"], busy, true)).toEqual({ kind: "queue" });
    expect(ringPlan([], busy, true)).toEqual({ kind: "voicemail" });
  });
});

describe("the queue", () => {
  it("leaves when someone is free or the wait is too long", () => {
    expect(queueWaitPlan({ queueTimeS: 10, maxWaitS: 300, freeNow: true })).toBe("leave");
    expect(queueWaitPlan({ queueTimeS: 300, maxWaitS: 300, freeNow: false })).toBe("leave");
    expect(queueWaitPlan({ queueTimeS: 299, maxWaitS: 300, freeNow: false })).toBe("wait");
  });
  it("tells the caller their place in line", () => {
    expect(queuePositionMessage(1)).toContain("next in line");
    expect(queuePositionMessage(3)).toContain("number 3 in line");
    expect(queuePositionMessage(null)).toContain("stay on the line");
  });
  it("names queues and rooms after the line and the call", () => {
    expect(queueNameFor("n1")).toBe("line-n1");
    expect(conferenceRoomFor("c1")).toBe("call-c1");
  });
});

describe("monitorParticipant", () => {
  it("listen is muted, whisper coaches the staff leg, join is plain", () => {
    expect(monitorParticipant("listen", "CAagent")).toEqual({ muted: true, coaching: false });
    expect(monitorParticipant("whisper", "CAagent")).toEqual({ muted: false, coaching: true, callSidToCoach: "CAagent" });
    expect(monitorParticipant("join", "CAagent")).toEqual({ muted: false, coaching: false });
  });
});

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
