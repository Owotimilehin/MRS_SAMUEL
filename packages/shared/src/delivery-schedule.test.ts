// packages/shared/src/delivery-schedule.test.ts
import { describe, it, expect } from "vitest";
import { orderSchedule, lineTarget, scheduledIso } from "./delivery-schedule.js";

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

describe("boundaries", () => {
  it("650 OOS at exactly 16:00 Wed -> next day evening (evening already started)", () => {
    const r = orderSchedule(at("2026-07-01T16:00:00"), [{ sizeMl: 650, inStock: false }]);
    expect(r).toMatchObject({ date: "2026-07-02", fixedWindow: "evening", selectableWindows: [] });
  });
  it("in-stock at 20:00 Wed -> next day, all windows", () => {
    const r = orderSchedule(at("2026-07-01T20:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("in-stock Saturday 21:00 -> rolls to Sunday, morning excluded", () => {
    const r = orderSchedule(at("2026-07-04T21:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-05");
    expect(r.selectableWindows).toEqual(["afternoon", "evening"]);
  });
  it("empty cart -> today's remaining windows", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), []);
    expect(r.date).toBe("2026-07-01");
    expect(r.selectableWindows).toEqual(["afternoon", "evening"]);
  });
  it("scheduledIso maps windows to Lagos anchors", () => {
    expect(scheduledIso("2026-07-01", "morning")).toBe("2026-07-01T09:00:00+01:00");
    expect(scheduledIso("2026-07-01", "afternoon")).toBe("2026-07-01T14:00:00+01:00");
    expect(scheduledIso("2026-07-01", "evening")).toBe("2026-07-01T18:00:00+01:00");
  });
  it("lineTarget: 330 OOS Wed -> next day, pickable", () => {
    const t = lineTarget(at("2026-07-01T10:00:00"), { sizeMl: 330, inStock: false });
    expect(t.date).toBe("2026-07-02");
    expect(t.fixedWindow).toBeUndefined();
    expect(t.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
});
