import type { DbClient } from "@ms/db";
import { createOpayCashier } from "./opay.js";

export type PaymentProvider = "opay";

/**
 * The online payment provider. OPay is the only one — the Payaza fallback and
 * its owner-facing toggle were removed once OPay was proven in production.
 * Kept as a function so call sites (and the app_settings row that used to drive
 * it) need no reshaping if a second provider is ever added back.
 */
export async function getActiveProvider(_db: DbClient): Promise<PaymentProvider> {
  return "opay";
}

export type CheckoutHandoff = { provider: "opay"; redirectUrl: string };

/** Build the checkout handoff for the customer: OPay's hosted cashier URL.
 *  The returnUrl/callbackUrl come from PUBLIC_* env — callbackUrl always uses PUBLIC_API_URL (required env, see
 *  apps/api/src/env.ts); returnUrl prefers PUBLIC_CUSTOMER_URL (optional) and
 *  otherwise derives the customer site from PUBLIC_ADMIN_URL the same way the
 *  worker does for its WhatsApp tracking links (outbox.ts). */
export async function createCheckout(
  _db: DbClient,
  opts: {
    provider: PaymentProvider;
    amountNgn: number;
    reference: string;
    email: string;
    customerName?: string;
    customerPhone?: string;
  },
): Promise<CheckoutHandoff> {
  const apiBase = process.env.PUBLIC_API_URL;
  const customerBase =
    process.env.PUBLIC_CUSTOMER_URL ||
    (process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamuel.com").replace("admin.", "www.");
  const { cashierUrl } = await createOpayCashier({
    amountNgn: opts.amountNgn,
    reference: opts.reference,
    email: opts.email,
    ...(opts.customerName !== undefined ? { customerName: opts.customerName } : {}),
    ...(opts.customerPhone !== undefined ? { customerPhone: opts.customerPhone } : {}),
    returnUrl: `${customerBase}/order/${opts.reference}?paid=1`,
    callbackUrl: `${apiBase}/v1/webhooks/opay`,
  });
  return { provider: "opay", redirectUrl: cashierUrl };
}
