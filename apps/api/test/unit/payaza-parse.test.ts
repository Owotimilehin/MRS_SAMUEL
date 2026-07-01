import { describe, it, expect } from "vitest";
import { parsePayazaBody } from "../../src/payments/payaza.js";

describe("parsePayazaBody", () => {
  it("reads gross, fee, and derives net from a fee-inclusive success body", () => {
    const body = JSON.stringify({
      success: true,
      data: {
        transaction_status: "Completed",
        amount_received: 3600,
        fee: 100,
        transaction_reference: "P-C-1",
      },
    });
    const s = parsePayazaBody(200, body);
    expect(s.status).toBe("Completed");
    expect(s.amountNgn).toBe(3600); // gross
    expect(s.feeNgn).toBe(100);
    expect(s.netNgn).toBe(3500); // 3600 - 100
    expect(s.processorReference).toBe("P-C-1");
  });

  it("prefers an explicit settlement field for net when present", () => {
    const body = JSON.stringify({
      success: true,
      data: { transaction_status: "Completed", amount_received: 3600, charge: 100, settlement_amount: 3500 },
    });
    const s = parsePayazaBody(200, body);
    expect(s.netNgn).toBe(3500);
    expect(s.feeNgn).toBe(100);
  });

  it("leaves fee and net null when Payaza reports no fee field (fallback path)", () => {
    const body = JSON.stringify({
      success: true,
      data: { transaction_status: "Completed", amount_received: 3500 },
    });
    const s = parsePayazaBody(200, body);
    expect(s.amountNgn).toBe(3500);
    expect(s.feeNgn).toBeNull();
    expect(s.netNgn).toBeNull();
  });

  it("throws on 401/403/5xx (real upstream errors)", () => {
    expect(() => parsePayazaBody(401, "nope")).toThrow(/payaza verify failed/);
  });

  it("returns raw for display", () => {
    const body = JSON.stringify({ success: true, data: { transaction_status: "Completed", amount_received: 3600, fee: 100 } });
    const s = parsePayazaBody(200, body);
    expect(s.raw).toMatchObject({ data: { fee: 100 } });
  });
});
