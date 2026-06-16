import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPayazaSession,
  verifyPayazaTransaction,
  verifyPayazaSignature,
  isPayazaSuccess,
} from "../../src/payments/payaza.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as never));
}

const baseSession = {
  amountNgn: 100,
  email: "buyer@example.com",
  reference: "ORD-1",
  returnUrl: "https://shop.example/order/ORD-1?paid=1",
  callbackUrl: "https://api.example/v1/webhooks/payaza",
  productName: "Test order",
};

describe("payaza mock mode (no secret key)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("createPayazaSession returns a ?mock=1 loopback URL", async () => {
    vi.stubEnv("PAYAZA_SECRET_KEY", "");
    const s = await createPayazaSession(baseSession);
    expect(s.reference).toBe("ORD-1");
    expect(s.authorization_url).toContain("mock=1");
    expect(s.authorization_url).toContain("reference=ORD-1");
    expect(s.authorization_url.startsWith(baseSession.returnUrl)).toBe(true);
  });

  it("verifyPayazaTransaction returns a mock success with unknown amount", async () => {
    vi.stubEnv("PAYAZA_SECRET_KEY", "");
    const r = await verifyPayazaTransaction("ORD-1");
    expect(isPayazaSuccess(r.status)).toBe(true);
    expect(r.amountNgn).toBeNull();
    expect(r.processorReference).toBe("mock-ORD-1");
  });
});

describe("payaza live mode (secret key set)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("createPayazaSession sends the base64 Payaza auth header by default and parses checkout_url", async () => {
    vi.stubEnv("PAYAZA_SECRET_KEY", "sk_test_123");
    vi.stubEnv("PAYAZA_AUTH_SCHEME", "");
    let seenAuth = "";
    mockFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ data: { checkout_url: "https://pay.example/c/abc" } }), {
        status: 200,
      });
    });
    const s = await createPayazaSession(baseSession);
    expect(s.authorization_url).toBe("https://pay.example/c/abc");
    expect(seenAuth).toBe(`Payaza ${Buffer.from("sk_test_123").toString("base64")}`);
  });

  it("createPayazaSession honors PAYAZA_AUTH_SCHEME=bearer", async () => {
    vi.stubEnv("PAYAZA_SECRET_KEY", "sk_test_123");
    vi.stubEnv("PAYAZA_AUTH_SCHEME", "bearer");
    let seenAuth = "";
    mockFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ authorization_url: "https://pay.example/c/xyz" }), {
        status: 200,
      });
    });
    await createPayazaSession(baseSession);
    expect(seenAuth).toBe("Bearer sk_test_123");
  });

  it("createPayazaSession throws on a non-2xx response", async () => {
    vi.stubEnv("PAYAZA_SECRET_KEY", "sk_test_123");
    mockFetch(() => new Response("bad request", { status: 400 }));
    await expect(createPayazaSession(baseSession)).rejects.toThrow(/payaza initiate failed: 400/);
  });

  it("verifyPayazaTransaction parses amount + status from the data envelope", async () => {
    vi.stubEnv("PAYAZA_SECRET_KEY", "sk_test_123");
    mockFetch(() =>
      new Response(
        JSON.stringify({
          data: { status: "SUCCESSFUL", amount: 2500, provider_reference: "PZ-REF-9" },
        }),
        { status: 200 },
      ),
    );
    const r = await verifyPayazaTransaction("ORD-1");
    expect(r.status).toBe("SUCCESSFUL");
    expect(r.amountNgn).toBe(2500);
    expect(r.processorReference).toBe("PZ-REF-9");
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

  it("accepts a correct HMAC-SHA512 signature and rejects a tampered one", () => {
    vi.stubEnv("PAYAZA_WEBHOOK_SECRET", "whsec");
    const body = JSON.stringify({ data: { transaction_reference: "ORD-1" } });
    const good = crypto.createHmac("sha512", "whsec").update(body).digest("hex");
    expect(verifyPayazaSignature(body, good)).toBe(true);
    expect(verifyPayazaSignature(body + " ", good)).toBe(false);
    expect(verifyPayazaSignature(body, good.replace(/.$/, "0"))).toBe(false);
  });
});

describe("isPayazaSuccess", () => {
  it("recognises the known success spellings, case-insensitively", () => {
    for (const s of ["SUCCESSFUL", "success", "Completed", "PAID"]) {
      expect(isPayazaSuccess(s)).toBe(true);
    }
    for (const s of ["PENDING", "FAILED", "REVERSED", ""]) {
      expect(isPayazaSuccess(s)).toBe(false);
    }
  });
});
