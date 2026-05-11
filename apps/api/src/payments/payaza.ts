import crypto from "node:crypto";

export interface PayazaSession {
  reference: string;
  authorization_url: string;
}

const BASE = process.env.PAYAZA_API_BASE ?? "https://api.payaza.africa/v1";

/**
 * Initiate a Payaza checkout. Returns the URL we redirect the customer to.
 * The webhook handler verifies completion via HMAC + processor reference.
 *
 * If PAYAZA_SECRET_KEY isn't set (dev mode, no real keys yet) we return a
 * fake authorization_url that loops back to our own /pay-mock endpoint so
 * the flow stays clickable without a real payment provider.
 */
export async function createPayazaSession(opts: {
  amountNgn: number;
  email: string;
  reference: string;
  callbackUrl: string;
}): Promise<PayazaSession> {
  const secret = process.env.PAYAZA_SECRET_KEY;
  if (!secret) {
    // Dev shim — auto-success on the callback URL
    return {
      reference: opts.reference,
      authorization_url: `${opts.callbackUrl}?mock=1&reference=${opts.reference}`,
    };
  }

  const res = await fetch(`${BASE}/merchant-collection/initiate-payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      amount: opts.amountNgn,
      currency: "NGN",
      email: opts.email,
      transaction_reference: opts.reference,
      callback_url: opts.callbackUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(`payaza initiate failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { checkout_url?: string };
    checkout_url?: string;
  };
  return {
    reference: opts.reference,
    authorization_url: body.data?.checkout_url ?? body.checkout_url ?? "",
  };
}

/**
 * Verify the HMAC-SHA512 signature Payaza puts on webhook callbacks.
 * Constant-time comparison via timingSafeEqual.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.PAYAZA_WEBHOOK_SECRET;
  if (!secret) return true; // dev mode: accept anything
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

export async function refundPayaza(opts: {
  processorReference: string;
  amountNgn: number;
}): Promise<{ refund_reference: string }> {
  const secret = process.env.PAYAZA_SECRET_KEY;
  if (!secret) {
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
  if (!res.ok) throw new Error(`payaza refund failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { refund_reference?: string };
    refund_reference?: string;
  };
  return {
    refund_reference: body.data?.refund_reference ?? body.refund_reference ?? "",
  };
}
