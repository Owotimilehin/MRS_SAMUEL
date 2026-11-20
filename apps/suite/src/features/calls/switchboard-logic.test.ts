import { describe, expect, it } from "vitest";
import type { BoardLine, BoardStaff } from "./switchboard-api.js";
import {
  canPickUp,
  canTransfer,
  lineStaff,
  lineWhere,
  lineWho,
  listenView,
  minutesLabel,
  waitingCount,
  pillClass,
  presenceAction,
  sortLines,
  sortStaff,
  staffSub,
  summaryLine,
  timer,
  transferPeople,
} from "./switchboard-logic.js";

const line = (over: Partial<BoardLine> = {}): BoardLine => ({
  id: "c1",
  conversation_id: "v1",
  direction: "in",
  state: "ringing",
  since: "2026-11-20T10:00:00.000Z",
  started_at: "2026-11-20T10:00:00.000Z",
  customer_name: "Ada",
  customer_phone: "+2347011110001",
  number_label: "Main line",
  number_e164: "+2348100000001",
  team_id: "t1",
  team_name: "Orders",
  ivr_choice: null,
  staff_id: null,
  staff_name: null,
  ringing_for_id: null,
  ringing_for: null,
  monitor_user_id: null,
  monitor_name: null,
  monitor_mode: null,
  monitor_connected: false,
  ...over,
});

const person = (over: Partial<BoardStaff> = {}): BoardStaff => ({
  id: "u1",
  name: "Bola",
  state: "available",
  call_id: null,
  last_seen_at: null,
  away_set_by: null,
  teams: ["Orders"],
  ...over,
});

describe("timer", () => {
  const since = "2026-11-20T10:00:00.000Z";
  const at = (s: number): number => new Date(since).getTime() + s * 1000;
  it("counts minutes and seconds, then hours", () => {
    expect(timer(since, at(7))).toBe("0:07");
    expect(timer(since, at(754))).toBe("12:34");
    expect(timer(since, at(3723))).toBe("1:02:03");
  });
  it("never shows a negative time when clocks disagree", () => {
    expect(timer(since, at(-5))).toBe("0:00");
  });
});

describe("line wording", () => {
  it("names the caller, else their number", () => {
    expect(lineWho(line())).toBe("Ada");
    expect(lineWho(line({ customer_name: null }))).toContain("701");
    expect(lineWho(line({ customer_name: null, customer_phone: null }))).toBe("Unknown caller");
  });
  it("says which number was rung and which team", () => {
    expect(lineWhere(line({ ivr_choice: "1" }))).toBe("Main line · Orders · pressed 1");
    expect(lineWhere(line({ direction: "out" }))).toBe("Calling out on Main line");
  });
  it("says who has it or who it rings for", () => {
    expect(lineStaff(line({ state: "on_call", staff_name: "Chi" }))).toBe("with Chi");
    expect(lineStaff(line({ ringing_for: "dayo@example.com" }))).toBe("ringing for dayo");
    expect(lineStaff(line())).toBeNull();
  });
  it("uses the admin's pill colours", () => {
    expect(pillClass("success")).toBe("pill pill--success");
    expect(pillClass("plain")).toBe("pill");
  });
});

