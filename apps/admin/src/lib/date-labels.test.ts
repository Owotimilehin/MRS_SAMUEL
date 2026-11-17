import { describe, expect, it } from "vitest";
import { dayLabel, dayRangeLabel, monthLabel } from "./date-labels.js";

describe("date labels", () => {
  it("turns a computer month into a month name", () => {
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });
  it("turns a computer date into the app's day style", () => {
    expect(dayLabel("2026-11-17")).toBe("17 Nov 2026");
    expect(dayLabel("2026-11-01T00:00:00.000Z")).toBe("1 Nov 2026");
  });
  it("leaves unknown shapes alone and shows a dash for nothing", () => {
    expect(monthLabel("all time")).toBe("all time");
    expect(dayLabel("soon")).toBe("soon");
    expect(monthLabel(null)).toBe("—");
    expect(dayLabel(undefined)).toBe("—");
  });
  it("joins a range and collapses a single day", () => {
    expect(dayRangeLabel("2026-11-16", "2026-11-17")).toBe("16 Nov 2026 – 17 Nov 2026");
    expect(dayRangeLabel("2026-11-17", "2026-11-17")).toBe("17 Nov 2026");
  });
});
