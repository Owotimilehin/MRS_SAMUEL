import { eq } from "drizzle-orm";
import { appSetting, PAYMENT_PROVIDER_KEY, type DbClient, type PaymentProviderValue } from "@ms/db";
import { buildPayazaCheckoutConfig, type PayazaCheckoutConfig } from "./payaza.js";
import { createOpayCashier } from "./opay.js";

export type PaymentProvider = "opay" | "payaza";

/** The active online payment provider, owner-toggleable via app_settings.
 *  Defaults to OPay (the redirect flow) when unset or malformed. */
export async function getActiveProvider(db: DbClient): Promise<PaymentProvider> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, PAYMENT_PROVIDER_KEY));
  const v = row?.value as Partial<PaymentProviderValue> | undefined;
  return v?.provider === "payaza" ? "payaza" : "opay";
}

export type CheckoutHandoff =
  | { provider: "opay"; redirectUrl: string }
  | { provider: "payaza"; payaza: PayazaCheckoutConfig };

/** Build the checkout handoff for the customer: a redirect URL (OPay) or the
 *  popup SDK config (Payaza). The returnUrl/callbackUrl for OPay come from
 *  PUBLIC_* env — callbackUrl always uses PUBLIC_API_URL (required env, see
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
  if (opts.provider === "opay") {
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
  const payaza = buildPayazaCheckoutConfig({
    amountNgn: opts.amountNgn,
    email: opts.email,
    reference: opts.reference,
    ...(opts.customerName !== undefined ? { customerName: opts.customerName } : {}),
    ...(opts.customerPhone !== undefined ? { customerPhone: opts.customerPhone } : {}),
  });
  return { provider: "payaza", payaza };
}
