import { describe, it, expect } from "vitest";
import {
  buildStaffReport,
  staffReportTotals,
  summariseLowStock,
  lowStockLevelFor,
  DEFAULT_LOW_STOCK_LEVEL,
  ONLINE_NO_STAFF,
  type LowStockRow,
} from "./staff-report.js";

const users = [
  { id: "u1", name: "Ada", email: "ada@example.com", role: "branch_staff" },
  { id: "u2", name: null, email: "bola@example.com", role: "manager" },
];
const branches = [
  { id: "b1", name: "Lekki" },
  { id: "b2", name: "Ikeja" },
];

describe("buildStaffReport", () => {
  it("merges sales, refunds and closes per user and branch, with net and average", () => {
    const rows = buildStaffReport({
      sales: [
        { user_id: "u1", branch_id: "b1", orders: 3, bottles: 7, gross_ngn: 15000 },
        { user_id: "u2", branch_id: "b2", orders: 1, bottles: 2, gross_ngn: 5000 },
        { user_id: null, branch_id: "b1", orders: 2, bottles: 4, gross_ngn: 9000 },
      ],
      refunds: [{ user_id: "u1", branch_id: "b1", refunds_ngn: 2500 }],
      closes: [{ user_id: "u2", branch_id: "b2", closes: 2, short_count: 1, short_total_ngn: 700 }],
      users,
      branches,
    });

    expect(rows.map((r) => r.name)).toEqual(["Ada", ONLINE_NO_STAFF, "bola@example.com"]);
    const ada = rows[0]!;
    expect(ada).toMatchObject({
      branch_name: "Lekki",
      role: "branch_staff",
      orders: 3,
      bottles: 7,
      gross_ngn: 15000,
      refunds_ngn: 2500,
      net_ngn: 12500,
      avg_order_ngn: 5000,
      short_count: 0,
    });
    const online = rows[1]!;
    expect(online.user_id).toBeNull();
    expect(online.email).toBeNull();
    const bola = rows[2]!;
    expect(bola).toMatchObject({ closes_submitted: 2, short_count: 1, short_total_ngn: 700, branch_name: "Ikeja" });
  });

  it("gives a row to someone who only submitted a close or only had a refund", () => {
    const rows = buildStaffReport({
      sales: [],
      refunds: [{ user_id: "u1", branch_id: "b1", refunds_ngn: 1000 }],
      closes: [{ user_id: "u2", branch_id: "b1", closes: 1, short_count: 0, short_total_ngn: 0 }],
      users,
      branches,
    });
    expect(rows).toHaveLength(2);
    const ada = rows.find((r) => r.user_id === "u1")!;
    expect(ada.net_ngn).toBe(-1000);
    expect(ada.avg_order_ngn).toBe(0);
  });

  it("splits one person across two branches", () => {
    const rows = buildStaffReport({
      sales: [
        { user_id: "u1", branch_id: "b1", orders: 1, bottles: 1, gross_ngn: 2000 },
        { user_id: "u1", branch_id: "b2", orders: 1, bottles: 1, gross_ngn: 3000 },
      ],
      refunds: [],
      closes: [],
      users,
      branches,
    });
    expect(rows.map((r) => r.branch_name)).toEqual(["Ikeja", "Lekki"]);
  });

  it("totals add up and coerce string numbers from the driver", () => {
    const rows = buildStaffReport({
      sales: [
        { user_id: "u1", branch_id: "b1", orders: "2" as unknown as number, bottles: 3, gross_ngn: "4001" as unknown as number },
        { user_id: "u2", branch_id: "b1", orders: 1, bottles: 1, gross_ngn: 1000 },
      ],
      refunds: [{ user_id: "u2", branch_id: "b1", refunds_ngn: 500 }],
      closes: [],
      users,
      branches,
    });
    const t = staffReportTotals(rows);
    expect(t).toMatchObject({ orders: 3, bottles: 4, gross_ngn: 5001, refunds_ngn: 500, net_ngn: 4501, avg_order_ngn: 1667 });
  });
});

describe("summariseLowStock", () => {
  const row = (over: Partial<LowStockRow>): LowStockRow => ({
    location_type: "branch",
    location_id: "b1",
    location_name: "Lekki",
    variant_id: "v1",
    product_name: "Zobo",
    size_ml: 330,
    balance: 5,
    level: 10,
    ...over,
  });

  it("counts per location, includes zero stock, and puts the emptiest first", () => {
    const out = summariseLowStock([
      row({ balance: 5 }),
      row({ location_id: "b2", location_name: "Ikeja", balance: 0 }),
      row({ location_type: "factory", location_id: "f1", location_name: "Factory", balance: 3, level: 3 }),
      row({ balance: 20, level: 25, product_name: "Tiger nut" }),
      row({ balance: 11, level: 10, product_name: "Not low" }),
    ]);
    expect(out.low_stock_branch).toBe(3);
    expect(out.low_stock_factory).toBe(1);
    expect(out.low_stock_items.map((i) => i.balance)).toEqual([0, 3, 5, 20]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ variant_id: `v${i}`, balance: i % 10 }));
    expect(summariseLowStock(many).low_stock_items).toHaveLength(20);
    expect(summariseLowStock(many).low_stock_branch).toBe(30);
  });
});

describe("lowStockLevelFor", () => {
  it("uses the default when unset and keeps an explicit 0", () => {
    expect(lowStockLevelFor(null)).toBe(DEFAULT_LOW_STOCK_LEVEL);
    expect(lowStockLevelFor(undefined)).toBe(10);
    expect(lowStockLevelFor(0)).toBe(0);
    expect(lowStockLevelFor(25)).toBe(25);
  });
});
