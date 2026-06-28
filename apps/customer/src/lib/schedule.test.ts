import { describe, it, expect } from "vitest";
import { WINDOWS, scheduledIso, availableWindows } from "./schedule";

describe("schedule re-exports from @ms/shared", () => {
  it("WINDOWS covers all three windows", () => {
    expect(Object.keys(WINDOWS)).toEqual(["morning", "afternoon", "evening"]);
  });

  it("scheduledIso maps windows to Lagos anchor times (+01:00)", () => {
    expect(scheduledIso("2026-06-13", "morning")).toBe("2026-06-13T09:00:00+01:00");
    expect(scheduledIso("2026-06-13", "afternoon")).toBe("2026-06-13T14:00:00+01:00");
    expect(scheduledIso("2026-06-13", "evening")).toBe("2026-06-13T18:00:00+01:00");
  });

  it("availableWindows excludes morning on Sunday (dow=0)", () => {
    expect(availableWindows(0)).toEqual(["afternoon", "evening"]);
  });

  it("availableWindows returns all three on a weekday", () => {
    expect(availableWindows(3)).toEqual(["morning", "afternoon", "evening"]); // Wednesday
  });
});
