import { describe, it, expect } from "vitest";
import {
  BRANCH_EXPENSE_CATEGORIES,
  BRANCH_EXPENSE_CATEGORY_LABEL,
  shiftDays,
  branchExpenseDateProblem,
  lagosDate,
  mondayOf,
} from "./branch-expenses.js";

describe("branch expense categories", () => {
  it("leaves out head-office categories and packaging", () => {
    for (const c of ["salaries", "rent", "marketing", "regulatory", "packaging"]) {
      expect(BRANCH_EXPENSE_CATEGORIES as readonly string[]).not.toContain(c);
    }
  });
  it("has a plain-English label for every category", () => {
    for (const c of BRANCH_EXPENSE_CATEGORIES) expect(BRANCH_EXPENSE_CATEGORY_LABEL[c]).toBeTruthy();
  });
});

describe("lagosDate", () => {
  it("rolls over at midnight Lagos time (23:00 UTC)", () => {
    expect(lagosDate(new Date("2026-11-22T22:59:00Z"))).toBe("2026-11-22");
    expect(lagosDate(new Date("2026-11-22T23:00:00Z"))).toBe("2026-11-23");
  });
});

describe("shiftDays / mondayOf", () => {
  it("crosses month ends", () => {
    expect(shiftDays("2026-12-01", -1)).toBe("2026-11-30");
  });
  it("weeks start on Monday", () => {
    expect(mondayOf("2026-11-23")).toBe("2026-11-23"); // Monday
    expect(mondayOf("2026-11-29")).toBe("2026-11-23"); // Sunday
    expect(mondayOf("2026-11-25")).toBe("2026-11-23");
  });
});

describe("branchExpenseDateProblem", () => {
  const now = new Date("2026-11-23T10:00:00Z"); // Lagos 2026-11-23
  it("accepts today and up to 7 days back", () => {
    expect(branchExpenseDateProblem("2026-11-23", now)).toBeNull();
    expect(branchExpenseDateProblem("2026-11-16", now)).toBeNull();
  });
  it("rejects the future", () => {
    expect(branchExpenseDateProblem("2026-11-24", now)).toMatch(/future/);
  });
  it("rejects older than 7 days", () => {
    expect(branchExpenseDateProblem("2026-11-15", now)).toMatch(/last 7 days/);
  });
  it("rejects nonsense dates", () => {
    expect(branchExpenseDateProblem("2026-02-30", now)).toMatch(/real date/);
    expect(branchExpenseDateProblem("yesterday", now)).toMatch(/real date/);
  });
});
