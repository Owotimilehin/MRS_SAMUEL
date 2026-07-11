/**
 * Re-fire the api's payment webhook for a single order, by order number, over
 * HTTP. The webhook owns the one tested money-reconcile path (verify +
 * applyPaymentConfirmation); the worker never imports @ms/api or re-implements
 * ledger logic — it only re-triggers the webhook so a completed payment whose
 * original callback was lost still reconciles. Shared by the reconcile sweep
 * and the auto-cancel job.
 */

export type PaymentProvider = "opay" | "payaza";

/** Each order carries the provider it was created under (null on legacy rows →
 *  Payaza, the original provider). */
export function providerOf(paymentProvider: string | null): PaymentProvider {
  return paymentProvider === "opay" ? "opay" : "payaza";
}

/** POST the matching provider webhook. Returns true on a 2xx. Both webhooks
 *  accept a minimal re-fire body and verify the money server-to-server; payaza
 *  additionally reads `transaction_reference` for its callback envelope shape. */
export async function refireProviderWebhook(
  orderNumber: string,
  provider: PaymentProvider,
): Promise<boolean> {
  const base = process.env["INTERNAL_API_URL"] || "http://api:3001";
  const body =
    provider === "opay"
      ? { reference: orderNumber }
      : { transaction_reference: orderNumber, reference: orderNumber };
  const res = await fetch(`${base}/v1/webhooks/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
