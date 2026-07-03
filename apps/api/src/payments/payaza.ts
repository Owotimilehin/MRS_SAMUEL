/**
 * Init config for Payaza's frontend checkout SDK
 * (https://checkout-v2.payaza.africa/js/v1/bundle.js). Payaza has no
 * server-side "create session" endpoint — the popup is opened client-side with
 * the public key + order details, so the server's job is to hand the customer
 * page exactly these params. Field names match the SDK (confirmed against
 * Payaza's WooCommerce plugin). `amount` is in kobo (naira × 100).
 */
import type { ConfirmedTransaction } from "./opay.js";

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

/** @deprecated name — kept as an alias so existing imports keep working. */
export type PayazaTransactionStatus = ConfirmedTransaction;

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
  // The checkout SDK validates first_name AND last_name as required + non-blank;
  // a single-word name would otherwise send a blank last_name and the popup
  // would silently never open. Fall back to the first name.
  const lastName = rest.join(" ") || firstName;
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

/** Pure body→status mapping, split out so it is unit-testable without HTTP.
 *  `httpStatus` is the fetch status; 401/403/5xx are hard errors (throw so the
 *  webhook 500s and Payaza retries). A 4xx JSON envelope is a legitimate
 *  "not confirmed yet" answer and falls through to a non-"Completed" status. */
export function parsePayazaBody(httpStatus: number, text: string): PayazaTransactionStatus {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500) {
    throw new Error(`payaza verify failed: ${httpStatus} ${text}`);
  }
  let body: {
    success?: boolean;
    data?: {
      transaction_status?: string;
      amount_received?: number;
      // Payaza decides the fee per transaction — read it, never hardcode.
      // Field name confirmed against a real transaction in Task 7; read
      // candidates defensively so a naming variant does not silently drop it.
      fee?: number;
      charge?: number;
      transaction_fee?: number;
      processor_fee?: number;
      settlement_amount?: number;
      amount_settled?: number;
      transaction_reference?: string;
      merchant_transaction_reference?: string;
      authorization?: { authorization_code?: string; reusable?: boolean };
    } | null;
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`payaza verify failed: ${httpStatus} ${text}`);
  }
  const d = body.data ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" ? Math.round(v) : null);
  const gross = num(d.amount_received);
  const feeNgn = num(d.fee) ?? num(d.charge) ?? num(d.transaction_fee) ?? num(d.processor_fee);
  const settlement = num(d.settlement_amount) ?? num(d.amount_settled);
  const netNgn = settlement ?? (gross != null && feeNgn != null ? gross - feeNgn : null);
  const authCode = d.authorization?.authorization_code;
  return {
    status: d.transaction_status ?? (body.success ? "Completed" : "PENDING"),
    amountNgn: gross,
    feeNgn,
    netNgn,
    processorReference: d.transaction_reference ?? d.merchant_transaction_reference ?? null,
    authorization: authCode ? { token: authCode, reusable: d.authorization?.reusable ?? false } : null,
    raw: body,
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
  return parsePayazaBody(res.status, text);
}

/** Payaza's verify API reports success as transaction_status "Completed". */
export function isPayazaSuccess(status: string): boolean {
  return status.toLowerCase() === "completed";
}
