/**
 * Init config for Payaza's frontend checkout SDK
 * (https://checkout-v2.payaza.africa/js/v1/bundle.js). Payaza has no
 * server-side "create session" endpoint — the popup is opened client-side with
 * the public key + order details, so the server's job is to hand the customer
 * page exactly these params. Field names match the SDK (confirmed against
 * Payaza's WooCommerce plugin). `amount` is in kobo (naira × 100).
 */
export interface PayazaCheckoutConfig {
  reference: string;
  /** Selected from the public key prefix: "Test" (PKTEST) or "Live" (PKLIVE).
   *  There is no "Mock": without a key we cannot take — or confirm — a payment,
   *  so config-building throws rather than producing a fake checkout. */
  connectionMode: "Test" | "Live";
  merchantKey: string;
  amount: number;
  currency: "NGN";
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/** Payaza transaction states vary by product: SUCCESSFUL | PENDING | FAILED |
 *  REVERSED. Kept as a plain string since Payaza may report states we don't
 *  enumerate; the webhook only treats an explicit success as paid. */
export interface PayazaTransactionStatus {
  status: string;
  amountNgn: number | null;
  processorReference: string | null;
  /** Reusable card authorization captured for recurring subscription charges. */
  authorization: { token: string; reusable: boolean } | null;
}

// `||` not `??` — empty string in .env should fall back to the default, not
// produce a relative URL.
const BASE = process.env.PAYAZA_API_BASE || "https://api.payaza.africa/live";

/**
 * Build the Authorization header for Payaza's read endpoints. Confirmed against
 * Payaza's official WooCommerce plugin: the merchant transaction-query API
 * authenticates with the base64-encoded **public** key, prefixed with "Payaza ".
 */
function payazaReadAuthHeader(): string {
  const publicKey = process.env.PAYAZA_PUBLIC_KEY ?? "";
  return `Payaza ${Buffer.from(publicKey).toString("base64")}`;
}

/**
 * Build the config the customer page passes to the Payaza checkout SDK. Pure +
 * synchronous — there is no server call here (Payaza's checkout is client-side).
 *
 * Requires PAYAZA_PUBLIC_KEY: without it we cannot open a real Payaza checkout,
 * and there is deliberately no mock fallback (a missing key must surface as a
 * hard error, never a fake "paid" path). Order creation that reaches here
 * without a key fails loudly instead of taking an unpayable order.
 */
export function buildPayazaCheckoutConfig(opts: {
  amountNgn: number;
  email: string;
  reference: string;
  customerName?: string;
  customerPhone?: string;
}): PayazaCheckoutConfig {
  const publicKey = process.env.PAYAZA_PUBLIC_KEY ?? "";
  if (!publicKey) {
    throw new Error("PAYAZA_PUBLIC_KEY is not configured — cannot build a Payaza checkout");
  }
  const [firstName, ...rest] = (opts.customerName ?? "").trim().split(/\s+/);
  const lastName = rest.join(" ");
  // Live keys are prefixed PZ..-PKLIVE-, test keys PZ..-PKTEST-.
  const mode: PayazaCheckoutConfig["connectionMode"] = /PKLIVE/i.test(publicKey) ? "Live" : "Test";
  return {
    reference: opts.reference,
    connectionMode: mode,
    merchantKey: publicKey,
    amount: opts.amountNgn * 100, // Payaza SDK takes kobo
    currency: "NGN",
    email: opts.email,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(opts.customerPhone ? { phone: opts.customerPhone } : {}),
  };
}

/**
 * Authoritatively confirm a payment by asking Payaza directly. The webhook uses
 * this rather than trusting the callback body — the callback is treated as a
 * wake-up only, and the money decision is gated on this authed server-to-server
 * status read. EVERY confirm path (webhook, cron sweep, on-view re-verify,
 * admin recheck) runs through here, so an order can only be marked paid when
 * Payaza itself reports the transaction "Completed".
 *
 * There is NO mock/dev shim: without PAYAZA_PUBLIC_KEY this throws. A missing
 * key is a misconfiguration that must fail loudly (webhook → 500 so Payaza
 * retries; sweep → logged failure), never silently fabricate a confirmation.
 */
export async function verifyPayazaTransaction(
  reference: string,
): Promise<PayazaTransactionStatus> {
  if (!process.env.PAYAZA_PUBLIC_KEY) {
    throw new Error(
      "PAYAZA_PUBLIC_KEY is not configured — refusing to confirm a payment without verifying it against Payaza",
    );
  }
  const url =
    `${BASE}/merchant-collection/transfer_notification_controller/merchant/transaction-query` +
    `?merchant_reference=${encodeURIComponent(reference)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "content-type": "application/json", authorization: payazaReadAuthHeader() },
  });
  const text = await res.text();
  // Auth/upstream failures are real errors worth surfacing + retrying. A 400
  // with a JSON envelope (e.g. {success:false,"message":"Transaction not
  // found"}) is a legitimate "not confirmed yet" answer, not an error — fall
  // through and let the status come back non-"Completed".
  if (res.status === 401 || res.status === 403 || res.status >= 500) {
    throw new Error(`payaza verify failed: ${res.status} ${text}`);
  }
  // Confirmed shape (Payaza WooCommerce plugin): success boolean +
  // data.transaction_status ("Completed" on success) + data.amount_received in
  // FULL naira units (not cents) + data.transaction_reference (Payaza's own id).
  let body: {
    success?: boolean;
    data?: {
      transaction_status?: string;
      amount_received?: number;
      transaction_reference?: string;
      merchant_transaction_reference?: string;
      authorization?: { authorization_code?: string; reusable?: boolean };
    } | null;
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`payaza verify failed: ${res.status} ${text}`);
  }
  const d = body.data ?? {};
  const authCode = d.authorization?.authorization_code;
  return {
    status: d.transaction_status ?? (body.success ? "Completed" : "PENDING"),
    amountNgn: typeof d.amount_received === "number" ? Math.round(d.amount_received) : null,
    processorReference: d.transaction_reference ?? d.merchant_transaction_reference ?? null,
    authorization: authCode
      ? { token: authCode, reusable: d.authorization?.reusable ?? false }
      : null,
  };
}

/** Payaza's verify API reports success as transaction_status "Completed". */
export function isPayazaSuccess(status: string): boolean {
  return status.toLowerCase() === "completed";
}
