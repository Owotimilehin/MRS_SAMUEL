import { describe, expect, it } from "vitest";
import { periodDays, nextChargeAfter, PAST_DUE_GRACE_DAYS } from "./subscription-period.js";

describe("periodDays", () => {
  it("maps known periods", () => {
    expect(periodDays("weekly")).toBe(7);
    expect(periodDays("biweekly")).toBe(14);
    expect(periodDays("monthly")).toBe(30);
  });

  it("is case/space insensitive", () => {
    expect(periodDays(" Weekly ")).toBe(7);
    expect(periodDays("MONTHLY")).toBe(30);
  });

  it("defaults unknown labels to monthly", () => {
    expect(periodDays("fortnightly-ish")).toBe(30);
  });
});

describe("nextChargeAfter", () => {
  it("adds one period to the given date", () => {
    const from = new Date("2026-06-01T00:00:00.000Z");
    expect(nextChargeAfter("weekly", from).toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(nextChargeAfter("monthly", from).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("PAST_DUE_GRACE_DAYS", () => {
  it("is 7 days", () => {
    expect(PAST_DUE_GRACE_DAYS).toBe(7);
  });
});
