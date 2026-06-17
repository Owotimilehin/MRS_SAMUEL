import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "payaza-charge" } });

// `||` not `??` — empty string in .env should fall back to the default.
const BASE = process.env.PAYAZA_API_BASE || "https://api.payaza.africa/live";

function payazaAuthHeader(): string {
  const publicKey = process.env.PAYAZA_PUBLIC_KEY ?? "";
  return `Payaza ${Buffer.from(publicKey).toString("base64")}`;
}

export interface ChargeResult {
  success: boolean;
  processorReference: string | null;
  failureReason: string | null;
}

/**
 * Charge a saved Payaza card token for a recurring subscription cycle (no
 * customer present).
 *
 * Dev/test shim: no keys OR no token → mock success so the whole subscription
 * billing loop is exercisable end-to-end without a live merchant-initiated
 * charge.
 *
 * ⚠️ UNCONFIRMED LIVE ENDPOINT: Payaza's official integration (WooCommerce
 * plugin) only demonstrates the frontend SDK + the GET transaction-query — it
 * does NOT expose a server-side charge-with-token API. The path/body below is a
 * best guess and MUST be confirmed with Payaza (dashboard/support) before going
 * live. Until then this stays effectively mock-only and the subscription
 * subsystem is NOT production-ready for real recurring debits.
 */
export async function chargePayazaToken(opts: {
  token: string | null;
  amountNgn: number;
  reference: string;
  email: string;
}): Promise<ChargeResult> {
  if (!process.env.PAYAZA_PUBLIC_KEY || !opts.token) {
    logger.warn({ ref: opts.reference }, "Payaza keys/token unset — mock charge success");
    return { success: true, processorReference: `mock-charge-${opts.reference}`, failureReason: null };
  }

  try {
    const res = await fetch(`${BASE}/merchant-collection/charge-authorization`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: payazaAuthHeader() },
      body: JSON.stringify({
        authorization_code: opts.token,
        amount: opts.amountNgn,
        currency: "NGN",
        email_address: opts.email,
        transaction_reference: opts.reference,
      }),
    });
    const text = await res.text();
    let body: { success?: boolean; data?: { transaction_status?: string; transaction_reference?: string }; message?: string };
    try {
      body = JSON.parse(text);
    } catch {
      return { success: false, processorReference: null, failureReason: `non-JSON response: ${res.status}` };
    }
    const status = body.data?.transaction_status?.toLowerCase();
    if (res.ok && (body.success === true || status === "completed")) {
      return {
        success: true,
        processorReference: body.data?.transaction_reference ?? null,
        failureReason: null,
      };
    }
    return {
      success: false,
      processorReference: body.data?.transaction_reference ?? null,
      failureReason: body.message ?? `charge declined (${res.status})`,
    };
  } catch (err) {
    return {
      success: false,
      processorReference: null,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}
