import { describe, expect, it } from "vitest";
import {
  businessMinutesBetween,
  readReplyTarget,
  reminderTimeProblem,
  replyFlag,
  snoozeTimeProblem,
  waitWords,
} from "./tasks.js";

// Lagos is UTC+1 all year. 2026-11-16 is a Monday.
const lagos = (local: string): Date => new Date(`${local}:00+01:00`);
// Mon–Sat 08:00–13:00 and 14:00–18:00 (a lunch gap); Sunday closed.
const RULES = [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, openTime: "08:00", closeTime: "13:00" },
  { weekday, openTime: "14:00", closeTime: "18:00" },
]);
const HOURS = { rules: RULES, holidays: [] as string[], timeZone: "Africa/Lagos" };

describe("businessMinutesBetween", () => {
  it("counts every minute inside one window", () => {
    expect(businessMinutesBetween(lagos("2026-11-16T09:00"), lagos("2026-11-16T09:42"), HOURS)).toBe(42);
  });
  it("skips the lunch gap", () => {
    // 12:30–14:30 = 30 min before lunch + 30 min after.
    expect(businessMinutesBetween(lagos("2026-11-16T12:30"), lagos("2026-11-16T14:30"), HOURS)).toBe(60);
  });
  it("counts nothing overnight and resumes at opening", () => {
    // 17:50 Monday to 08:10 Tuesday = 10 + 10.
    expect(businessMinutesBetween(lagos("2026-11-16T17:50"), lagos("2026-11-17T08:10"), HOURS)).toBe(20);
  });
  it("skips a closed Sunday", () => {
    // Saturday 17:30 to Monday 08:30 = 30 + 30.
    expect(businessMinutesBetween(lagos("2026-11-21T17:30"), lagos("2026-11-23T08:30"), HOURS)).toBe(60);
  });
  it("skips a holiday", () => {
    const withHoliday = { ...HOURS, holidays: ["2026-11-17"] };
    // Monday 17:50 to Wednesday 08:10 with Tuesday a holiday = 10 + 10.
    expect(businessMinutesBetween(lagos("2026-11-16T17:50"), lagos("2026-11-18T08:10"), withHoliday)).toBe(20);
  });
  it("counts wall-clock minutes when the line has no schedule", () => {
    expect(businessMinutesBetween(lagos("2026-11-16T23:00"), lagos("2026-11-17T01:30"), null)).toBe(150);
  });
  it("is zero when the end is not after the start, or outside hours", () => {
    expect(businessMinutesBetween(lagos("2026-11-16T10:00"), lagos("2026-11-16T09:00"), HOURS)).toBe(0);
    expect(businessMinutesBetween(lagos("2026-11-16T19:00"), lagos("2026-11-16T23:00"), HOURS)).toBe(0);
  });
  it("treats a window whose close is not after its open as closed", () => {
    const odd = { rules: [{ weekday: 1, openTime: "18:00", closeTime: "08:00" }], holidays: [] };
    expect(businessMinutesBetween(lagos("2026-11-16T00:00"), lagos("2026-11-16T23:59"), odd)).toBe(0);
  });
});

describe("reply-time flag", () => {
  it("is off without a target or a wait", () => {
    expect(replyFlag(100, null)).toBeNull();
    expect(replyFlag(null, 15)).toBeNull();
  });
  it("is amber at the target and red at twice it", () => {
    expect(replyFlag(14, 15)).toBeNull();
    expect(replyFlag(15, 15)).toEqual({ tone: "warning", text: "Waiting 15 min" });
    expect(replyFlag(29, 15)?.tone).toBe("warning");
    expect(replyFlag(30, 15)).toEqual({ tone: "danger", text: "Waiting 30 min" });
    expect(replyFlag(65, 15)?.text).toBe("Waiting 1 h 5 min");
  });
  it("says waits in plain words", () => {
    expect(waitWords(42)).toBe("42 min");
    expect(waitWords(60)).toBe("1 h");
    expect(waitWords(24 * 60 + 180)).toBe("1 day 3 h");
    expect(waitWords(3 * 24 * 60)).toBe("3 days");
  });
  it("reads the stored setting defensively", () => {
    expect(readReplyTarget({ minutes: 15 })).toBe(15);
    expect(readReplyTarget({ minutes: null })).toBeNull();
    expect(readReplyTarget({ minutes: 2 })).toBeNull();
    expect(readReplyTarget({ minutes: "15" })).toBeNull();
    expect(readReplyTarget(null)).toBeNull();
  });
});

describe("snooze and reminder times", () => {
  const now = lagos("2026-11-16T10:00");
  it("refuses a snooze in the past, too soon, or too far ahead", () => {
    expect(snoozeTimeProblem(lagos("2026-11-16T09:00"), now)).toBe("Pick a time in the future.");
    expect(snoozeTimeProblem(new Date(now.getTime() + 30_000), now)).toBe("Pick a time in the future.");
    expect(snoozeTimeProblem(lagos("2026-11-17T09:00"), now)).toBeNull();
    expect(snoozeTimeProblem(new Date(now.getTime() + 91 * 86_400_000), now)).toBe("Pick a time within 90 days.");
    expect(snoozeTimeProblem(new Date("nonsense"), now)).toBe("Pick a date and time.");
  });
  it("lets a reminder be due now but not more than a year away", () => {
    expect(reminderTimeProblem(lagos("2026-11-16T09:00"), now)).toBeNull();
    expect(reminderTimeProblem(new Date(now.getTime() + 400 * 86_400_000), now)).toBe("Pick a time within a year.");
  });
});
