import { describe, expect, it } from "vitest";
import {
  periodRange,
  parseLowStockLevel,
  sortStaffRows,
  staffCsvRows,
  roleLabel,
  type StaffRow,
} from "./staff-stock.js";

describe("periodRange", () => {
  it("today is a single Lagos day", () => {
    expect(periodRange("today", "2026-11-23")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
  });
  it("this week starts on Monday", () => {
    // 2026-11-23 is a Monday; 2026-11-29 is a Sunday.
    expect(periodRange("week", "2026-11-23")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(periodRange("week", "2026-11-29")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(periodRange("week", "2026-12-02")).toEqual({ from: "2026-11-30", to: "2026-12-02" });
  });
  it("this month starts on the 1st", () => {
    expect(periodRange("month", "2026-11-23")).toEqual({ from: "2026-11-01", to: "2026-11-23" });
  });
});

describe("parseLowStockLevel", () => {
  it("empty means use the default", () => {
    expect(parseLowStockLevel("  ")).toEqual({ ok: true, value: null });
  });
  it("accepts whole numbers including 0", () => {
    expect(parseLowStockLevel("0")).toEqual({ ok: true, value: 0 });
    expect(parseLowStockLevel("24")).toEqual({ ok: true, value: 24 });
  });
  it("rejects negatives, decimals and words", () => {
    expect(parseLowStockLevel("-1").ok).toBe(false);
    expect(parseLowStockLevel("2.5").ok).toBe(false);
    expect(parseLowStockLevel("ten").ok).toBe(false);
  });
});

const row = (over: Partial<StaffRow>): StaffRow => ({
  user_id: "u",
  name: "Ada",
  email: "ada@example.com",
  role: "branch_staff",
  branch_id: "b1",
  branch_name: "Lekki",
  orders: 1,
  bottles: 1,
  gross_ngn: 1000,
  refunds_ngn: 0,
  net_ngn: 1000,
  avg_order_ngn: 1000,
  closes_submitted: 0,
  short_count: 0,
  short_total_ngn: 0,
  ...over,
});

describe("sortStaffRows", () => {
  const rows = [row({ name: "Bola", net_ngn: 500 }), row({ name: "Ada", net_ngn: 3000 }), row({ name: "Chi", net_ngn: 1200 })];
  it("sorts numbers both ways", () => {
    expect(sortStaffRows(rows, "net_ngn", "desc").map((r) => r.name)).toEqual(["Ada", "Chi", "Bola"]);
    expect(sortStaffRows(rows, "net_ngn", "asc").map((r) => r.name)).toEqual(["Bola", "Chi", "Ada"]);
  });
  it("sorts names alphabetically", () => {
    expect(sortStaffRows(rows, "name", "asc").map((r) => r.name)).toEqual(["Ada", "Bola", "Chi"]);
  });
  it("does not change the input", () => {
    sortStaffRows(rows, "name", "asc");
    expect(rows[0]!.name).toBe("Bola");
  });
});

describe("staffCsvRows", () => {
  it("uses plain-English headers and readable roles", () => {
    const [out] = staffCsvRows([row({ user_id: null, name: "Online (no staff)", email: null, role: null })]);
    expect(Object.keys(out!)).toContain("Net sales (₦)");
    expect(out!["Staff member"]).toBe("Online (no staff)");
    expect(out!.Role).toBe("—");
    expect(out!.Email).toBe("");
  });
  it("labels roles", () => {
    expect(roleLabel("branch_staff")).toBe("Branch staff");
  });
});
