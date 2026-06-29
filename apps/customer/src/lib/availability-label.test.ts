// apps/customer/src/lib/availability-label.test.ts
import { describe, it, expect } from "vitest";
import { isImmediateSchedule } from "@/lib/availability-label";

// 2026-06-29 10:00 UTC -> Lagos 11:00, Lagos date 2026-06-29.
const NOW = new Date("2026-06-29T10:00:00Z");

describe("isImmediateSchedule", () => {
  it("is immediate when the schedule lands today with no fixed window", () => {
    expect(isImmediateSchedule({ date: "2026-06-29" }, NOW)).toBe(true);
  });

  it("is NOT immediate when a fixed window is set (preorder), even today", () => {
    expect(isImmediateSchedule({ date: "2026-06-29", fixedWindow: "evening" }, NOW)).toBe(false);
  });

  it("is NOT immediate when the schedule rolls to a future date", () => {
    expect(isImmediateSchedule({ date: "2026-06-30" }, NOW)).toBe(false);
  });

  it("respects the Lagos date boundary (late-UTC stays same Lagos day)", () => {
    // 2026-06-29 23:30 UTC -> Lagos 00:30 on 2026-06-30.
    const lateUtc = new Date("2026-06-29T23:30:00Z");
    expect(isImmediateSchedule({ date: "2026-06-30" }, lateUtc)).toBe(true);
    expect(isImmediateSchedule({ date: "2026-06-29" }, lateUtc)).toBe(false);
  });
});
