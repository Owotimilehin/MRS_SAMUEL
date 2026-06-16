import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPayazaCheckoutConfig,
  verifyPayazaTransaction,
  verifyPayazaSignature,
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

  it("returns Mock mode with no public key (dev shim)", () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "");
    const cfg = buildPayazaCheckoutConfig(baseConfig);
    expect(cfg.connectionMode).toBe("Mock");
    expect(cfg.amount).toBe(2500 * 100); // kobo
    expect(cfg.firstName).toBe("Ada");
    expect(cfg.lastName).toBe("Obi");
    expect(cfg.phone).toBe("+2348025551234");
    expect(cfg.reference).toBe("ORD-1");
  });

  it("detects Test mode from a PKTEST public key", () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "PZ78-PKTEST-ABC");
    expect(buildPayazaCheckoutConfig(baseConfig).connectionMode).toBe("Test");
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

  it("returns a mock Completed status with no public key", async () => {
    vi.stubEnv("PAYAZA_PUBLIC_KEY", "");
    const r = await verifyPayazaTransaction("ORD-1");
    expect(isPayazaSuccess(r.status)).toBe(true);
    expect(r.amountNgn).toBeNull();
    expect(r.processorReference).toBe("mock-ORD-1");
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

describe("verifyPayazaSignature", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts anything when no webhook secret is configured (dev/mock)", () => {
    vi.stubEnv("PAYAZA_WEBHOOK_SECRET", "");
    expect(verifyPayazaSignature("{}", null)).toBe(true);
    expect(verifyPayazaSignature("{}", "whatever")).toBe(true);
  });

  it("rejects when a secret is set but no signature is sent", () => {
    vi.stubEnv("PAYAZA_WEBHOOK_SECRET", "whsec");
    expect(verifyPayazaSignature("{}", null)).toBe(false);
  });

  it("accepts a correct HMAC-SHA256 signature and rejects a tampered one", () => {
    vi.stubEnv("PAYAZA_WEBHOOK_SECRET", "whsec");
    const body = JSON.stringify({ data: { transaction_reference: "ORD-1" } });
    const good = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
    expect(verifyPayazaSignature(body, good)).toBe(true);
    expect(verifyPayazaSignature(body + " ", good)).toBe(false);
    expect(verifyPayazaSignature(body, good.replace(/.$/, "0"))).toBe(false);
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
