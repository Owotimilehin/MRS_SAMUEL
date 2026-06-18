import { describe, it, expect } from "vitest";
import { renderReceiptHtml } from "./receipt-html.js";
import type { ReceiptData } from "./receipt-data.js";

const base: ReceiptData = {
  style: "classic",
  kind: "sale",
  receiptNo: "S-1001",
  dateLabel: "17 Jun 2026 · 14:00",
  branchName: "Mrs. Samuel Factory",
  branchAddress: "12 Juice Rd",
  branchPhone: "0901 951 2246",
  servedBy: "Ada",
  channelLabel: "Walk-in",
  paymentLabel: "Cash",
  lines: [
    { name: "Pineapple", sizeMl: 330, qty: 2, unitNgn: 1500, lineNgn: 3000 },
    { name: "Watermelon", sizeMl: 650, qty: 1, unitNgn: 2500, lineNgn: 2500 },
  ],
  subtotalNgn: 5500,
  totalNgn: 5500,
  cashNgn: 6000,
  changeNgn: 500,
};

describe("renderReceiptHtml", () => {
  it("renders an 80mm page with totals and items", () => {
    const html = renderReceiptHtml(base);
    expect(html).toContain("size: 80mm auto");
    expect(html).toContain("MRS. SAMUEL");
    expect(html).toContain("S-1001");
    expect(html).toContain("2 Pineapple 330ml");
    expect(html).toContain("1 Watermelon 650ml");
    // Totals (bare NGN grouping).
    expect(html).toContain("5,500");
    expect(html).toContain("TOTAL");
    expect(html).toContain("Change");
    expect(html).toContain("500");
  });

  it("escapes user-supplied values to prevent broken markup", () => {
    const html = renderReceiptHtml({
      ...base,
      branchName: 'Bad <script>"&',
      lines: [{ name: "Juice <b>", sizeMl: null, qty: 1, unitNgn: 100, lineNgn: 100 }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Juice &lt;b&gt;");
  });

  it("renders a return slip with refund + reason instead of payment", () => {
    const html = renderReceiptHtml({
      ...base,
      kind: "return",
      paymentLabel: "Refund",
      refundNgn: 3000,
      refundReason: "Spoiled",
    });
    expect(html).toContain("RETURN");
    expect(html).toContain("REFUND");
    expect(html).toContain("Reason: Spoiled");
    // Returns don't print a CHANNEL/PAYMENT block.
    expect(html).not.toContain("CHANNEL");
  });
});