describe("order", () => {
  it("puts ringing calls first, then waiting, oldest first", () => {
    const sorted = sortLines([
      line({ id: "talk", state: "on_call", since: "2026-11-20T09:00:00Z" }),
      line({ id: "ring-new", since: "2026-11-20T10:05:00Z" }),
      line({ id: "wait", state: "waiting", since: "2026-11-20T10:01:00Z" }),
      line({ id: "ring-old", since: "2026-11-20T10:00:00Z" }),
    ]);
    expect(sorted.map((l) => l.id)).toEqual(["ring-old", "ring-new", "wait", "talk"]);
  });
  it("puts free staff first and away staff last", () => {
    const sorted = sortStaff([
      person({ id: "a", name: "Zed", state: "away" }),
      person({ id: "b", name: "Yemi", state: "on_call" }),
      person({ id: "c", name: "Xavi" }),
      person({ id: "d", name: "Wale", state: "offline" }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("summaryLine", () => {
  it("counts calls and free people", () => {
    expect(summaryLine([line(), line({ state: "on_call" }), line({ state: "on_hold" })], [person(), person({ state: "away" })])).toBe(
      "1 ringing · 2 on calls. 1 person free to take a call.",
    );
    expect(summaryLine([], [])).toBe("No calls right now. 0 people free to take a call.");
  });
});

describe("which buttons show", () => {
  it("pick up: an unanswered incoming call, not one already coming to me, and only if I answer calls", () => {
    expect(canPickUp(line(), "me", true)).toBe(true);
    expect(canPickUp(line({ state: "waiting" }), "me", true)).toBe(true);
    expect(canPickUp(line({ ringing_for_id: "me" }), "me", true)).toBe(false);
    expect(canPickUp(line({ state: "on_call" }), "me", true)).toBe(false);
    expect(canPickUp(line({ direction: "out" }), "me", true)).toBe(false);
    expect(canPickUp(line(), "me", false)).toBe(false);
  });
  it("transfer: an incoming call someone is talking on or holding", () => {
    expect(canTransfer(line({ state: "on_call" }))).toBe(true);
    expect(canTransfer(line({ state: "on_hold" }))).toBe(true);
    expect(canTransfer(line())).toBe(false);
    expect(canTransfer(line({ state: "on_call", direction: "out" }))).toBe(false);
  });
  it("transfer to a person lists free people other than the one on the call", () => {
    const staff = [person({ id: "on" }), person({ id: "free" }), person({ id: "away", state: "away" })];
    expect(transferPeople(line({ state: "on_call", staff_id: "on" }), staff).map((s) => s.id)).toEqual(["free"]);
  });
  it("mark away / available, nothing while on a call", () => {
    expect(presenceAction(person())).toEqual({ available: false, label: "Mark away" });
    expect(presenceAction(person({ state: "offline" }))).toEqual({ available: false, label: "Mark away" });
    expect(presenceAction(person({ state: "away" }))).toEqual({ available: true, label: "Mark available" });
    expect(presenceAction(person({ state: "on_call" }))).toBeNull();
  });
  it("listen in: only with the beta on, only on a call someone else is talking on", () => {
    const talking = line({ state: "on_call", staff_id: "agent" });
    expect(listenView(talking, "me", false)).toEqual({ kind: "none" });
    expect(listenView(line(), "me", true)).toEqual({ kind: "none" });
    expect(listenView(talking, "agent", true)).toEqual({ kind: "none" });
    expect(listenView(talking, "me", true)).toEqual({ kind: "start" });
    expect(listenView(line({ state: "on_hold", staff_id: "agent" }), "me", true)).toEqual({ kind: "start" });
    expect(listenView({ ...talking, monitor_user_id: "boss", monitor_name: "Tes" }, "me", true)).toEqual({ kind: "other", name: "Tes" });
    expect(listenView({ ...talking, monitor_user_id: "me", monitor_mode: "whisper", monitor_connected: true }, "me", true)).toEqual({
      kind: "mine",
      mode: "whisper",
      connected: true,
    });
  });
  it("counts waiting callers and words the longest wait", () => {
    expect(waitingCount([line({ state: "waiting" }), line(), line({ state: "waiting" })])).toBe(2);
    expect(minutesLabel(60)).toBe("1 minute");
    expect(minutesLabel(300)).toBe("5 minutes");
  });
  it("says who marked someone away", () => {
    expect(staffSub(person({ state: "away", away_set_by: "Tes" }))).toBe("Orders · marked away by Tes");
    expect(staffSub(person({ state: "offline", teams: [] }))).toBe("switched on, but no app is open");
  });
});
