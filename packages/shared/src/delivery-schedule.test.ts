// packages/shared/src/delivery-schedule.test.ts
import { describe, it, expect } from "vitest";
import { orderSchedule } from "./delivery-schedule.js";

// Helper: Lagos wall-clock -> Date. Lagos = UTC+1.
const at = (iso: string) => new Date(`${iso}+01:00`);

describe("orderSchedule", () => {
  it("in-stock 650 at Wed 10:00 -> today, pick afternoon+evening", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-01");
    expect(r.selectableWindows).toEqual(["afternoon", "evening"]);
    expect(r.fixedWindow).toBeUndefined();
  });
  it("in-stock 650 at Wed 21:00 -> next day, all windows", () => {
    const r = orderSchedule(at("2026-07-01T21:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("650 OOS at Wed 10:00 -> today evening (fixed)", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [{ sizeMl: 650, inStock: false }]);
    expect(r).toMatchObject({ date: "2026-07-01", fixedWindow: "evening", selectableWindows: [] });
  });
  it("650 OOS at Wed 19:30 -> next day evening (fixed)", () => {
    const r = orderSchedule(at("2026-07-01T19:30:00"), [{ sizeMl: 650, inStock: false }]);
    expect(r).toMatchObject({ date: "2026-07-02", fixedWindow: "evening" });
  });
  it("330 OOS at Wed 10:00 -> next day, pick windows", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [{ sizeMl: 330, inStock: false }]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("Sunday 14:00 650 OOS -> Monday evening (override)", () => {
    const r = orderSchedule(at("2026-07-05T14:00:00"), [{ sizeMl: 650, inStock: false }]); // 2026-07-05 is Sunday
    expect(r).toMatchObject({ date: "2026-07-06", fixedWindow: "evening" });
  });
  it("Sunday 14:00 330 OOS -> Monday, pick", () => {
    const r = orderSchedule(at("2026-07-05T14:00:00"), [{ sizeMl: 330, inStock: false }]);
    expect(r.date).toBe("2026-07-06");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("Sunday 14:00 650 in stock -> Sunday evening (afternoon already started)", () => {
    const r = orderSchedule(at("2026-07-05T14:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-05");
    expect(r.selectableWindows).toEqual(["evening"]);
  });
  it("mixed in-stock 650 + 330 OOS at Wed 10:00 -> latest date (Thu), pick", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [
      { sizeMl: 650, inStock: true },
      { sizeMl: 330, inStock: false },
    ]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
});
