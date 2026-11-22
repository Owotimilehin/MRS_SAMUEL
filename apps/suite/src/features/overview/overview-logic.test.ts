import { describe, expect, it } from "vitest";
import {
  compare,
  daysIn,
  nairaFull,
  nairaShort,
  nairaTick,
  ordersText,
  previousRange,
  salesByChannel,
  salesTotals,
  type RevenueRow,
} from "./overview-logic.js";

const row = (channel: string, net: number, orders: number, branch = "b1"): RevenueRow => ({
  branch_id: branch,
  channel,
  gross_ngn: net,
  refunds_ngn: 0,
  net_ngn: net,
  orders,
});

describe("previousRange", () => {
  it("is the same number of days straight before", () => {
    expect(previousRange("2026-11-16", "2026-11-22")).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
  });
  it("today compares with yesterday", () => {
    expect(previousRange("2026-11-22", "2026-11-22")).toEqual({
      from: "2026-11-21",
      to: "2026-11-21",
    });
  });
  it("crosses month and year ends", () => {
    expect(previousRange("2026-03-01", "2026-03-30")).toEqual({
      from: "2026-01-30",
      to: "2026-02-28",
    });
    expect(previousRange("2027-01-01", "2027-01-07")).toEqual({
      from: "2026-12-25",
      to: "2026-12-31",
    });
  });
  it("counts days both ends included", () => {
    expect(daysIn("2026-11-16", "2026-11-22")).toBe(7);
    expect(daysIn("2026-08-25", "2026-11-22")).toBe(90);
  });
});

describe("compare", () => {
  it("says nothing when both periods are empty", () => {
    expect(compare(0, 0)).toBeNull();
  });
  it("gives a rounded percentage up or down", () => {
    expect(compare(112, 100)).toEqual({ direction: "up", text: "+12%" });
    expect(compare(92, 100)).toEqual({ direction: "down", text: "−8%" });
    expect(compare(100, 100)).toEqual({ direction: "same", text: "Same" });
    expect(compare(1001, 1000)).toEqual({ direction: "same", text: "Same" });
  });
  it("never divides by zero", () => {
    expect(compare(5000, 0)).toEqual({ direction: "up", text: "New" });
    expect(compare(0, 5000)).toEqual({ direction: "down", text: "−100%" });
  });
});

describe("naira", () => {
  it("writes whole naira with commas", () => {
    expect(nairaFull(336000)).toBe("₦336,000");
    expect(nairaFull(0)).toBe("₦0");
    expect(nairaFull(4500.4)).toBe("₦4,500");
    expect(nairaFull(-2000)).toBe("−₦2,000");
  });
  it("shortens millions to three figures", () => {
    expect(nairaShort(336000)).toBe("₦336,000");
    expect(nairaShort(999_999)).toBe("₦999,999");
    expect(nairaShort(3_120_000)).toBe("₦3.12M");
    expect(nairaShort(3_000_000)).toBe("₦3M");
    expect(nairaShort(31_240_000)).toBe("₦31.2M");
    expect(nairaShort(312_400_000)).toBe("₦312M");
  });
  it("writes short axis ticks", () => {
    expect(nairaTick(0)).toBe("₦0");
    expect(nairaTick(500)).toBe("₦500");
    expect(nairaTick(4500)).toBe("₦4.5k");
    expect(nairaTick(45000)).toBe("₦45k");
    expect(nairaTick(1_200_000)).toBe("₦1.2M");
  });
  it("counts orders in words", () => {
    expect(ordersText(1)).toBe("1 order");
    expect(ordersText(12)).toBe("12 orders");
  });
});

describe("sales", () => {
  const rows = [
    row("walkup", 200000, 40),
    row("walkup", 50000, 10, "b2"),
    row("online", 80000, 8),
    row("whatsapp", 6000, 1),
  ];

  it("adds takings and orders over branches and channels", () => {
    expect(salesTotals(rows)).toEqual({ net: 336000, orders: 59 });
    expect(salesTotals([])).toEqual({ net: 0, orders: 0 });
  });

  it("splits by where the sale was made, largest first", () => {
    expect(salesByChannel(rows, null)).toEqual([
      { key: "till", label: "Shop till", net: 250000, orders: 50 },
      { key: "website", label: "Website", net: 80000, orders: 8 },
      { key: "whatsapp", label: "WhatsApp", net: 6000, orders: 1 },
    ]);
  });

  it("moves chat-cart orders from Website to WhatsApp", () => {
    const s = salesByChannel(rows, { orders: 3, gross_ngn: 30000 });
    expect(s.find((x) => x.key === "website")).toEqual({
      key: "website",
      label: "Website",
      net: 50000,
      orders: 5,
    });
    expect(s.find((x) => x.key === "whatsapp")).toEqual({
      key: "whatsapp",
      label: "WhatsApp",
      net: 36000,
      orders: 4,
    });
    expect(salesTotals(rows).net).toBe(s.reduce((a, x) => a + x.net, 0));
  });

  it("drops Website when every online order came from a chat, and never goes negative", () => {
    const s = salesByChannel([row("online", 20000, 2)], { orders: 3, gross_ngn: 30000 });
    expect(s).toEqual([{ key: "whatsapp", label: "WhatsApp", net: 20000, orders: 2 }]);
  });

  it("keeps a refund-only channel and names unknown channels Other", () => {
    const s = salesByChannel(
      [row("phone", -2000, 0), row("chowdeck_pickup", 9000, 2), row("pigeon", 100, 1)],
      null,
    );
    expect(s.map((x) => x.label)).toEqual(["Chowdeck", "Other", "Phone orders"]);
  });
});
