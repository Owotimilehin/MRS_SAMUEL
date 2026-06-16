import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "payaza-refund" } });

// `||` not `??` — empty string in .env should fall back to the default.
const BASE = process.env.PAYAZA_API_BASE || "https://api.payaza.africa/live";

/**
 * Build the Authorization header for Payaza. Mirrors the helper in apps/api's
 * payaza client (default `Payaza <base64(secretKey)>`, PAYAZA_AUTH_SCHEME=bearer
 * escape hatch). Kept self-contained so the worker doesn't depend on @ms/api.
 */
function payazaAuthHeader(): string {
  const secret = process.env.PAYAZA_SECRET_KEY ?? "";
  if ((process.env.PAYAZA_AUTH_SCHEME || "payaza-base64").toLowerCase() === "bearer") {
    return `Bearer ${secret}`;
  }
  return `Payaza ${Buffer.from(secret).toString("base64")}`;
}

/**
 * Refund a Payaza payment. Runs from the worker so refunds get retried/backed
 * off like other side effects. `processorReference` is the Payaza reference we
 * stored on the payment row.
 *
 * Dev mode (no Payaza creds): returns a mock refund reference so the full flow
 * can be exercised without real credentials.
 */
export async function refundPayaza(opts: {
  processorReference: string;
  amountNgn: number;
}): Promise<{ refund_reference: string }> {
  if (!process.env.PAYAZA_SECRET_KEY) {
    logger.warn({ ref: opts.processorReference }, "Payaza creds unset — returning mock refund");
    return { refund_reference: `mock-refund-${Date.now()}` };
  }
  const res = await fetch(`${BASE}/merchant-collection/refund`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: payazaAuthHeader() },
    body: JSON.stringify({
      transaction_reference: opts.processorReference,
      amount: opts.amountNgn,
      currency: "NGN",
      reason: "customer return",
    }),
  });
  if (!res.ok) {
    throw new Error(`payaza refund failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { refund_reference?: string; reference?: string };
    refund_reference?: string;
  };
  return {
    refund_reference:
      body.data?.refund_reference ?? body.data?.reference ?? body.refund_reference ?? "",
  };
}
