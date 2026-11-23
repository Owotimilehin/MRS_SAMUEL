/** Suite spec 15: snooze presets, Lagos inputs, reminder due labels and the Snoozed tab. */
import { describe, expect, it } from "vitest";
import {
  dateToLagosInput,
  emptyListText,
  inboxTabsFor,
  lagosInputToDate,
  reminderDue,
  shouldAlertForReminder,
  shouldAlertForWake,
  snoozePresets,
  whenLabel,
} from "./inbox-logic.js";

// Lagos is UTC+1. 2026-11-16 is a Monday; 2026-11-22 a Sunday.
const lagos = (local: string): Date => new Date(`${local}:00+01:00`);
const iso = (d: Date): string => d.toISOString();

describe("snooze presets (Lagos time)", () => {
  it("offers later today, tomorrow and next Monday in the morning", () => {
    const p = snoozePresets(lagos("2026-11-18T10:00")); // Wednesday
    expect(p.map((x) => x.key)).toEqual(["later", "tomorrow", "monday"]);
    expect(iso(p[0]!.at)).toBe(iso(lagos("2026-11-18T17:00")));
    expect(iso(p[1]!.at)).toBe(iso(lagos("2026-11-19T09:00")));
    expect(iso(p[2]!.at)).toBe(iso(lagos("2026-11-23T09:00")));
  });
  it("drops Later today once 17:00 is under 30 minutes away", () => {
    expect(snoozePresets(lagos("2026-11-18T16:29")).map((x) => x.key)).toContain("later");
    expect(snoozePresets(lagos("2026-11-18T16:31")).map((x) => x.key)).not.toContain("later");
    expect(snoozePresets(lagos("2026-11-18T22:00")).map((x) => x.key)).toEqual(["tomorrow", "monday"]);
  });
  it("late at night 'tomorrow' is the next Lagos day, even when UTC is still on today", () => {
    // 00:30 Lagos on Thursday = 23:30 UTC Wednesday.
    const p = snoozePresets(lagos("2026-11-19T00:30"));
    expect(iso(p.find((x) => x.key === "tomorrow")!.at)).toBe(iso(lagos("2026-11-20T09:00")));
  });
  it("next Monday from a Sunday is the day after; from a Monday it is a week ahead", () => {
    expect(iso(snoozePresets(lagos("2026-11-22T10:00")).find((x) => x.key === "monday")!.at)).toBe(iso(lagos("2026-11-23T09:00")));
    expect(iso(snoozePresets(lagos("2026-11-16T08:00")).find((x) => x.key === "monday")!.at)).toBe(iso(lagos("2026-11-23T09:00")));
  });
  it("Later today is the line's closing time when the line has hours", () => {
    const now = lagos("2026-11-18T10:00");
    const p = snoozePresets(now, { closesAt: lagos("2026-11-18T18:30").toISOString() });
    expect(p[0]).toMatchObject({ key: "later", label: "Later today, 18:30 (closing)" });
    expect(iso(p[0]!.at)).toBe(iso(lagos("2026-11-18T18:30")));
  });
  it("no Later today once the line has closed, or under 30 minutes before it closes", () => {
    expect(snoozePresets(lagos("2026-11-18T10:00"), { closesAt: null }).map((x) => x.key)).toEqual(["tomorrow", "monday"]);
    expect(snoozePresets(lagos("2026-11-18T18:10"), { closesAt: lagos("2026-11-18T18:30") }).map((x) => x.key)).not.toContain("later");
  });
  it("reminders also get 'In 1 hour'", () => {
    const now = lagos("2026-11-18T10:00");
    const p = snoozePresets(now, { withHour: true });
    expect(p[0]).toMatchObject({ key: "hour", label: "In 1 hour" });
    expect(p[0]!.at.getTime() - now.getTime()).toBe(3_600_000);
  });
});

