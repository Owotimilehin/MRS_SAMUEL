import { describe, it, expect } from "vitest";
import {
  channelLabel,
  paymentLabel,
  lagosDateLabel,
  sizeMlLabel,
  buildReceiptFromCart,
  buildReturnSlip,
} from "./receipt-data.js";

describe("label mappers", () => {
  it("maps channels", () => {
    expect(channelLabel("walkup")).toBe("Walk-in");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel(null)).toBe("—");
  });
  it("maps payments", () => {
    expect(paymentLabel("transfer")).toBe("Transfer");
    expect(paymentLabel("cash")).toBe("Cash");
  });
  it("formats size", () => {
    expect(sizeMlLabel(330)).toBe("330ml");
    expect(sizeMlLabel(1000)).toBe("1L");
    expect(sizeMlLabel(null)).toBe("");
  });
  it("formats a Lagos datetime", () => {
    // 2026-06-16T20:18:00Z → Lagos is UTC+1 → 21:18
    const label = lagosDateLabel("2026-06-16T20:18:00Z");
    expect(label).toContain("16 Jun 2026");
    expect(label).toContain("21:18");
  });
});

describe("buildReceiptFromCart", () => {
  const base = {
    style: "classic" as const,
    receiptNo: "SO-2026-00008",
    whenIso: "2026-06-16T20:18:00Z",
    branch: { name: "Ajao Estate", address: "30 Asa Afariogun Street", phone: "0706 722 0914" },
    servedBy: "Blessing A.",
    channel: "walkup",
  };

  it("computes line totals and subtotal", () => {
    const r = buildReceiptFromCart({
      ...base,
      payment: "transfer",
      items: [
        { name: "Crimson Garden Glow", sizeMl: 650, qty: 2, unitNgn: 3500 },
        { name: "Pineapple Juice", sizeMl: 330, qty: 1, unitNgn: 2500 },
      ],
    });
    expect(r.lines[0]!.lineNgn).toBe(7000);
    expect(r.subtotalNgn).toBe(9500);
    expect(r.totalNgn).toBe(9500);
    expect(r.cashNgn).toBeUndefined();
  });

  it("computes change for cash sales", () => {
    const r = buildReceiptFromCart({
      ...base,
      payment: "cash",
      cashNgn: 15000,
      items: [{ name: "Tropical Mango", sizeMl: 650, qty: 2, unitNgn: 4500 }],
    });
    expect(r.totalNgn).toBe(9000);
    expect(r.cashNgn).toBe(15000);
    expect(r.changeNgn).toBe(6000);
  });

  it("marks preorders and carries a fulfil label", () => {
    const r = buildReceiptFromCart({
      ...base,
      payment: "transfer",
      isPreorder: true,
      fulfilIso: "2026-06-19T11:00:00Z",
      items: [{ name: "Pure Green", sizeMl: 650, qty: 1, unitNgn: 4500 }],
    });
    expect(r.kind).toBe("preorder");
    expect(r.fulfilLabel).toContain("19 Jun 2026");
  });
});

describe("buildReturnSlip", () => {
  it("carries refund total and reason", () => {
    const r = buildReturnSlip({
      style: "classic",
      returnNumber: "RET-2026-0003",
      createdAtIso: "2026-06-16T20:18:00Z",
      branch: { name: "Ajao Estate", address: null, phone: null },
      servedBy: "Manager",
      items: [{ name: "Crimson Cooler", sizeMl: 650, quantity: 1, unitPriceNgn: 3500, lineTotalNgn: 3500 }],
      refundNgn: 3500,
      reason: "Spoiled",
    });
    expect(r.kind).toBe("return");
    expect(r.refundNgn).toBe(3500);
    expect(r.refundReason).toBe("Spoiled");
  });
});
