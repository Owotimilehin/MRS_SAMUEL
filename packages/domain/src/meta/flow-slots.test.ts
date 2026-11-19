import { describe, it, expect } from "vitest";
import { SLOT_CAPACITY, SLOT_WINDOWS, slotDayTitle, slotTitle, slotsFor, type SlotContext } from "./flow-slots.js";

/**
 * The rules for which delivery windows are offered, on a hand-built context (no database). The
 * database side (opening hours, holidays and bookings read from tables, and handleSlotFlow end to
 * end) is covered by apps/api/test/integration/wa-flow-endpoint.test.ts.
 */
const ids = (ctx: SlotContext, day: string): string[] => slotsFor(ctx, day).map((s) => s.id);
// Friday 20 Nov 2026, 08:00 on the business's clock.
const base: SlotContext = { rules: null, holidays: new Set(), today: "2026-11-20", nowMinutes: 8 * 60, booked: new Map() };
const hours = (weekday: number, open: number, close: number) => ({ weekday, open: open * 60, close: close * 60 });

describe("delivery-time windows (suite spec 07, section 5.10)", () => {
  it("names days and times the way the form shows them", () => {
    expect(slotDayTitle("2026-11-20")).toBe("Fri 20 Nov");
    expect(SLOT_WINDOWS.map(slotTitle)).toEqual(["9am to 11am", "11am to 1pm", "1pm to 3pm", "3pm to 5pm", "5pm to 7pm"]);
  });

  it("offers only windows inside opening hours, after the lead time, not on holidays", () => {
    // No hours profile: all five windows, Monday to Saturday, never Sunday.
    expect(ids(base, "2026-11-21")).toEqual([...SLOT_WINDOWS]);
    expect(ids(base, "2026-11-22")).toEqual([]);
    // Today at 08:00: a window must start at least 3 hours from now, so 09:00 is out and 11:00 is in.
    expect(ids(base, "2026-11-20")).toEqual(["11:00-13:00", "13:00-15:00", "15:00-17:00", "17:00-19:00"]);
    expect(ids({ ...base, nowMinutes: 8 * 60 + 1 }, "2026-11-20")).toEqual(["13:00-15:00", "15:00-17:00", "17:00-19:00"]);
    expect(ids({ ...base, nowMinutes: 16 * 60 + 30 }, "2026-11-20")).toEqual([]);
    // Late at night, tomorrow's first window is still inside the lead time.
    expect(ids({ ...base, nowMinutes: 23 * 60 }, "2026-11-21")).toEqual([...SLOT_WINDOWS]);
    expect(ids({ ...base, nowMinutes: 23 * 60 + 59 }, "2026-11-21")[0]).toBe("09:00-11:00");
    // With a profile: a window must lie wholly inside one open period of that weekday.
    const profile: SlotContext = { ...base, rules: [hours(6, 10, 15), hours(1, 9, 19)] };
    expect(ids(profile, "2026-11-21")).toEqual(["11:00-13:00", "13:00-15:00"]);
    expect(ids(profile, "2026-11-23")).toEqual([...SLOT_WINDOWS]);
    expect(ids(profile, "2026-11-24")).toEqual([]); // Tuesday has no rule
    // Two periods with a lunch break: the window that straddles the break is not offered.
    expect(ids({ ...base, rules: [hours(6, 9, 12), hours(6, 13, 19)] }, "2026-11-21")).toEqual(["09:00-11:00", "13:00-15:00", "15:00-17:00", "17:00-19:00"]);
    // A holiday closes the whole day; the past and the far future are never offered.
    expect(ids({ ...base, holidays: new Set(["2026-11-21"]) }, "2026-11-21")).toEqual([]);
    expect(ids(base, "2026-11-19")).toEqual([]);
    expect(ids(base, "2027-03-01")).toEqual([]);
    expect(ids(base, "none")).toEqual([]);
  });

  it("a window with four bookings is not offered", () => {
    const booked = new Map([
      ["2026-11-21|11:00-13:00", SLOT_CAPACITY],
      ["2026-11-21|13:00-15:00", SLOT_CAPACITY - 1],
      ["2026-11-23|11:00-13:00", 9],
    ]);
    expect(ids({ ...base, booked }, "2026-11-21")).toEqual(["09:00-11:00", "13:00-15:00", "15:00-17:00", "17:00-19:00"]);
    const full = new Map(SLOT_WINDOWS.map((w) => [`2026-11-21|${w}`, SLOT_CAPACITY] as [string, number]));
    expect(ids({ ...base, booked: full }, "2026-11-21")).toEqual([]);
  });
});
