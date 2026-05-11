import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "payaza-refund" } });

const BASE = process.env.PAYAZA_API_BASE ?? "https://api.payaza.africa/v1";

/**
 * Call the Payaza refund API. Mirrors the adapter in the api package but
 * runs from the worker so refunds get retried/backed-off like other side
 * effects.
 *
 * Dev mode (no PAYAZA_SECRET_KEY): returns a mock refund reference so the
 * full flow can be exercised without real credentials.
 */
export async function refundPayaza(opts: {
  processorReference: string;
  amountNgn: number;
}): Promise<{ refund_reference: string }> {
  const secret = process.env.PAYAZA_SECRET_KEY;
  if (!secret) {
    logger.warn({ ref: opts.processorReference }, "PAYAZA_SECRET_KEY unset — returning mock refund");
    return { refund_reference: `mock-refund-${Date.now()}` };
  }
  const res = await fetch(`${BASE}/merchant-collection/refund`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      transaction_reference: opts.processorReference,
      amount: opts.amountNgn,
    }),
  });
  if (!res.ok) {
    throw new Error(`payaza refund failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { refund_reference?: string };
    refund_reference?: string;
  };
  return {
    refund_reference: body.data?.refund_reference ?? body.refund_reference ?? "",
  };
}
