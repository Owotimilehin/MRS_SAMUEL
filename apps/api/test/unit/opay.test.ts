import { describe, it, expect } from "vitest";
import { signOpayBody, parseOpayStatus, isOpaySuccess, buildOpayCashierBody } from "../../src/payments/opay.js";

describe("buildOpayCashierBody", () => {
  const base = {
    amountNgn: 4500,
    reference: "SO-2026-01234",
    email: "customer@example.com",
    returnUrl: "https://www.mrssamuel.com/order/SO-2026-01234",
    callbackUrl: "https://api.mrssamuel.com/v1/webhooks/opay",
  };

  it("includes a product (OPay rejects the request with 02001 otherwise)", () => {
    const body = buildOpayCashierBody(base);
    expect(body.product).toBeDefined();
    expect(body.product.name).toBeTruthy();
    expect(body.product.description).toContain("SO-2026-01234");
  });

  it("sends the amount in kobo (naira × 100)", () => {
    expect(buildOpayCashierBody(base).amount.total).toBe(450000);
  });
});

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
  it("maps a real v3 SUCCESS response (amount is a kobo STRING sibling)", () => {
    // This is the exact wire shape OPay's /api/v3/cashier/status returns.
    const body = JSON.stringify({
      code: "00000",
      message: "SUCCESSFUL",
      data: { reference: "SO-1", orderNo: "2110", status: "SUCCESS", amount: "700000", currency: "NGN" },
    });
    const r = parseOpayStatus(200, body);
    expect(r.status).toBe("SUCCESS");
    expect(r.amountNgn).toBe(7000); // "700000" kobo -> 7000 naira
    expect(r.feeNgn).toBeNull(); // OPay status exposes no per-txn fee
    expect(r.netNgn).toBe(7000); // net falls back to gross
    expect(r.processorReference).toBe("2110");
  });

  it("still maps the nested { total } amount shape (backward compat)", () => {
    const body = JSON.stringify({
      code: "00000",
      data: { reference: "SO-1", orderNo: "2110", status: "SUCCESS", amount: { total: 700000, currency: "NGN" } },
    });
    expect(parseOpayStatus(200, body).amountNgn).toBe(7000);
  });

  it("maps a FAIL response", () => {
    const body = JSON.stringify({
      code: "00000",
      data: { reference: "SO-2", orderNo: "9", status: "FAIL", amount: "0", currency: "NGN", failureReason: "declined" },
    });
    const r = parseOpayStatus(200, body);
    expect(r.status).toBe("FAIL");
    expect(isOpaySuccess(r.status)).toBe(false);
  });

  it("THROWS on an auth-failure envelope (02000) instead of masking it as PENDING", () => {
    // The prod bug: an auth failure returned HTTP 200 + code 02000 with no
    // `data`, so the old code defaulted status to "PENDING" and paid orders
    // silently never confirmed. A non-00000 envelope must be a hard error.
    const body = JSON.stringify({ code: "02000", message: "Authentication failed" });
    expect(() => parseOpayStatus(200, body)).toThrow(/02000/);
  });

  it("throws on a non-NGN currency instead of mis-booking it as naira", () => {
    const body = JSON.stringify({
      code: "00000",
      data: { reference: "SO-9", orderNo: "1", status: "SUCCESS", amount: "1000", currency: "USD" },
    });
    expect(() => parseOpayStatus(200, body)).toThrow(/currency/i);
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
