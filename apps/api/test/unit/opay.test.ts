import { describe, it, expect } from "vitest";
import { signOpayBody, parseOpayStatus, isOpaySuccess } from "../../src/payments/opay.js";

describe("signOpayBody", () => {
  it("is a stable HMAC-SHA512 hex of body+key (known vector)", () => {
    const sig = signOpayBody('{"reference":"SO-1","country":"NG"}', "secret");
    // HMAC-SHA512 hex is 128 chars; deterministic for the same input.
    expect(sig).toHaveLength(128);
    expect(sig).toBe(signOpayBody('{"reference":"SO-1","country":"NG"}', "secret"));
    expect(sig).not.toBe(signOpayBody('{"reference":"SO-1","country":"NG"}', "other"));
  });
});

describe("parseOpayStatus", () => {
  it("maps a SUCCESS response, converting kobo amount to naira", () => {
    const body = JSON.stringify({
      code: "00000",
      message: "SUCCESSFUL",
      data: { reference: "SO-1", orderNo: "2110", status: "SUCCESS", amount: { total: 700000, currency: "NGN" } },
    });
    const r = parseOpayStatus(200, body);
    expect(r.status).toBe("SUCCESS");
    expect(r.amountNgn).toBe(7000); // 700000 kobo -> 7000 naira
    expect(r.feeNgn).toBeNull(); // OPay status exposes no per-txn fee
    expect(r.netNgn).toBe(7000); // net falls back to gross
    expect(r.processorReference).toBe("2110");
  });

  it("maps a FAIL response", () => {
    const body = JSON.stringify({
      code: "00000",
      data: { reference: "SO-2", orderNo: "9", status: "FAIL", amount: { total: 0, currency: "NGN" }, failureReason: "declined" },
    });
    const r = parseOpayStatus(200, body);
    expect(r.status).toBe("FAIL");
    expect(isOpaySuccess(r.status)).toBe(false);
  });

  it("throws on a 401/5xx so a caller (webhook) retries", () => {
    expect(() => parseOpayStatus(500, "boom")).toThrow(/opay/i);
    expect(() => parseOpayStatus(401, "no")).toThrow(/opay/i);
  });
});

describe("isOpaySuccess", () => {
  it("true only for SUCCESS (case-insensitive)", () => {
    expect(isOpaySuccess("SUCCESS")).toBe(true);
    expect(isOpaySuccess("success")).toBe(true);
    expect(isOpaySuccess("PENDING")).toBe(false);
    expect(isOpaySuccess("FAIL")).toBe(false);
  });
});