describe("Lagos date and time inputs", () => {
  it("converts a Lagos wall-clock time to the right instant", () => {
    expect(lagosInputToDate("2026-11-25", "09:00")?.toISOString()).toBe("2026-11-25T08:00:00.000Z");
    expect(lagosInputToDate("2026-11-25", "")).toBeNull();
    expect(lagosInputToDate("25/11/2026", "09:00")).toBeNull();
    expect(lagosInputToDate("2026-11-25", "25:00")).toBeNull();
  });
  it("round-trips through the inputs", () => {
    expect(dateToLagosInput(new Date("2026-11-25T23:30:00Z"))).toEqual({ date: "2026-11-26", time: "00:30" });
  });
});

describe("when labels", () => {
  const now = lagos("2026-11-18T10:00");
  it("says today, tomorrow, or the day", () => {
    expect(whenLabel(lagos("2026-11-18T17:00"), now)).toBe("Today 17:00");
    expect(whenLabel(lagos("2026-11-19T09:00"), now)).toBe("Tomorrow 09:00");
    expect(whenLabel(lagos("2026-11-23T09:00"), now)).toBe("Mon 23 Nov, 09:00");
  });
});

describe("reminder due labels", () => {
  const now = lagos("2026-11-18T10:00");
  it("red when a day or more overdue, amber when due, accent later today, plain after", () => {
    expect(reminderDue(iso(lagos("2026-11-16T09:00")), null, now)).toEqual({ tone: "danger", label: "Overdue 2 days" });
    expect(reminderDue(iso(lagos("2026-11-18T09:40")), null, now)).toEqual({ tone: "warning", label: "Due 20 min ago" });
    expect(reminderDue(iso(lagos("2026-11-18T07:00")), null, now)).toEqual({ tone: "warning", label: "Due 3 h ago" });
    expect(reminderDue(iso(now), null, now)).toEqual({ tone: "warning", label: "Due now" });
    expect(reminderDue(iso(lagos("2026-11-18T15:00")), null, now)).toEqual({ tone: "accent", label: "Today 15:00" });
    expect(reminderDue(iso(lagos("2026-11-21T09:00")), null, now)).toEqual({ tone: "neutral", label: "Sat 21 Nov, 09:00" });
  });
  it("a done reminder says when it was done", () => {
    expect(reminderDue(iso(lagos("2026-11-16T09:00")), iso(lagos("2026-11-18T09:30")), now)).toEqual({ tone: "neutral", label: "Done Today 09:30" });
  });
});

describe("the Snoozed list and reminder alerts", () => {
  it("has its own tab and empty wording", () => {
    const tab = inboxTabsFor(["inbox.view"], []).find((t) => t.key === "snoozed")!;
    expect(tab).toMatchObject({ status: "snoozed", label: "Snoozed" });
    expect(emptyListText("snoozed", false).title).toBe("No snoozed chats");
  });
  it("alerts for a due reminder unless the person turned alerts off", () => {
    expect(shouldAlertForReminder({ event: "reminder.due", id: "R1" }, "assigned")).toBe(true);
    expect(shouldAlertForReminder({ event: "reminder.due", id: "R1" }, "none")).toBe(false);
    expect(shouldAlertForReminder({ event: "message.created", id: "R1" }, "all")).toBe(false);
  });
  it("a chat back from snooze makes a sound, following the person's alert choice", () => {
    const ctx = { userId: "U1", level: "assigned" as const, openConversationId: null, tabActive: true };
    const woke = { event: "conversation.woke", conversationId: "C1", assigneeId: null };
    expect(shouldAlertForWake(woke, ctx)).toBe(true);
    expect(shouldAlertForWake({ ...woke, assigneeId: "U1" }, ctx)).toBe(true);
    expect(shouldAlertForWake({ ...woke, assigneeId: "U2" }, ctx)).toBe(false);
    expect(shouldAlertForWake({ ...woke, assigneeId: "U2" }, { ...ctx, level: "all" })).toBe(true);
    expect(shouldAlertForWake(woke, { ...ctx, level: "none" })).toBe(false);
    expect(shouldAlertForWake(woke, { ...ctx, openConversationId: "C1" })).toBe(false);
    expect(shouldAlertForWake({ ...woke, event: "conversation.updated" }, ctx)).toBe(false);
  });
});
