import crypto from "node:crypto";

export interface PayazaSession {
  reference: string;
  authorization_url: string;
}

/** Payaza transaction states vary by product: SUCCESSFUL | PENDING | FAILED |
 *  REVERSED. Kept as a plain string since Payaza may report states we don't
 *  enumerate; the webhook only treats an explicit success as paid. */
export interface PayazaTransactionStatus {
  status: string;
  amountNgn: number | null;
  processorReference: string | null;
}

const BASE = process.env.PAYAZA_API_BASE ?? "https://api.payaza.africa/live";

/**
 * Build the Authorization header for Payaza. Payaza's docs vary by product —
 * the Connection-mode APIs are documented as `Payaza <base64(secretKey)>`,
 * while some collection endpoints accept a plain `Bearer <secretKey>`. We
 * default to the base64 "Payaza" scheme and leave a one-env escape hatch
 * (PAYAZA_AUTH_SCHEME=bearer) so the scheme can be flipped during the live
 * smoke test without touching code. Isolated here on purpose.
 */
function payazaAuthHeader(): string {
  const secret = process.env.PAYAZA_SECRET_KEY ?? "";
  if ((process.env.PAYAZA_AUTH_SCHEME ?? "payaza-base64").toLowerCase() === "bearer") {
    return `Bearer ${secret}`;
  }
  return `Payaza ${Buffer.from(secret).toString("base64")}`;
}

/**
 * Initiate a Payaza hosted-checkout session and return the URL we redirect the
 * customer to.
 *
 * Dev/test shim: when PAYAZA_SECRET_KEY is absent we return a fake URL that
 * loops back to the customer return URL with ?mock=1 so the webhook (also in
 * mock mode) can auto-complete the order without real keys. Mirrors the shim
 * the OPay client used (now removed) so local checkout stays clickable.
 *
 * NOTE: the live request/response shape below is the best-known shape and is
 * verified by scripts/payaza-smoke.ts against test keys — adjust there, not by
 * guessing. Response parsing is deliberately tolerant of a couple of envelopes.
 */
export async function createPayazaSession(opts: {
  amountNgn: number;
  email: string;
  reference: string;
  returnUrl: string;
  callbackUrl: string;
  productName: string;
  customerName?: string;
  customerPhone?: string;
}): Promise<PayazaSession> {
  if (!process.env.PAYAZA_SECRET_KEY) {
    const sep = opts.returnUrl.includes("?") ? "&" : "?";
    return {
      reference: opts.reference,
      authorization_url: `${opts.returnUrl}${sep}mock=1&reference=${opts.reference}`,
    };
  }

  const payload = {
    amount: opts.amountNgn,
    currency: "NGN",
    email: opts.email,
    transaction_reference: opts.reference,
    callback_url: opts.callbackUrl,
    return_url: opts.returnUrl,
    description: opts.productName,
    ...(opts.customerName ? { customer_name: opts.customerName } : {}),
    ...(opts.customerPhone ? { phone_number: opts.customerPhone } : {}),
  };

  const res = await fetch(`${BASE}/merchant-collection/initiate-payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: payazaAuthHeader(),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`payaza initiate failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { checkout_url?: string; authorization_url?: string };
    checkout_url?: string;
    authorization_url?: string;
  };
  const url =
    body.data?.checkout_url ??
    body.data?.authorization_url ??
    body.checkout_url ??
    body.authorization_url;
  if (!url) {
    throw new Error(`payaza initiate rejected: no checkout url in response`);
  }
  return { reference: opts.reference, authorization_url: url };
}

/**
 * Authoritatively confirm a payment by asking Payaza directly. The webhook uses
 * this rather than trusting the callback body — the signed callback is treated
 * as a wake-up only, and the money decision is gated on this signed
 * server-to-server status read.
 *
 * Dev/test shim: no creds → report SUCCESSFUL with an unknown amount so the
 * mock checkout flow completes (mirrors the create shim). The unknown amount
 * makes the webhook's amount-equality guard skip, exactly like the dev path.
 */
export async function verifyPayazaTransaction(
  reference: string,
): Promise<PayazaTransactionStatus> {
  if (!process.env.PAYAZA_SECRET_KEY) {
    return { status: "SUCCESSFUL", amountNgn: null, processorReference: `mock-${reference}` };
  }
  const res = await fetch(
    `${BASE}/merchant-collection/transaction/${encodeURIComponent(reference)}`,
    {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: payazaAuthHeader(),
      },
    },
  );
  if (!res.ok) {
    throw new Error(`payaza verify failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: {
      status?: string;
      transaction_status?: string;
      amount?: number;
      transaction_reference?: string;
      provider_reference?: string;
    };
    status?: string;
    amount?: number;
  };
  const d = body.data ?? {};
  const amount = d.amount ?? body.amount;
  return {
    status: d.status ?? d.transaction_status ?? body.status ?? "PENDING",
    amountNgn: typeof amount === "number" ? Math.round(amount) : null,
    processorReference: d.provider_reference ?? d.transaction_reference ?? null,
  };
}

/** Payaza reports a success state under a few different spellings. */
export function isPayazaSuccess(status: string): boolean {
  const s = status.toLowerCase();
  return s === "successful" || s === "success" || s === "completed" || s === "paid";
}

/**
 * Verify the HMAC-SHA512 signature Payaza puts on webhook callbacks.
 * Constant-time comparison via timingSafeEqual. When PAYAZA_WEBHOOK_SECRET is
 * unset (dev/mock mode) we accept anything so the mock flow stays exercisable.
 */
export function verifyPayazaSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.PAYAZA_WEBHOOK_SECRET;
  if (!secret) return true; // dev/mock mode
  if (!signature) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
