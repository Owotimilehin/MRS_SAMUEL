import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPayazaCheckoutConfig,
  verifyPayazaTransaction,
  isPayazaSuccess,
} from "../../src/payments/payaza.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as never));
}

const baseConfig = {
  amountNgn: 2500,
  email: "buyer@example.com",
  reference: "ORD-1",
  customerName: "Ada Obi",
  customerPhone: "+2348025551234",
};

describe("buildPayazaCheckoutConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws (no fake checkout) when the public key is missing", () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "");
    expect(() => buildPayazaCheckoutConfig(baseConfig)).toThrow(/PAYAZA_PUBLIC_KEY/);
  });

  it("detects Test mode from a PKTEST public key", () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "PZ78-PKTEST-ABC");
    const cfg = buildPayazaCheckoutConfig(baseConfig);
    expect(cfg.connectionMode).toBe("Test");
    expect(cfg.amount).toBe(2500 * 100); // kobo
    expect(cfg.firstName).toBe("Ada");
    expect(cfg.lastName).toBe("Obi");
    expect(cfg.phone).toBe("+2348025551234");
    expect(cfg.reference).toBe("ORD-1");
  });

  it("detects Live mode from a PKLIVE public key", () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "PZ78-PKLIVE-XYZ");
    const cfg = buildPayazaCheckoutConfig(baseConfig);
    expect(cfg.connectionMode).toBe("Live");
    expect(cfg.merchantKey).toBe("PZ78-PKLIVE-XYZ");
  });
});

describe("verifyPayazaTransaction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("throws (refuses to confirm) when the public key is missing", async () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "");
    await expect(verifyPayazaTransaction("ORD-1")).rejects.toThrow(/PAYAZA_PUBLIC_KEY/);
  });

  it("sends the base64 public-key auth header and queries by merchant_reference", async () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "pub_test_123");
    let seenAuth = "";
    let seenUrl = "";
    mockFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).authorization;
      return new Response(
        JSON.stringify({
          success: true,
          data: { transaction_status: "Completed", amount_received: 2500, transaction_reference: "PZ-9" },
        }),
        { status: 200 },
      );
    });
    const r = await verifyPayazaTransaction("ORD-1");
    expect(seenAuth).toBe(`Payaza ${Buffer.from("pub_test_123").toString("base64")}`);
    expect(seenUrl).toContain("transfer_notification_controller/merchant/transaction-query");
    expect(seenUrl).toContain("merchant_reference=ORD-1");
    expect(r.status).toBe("Completed");
    expect(r.amountNgn).toBe(2500); // full naira units, not cents
    expect(r.processorReference).toBe("PZ-9");
  });

  it("treats a 400 'not found' envelope as a non-success status, not an error", async () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "pub_test_123");
    mockFetch(() =>
      new Response(JSON.stringify({ success: false, data: null, message: "Transaction not found" }), {
        status: 400,
      }),
    );
    const r = await verifyPayazaTransaction("UNKNOWN");
    expect(isPayazaSuccess(r.status)).toBe(false);
    expect(r.amountNgn).toBeNull();
  });

  it("throws on a 401 (auth failure) so it can be surfaced + retried", async () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "pub_test_123");
    mockFetch(() => new Response("Unauthorized", { status: 401 }));
    await expect(verifyPayazaTransaction("ORD-1")).rejects.toThrow(/payaza verify failed: 401/);
  });
});

describe("isPayazaSuccess", () => {
  it("recognises only Completed (case-insensitively)", () => {
    expect(isPayazaSuccess("Completed")).toBe(true);
    expect(isPayazaSuccess("completed")).toBe(true);
    for (const s of ["PENDING", "FAILED", "successful", "paid", ""]) {
      expect(isPayazaSuccess(s)).toBe(false);
    }
  });
});
