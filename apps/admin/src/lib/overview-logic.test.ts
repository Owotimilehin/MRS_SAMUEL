import { describe, expect, it } from "vitest";
import {
  buildNeeds,
  channelTotals,
  greeting,
  lagosDate,
  lagosWeekStart,
  ngnShort,
  type OverviewData,
} from "./overview-logic.js";

const ov = (over: Partial<OverviewData["fulfilment"]> = {}, stock: Partial<OverviewData["stock"]> = {}): OverviewData => ({
  stock: { low_stock_factory: 0, low_stock_branch: 0, expiring_48h: 0, ...stock },
  fulfilment: {
    pos_orders_today: 0,
    online_orders_today: 0,
    online_pending: 0,
    preorders_open: 0,
    bags_queue: 0,
    pending_transfers: 0,
    ...over,
  },
  today: { total_units: 0, units_by_size: [] },
});

describe("Lagos dates", () => {
  it("rolls to the next day at midnight Lagos, not UTC", () => {
    // 23:30 UTC on 30 Nov is 00:30 on 1 Dec in Lagos.
    expect(lagosDate(new Date("2026-11-30T23:30:00Z"))).toBe("2026-12-01");
  });
  it("week starts on Monday in Lagos", () => {
    // Sunday 22 Nov 23:30 UTC = Monday 23 Nov 00:30 Lagos.
    expect(lagosWeekStart(new Date("2026-11-22T23:30:00Z"))).toBe("2026-11-23");
  });
  it("greets by Lagos hour", () => {
    expect(greeting(new Date("2026-11-23T10:30:00Z"))).toBe("Good morning"); // 11:30 Lagos
    expect(greeting(new Date("2026-11-23T11:30:00Z"))).toBe("Good afternoon"); // 12:30 Lagos
    expect(greeting(new Date("2026-11-23T17:00:00Z"))).toBe("Good evening"); // 18:00 Lagos
  });
});

describe("ngnShort", () => {
  it("shortens for axis labels", () => {
    expect(ngnShort(950)).toBe("₦950");
    expect(ngnShort(962_600)).toBe("₦963k");
    expect(ngnShort(1_250_000)).toBe("₦1.3m");
  });
});

describe("buildNeeds", () => {
  it("is empty when nothing is waiting", () => {
    expect(buildNeeds({ transfer_variances: [], return_approvals: [] }, ov())).toEqual([]);
  });

  it("lists review items first, then live alerts", () => {
    const items = buildNeeds(
      {
        pending_closes: [{ id: "c1", branch_name: "Ajao Estate", business_date: "2026-11-19", variance_ngn: -4500 }],
        transfer_variances: [{ id: "t1", transferNumber: "TRF-2026-00088", status: "received_with_variance" }],
        return_approvals: [{ id: "r1", originalSaleOrderNumber: "SO-10466", refundAmountNgn: 3500 }],
        payment_attention: [
          { id: "p1", order_number: "SO-1", total_ngn: 6000 },
          { id: "p2", order_number: "SO-2", total_ngn: 7500 },
        ],
      },
      ov({ online_pending: 4, online_orders_today: 26 }, { low_stock_factory: 2, low_stock_branch: 1 }),
    );
    expect(items.map((i) => i.key)).toEqual(["close-c1", "xfer-t1", "ret-r1", "payments", "online", "lowstock"]);
    expect(items[0]!.tone).toBe("bad");
    expect(items[0]!.detail).toContain("short");
    expect(items[3]!.title).toBe("2 payments to check");
    expect(items[4]!.title).toBe("4 online orders awaiting fulfilment");
  });

  it("works for staff who can't see the review list", () => {
    expect(buildNeeds(null, ov({ online_pending: 1, online_orders_today: 1 })).map((i) => i.title)).toEqual([
      "1 online order awaiting fulfilment",
    ]);
  });
});

describe("channelTotals", () => {
  it("keeps a fixed order and folds unknown channels into Other", () => {
    const t = channelTotals([
      { channel: "online", net_ngn: 500 },
      { channel: "walkup", net_ngn: 100 },
      { channel: "chowdeck_pickup", net_ngn: 50 },
      { channel: "online", net_ngn: 500 },
    ]);
    expect(t.map((c) => [c.key, c.net])).toEqual([
      ["walkup", 100],
      ["online", 1000],
      ["other", 50],
    ]);
  });
});
