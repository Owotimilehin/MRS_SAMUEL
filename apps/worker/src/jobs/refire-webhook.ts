/**
 * Re-fire the api's payment webhook for a single order, by order number, over
 * HTTP. The webhook owns the one tested money-reconcile path (verify +
 * applyPaymentConfirmation); the worker never imports @ms/api or re-implements
 * ledger logic — it only re-triggers the webhook so a completed payment whose
 * original callback was lost still reconciles. Shared by the reconcile sweep
 * and the auto-cancel job.
 */

export type PaymentProvider = "opay";

/**
 * OPay is the only provider. Legacy rows carrying null (or the retired
 * "payaza") resolve here too: the sweep's window is 48 hours, so nothing that
 * predates the OPay switch can still be in scope — and re-verifying a stale
 * order against OPay simply reports "not completed" rather than moving money.
 */
export function providerOf(_paymentProvider: string | null): PaymentProvider {
  return "opay";
}

/** POST the payment webhook. Returns true on a 2xx. The webhook accepts a
 *  minimal re-fire body and verifies the money server-to-server. */
export async function refireProviderWebhook(
  orderNumber: string,
  provider: PaymentProvider,
): Promise<boolean> {
  const base = process.env["INTERNAL_API_URL"] || "http://api:3001";
  const body = { reference: orderNumber };
  const res = await fetch(`${base}/v1/webhooks/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
