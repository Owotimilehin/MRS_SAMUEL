import { describe, it, expect } from "vitest";
import { WINDOWS, scheduledIso, isWindowAvailable } from "./schedule";

describe("schedule windows", () => {
  it("exposes three windows mapped to fixed Lagos hours", () => {
    expect(WINDOWS.map((w) => w.id)).toEqual(["morning", "afternoon", "evening"]);
    expect(WINDOWS.map((w) => w.hour24)).toEqual([10, 14, 17]);
  });

  it("builds a Lagos (+01:00) ISO for a date + window", () => {
    expect(scheduledIso("2026-06-13", "afternoon")).toBe("2026-06-13T14:00:00+01:00");
    expect(scheduledIso("2026-06-13", "morning")).toBe("2026-06-13T10:00:00+01:00");
  });

  it("treats a window as available only when strictly in the future", () => {
    // now = 2026-06-13 13:00 Lagos (12:00Z)
    const now = new Date("2026-06-13T12:00:00Z");
    expect(isWindowAvailable("2026-06-13", "morning", now)).toBe(false); // 10:00 passed
    expect(isWindowAvailable("2026-06-13", "afternoon", now)).toBe(true); // 14:00 ahead
    expect(isWindowAvailable("2026-06-14", "morning", now)).toBe(true); // future date
  });
});
