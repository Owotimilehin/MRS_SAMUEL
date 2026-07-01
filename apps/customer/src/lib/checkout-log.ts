/** The lifecycle stages of a single "Place order" press (mirrors the API). */
export type CheckoutStage =
  | "pressed"
  | "validation_failed"
  | "order_created"
  | "order_failed"
  | "payment_paid"
  | "payment_closed"
  | "payment_failed";

export interface CheckoutLogPayload {
  attempt_id: string;
  stage: CheckoutStage;
  order_number?: string;
  customer?: { name?: string; phone?: string; email?: string; address?: string; state?: string };
  delivery_window?: string;
  items?: Array<{ variant_id: string; name: string; size: string; qty: number }>;
  total_ngn?: number;
  error_message?: string;
  response?: Record<string, unknown>;
}

interface BuildInput {
  attemptId: string;
  stage: CheckoutStage;
  form: { name: string; phone: string; email: string; address: string; state: string };
  items: Array<{ variantId: string; name: string; size: string; qty: number }>;
  total: number;
  deliveryWindow?: string;
  orderNumber?: string;
  errorMessage?: string;
  response?: Record<string, unknown>;
}

/** Shape the request body the `logCheckoutAttempt` server fn sends. Pure so it
 *  can be unit-tested; normalises the phone and drops empty optional fields. */
export function buildCheckoutLogPayload(i: BuildInput): CheckoutLogPayload {
  const phone = i.form.phone.replace(/[\s-]/g, "");
  return {
    attempt_id: i.attemptId,
    stage: i.stage,
    order_number: i.orderNumber,
    customer: {
      name: i.form.name.trim() || undefined,
      phone: phone || undefined,
      email: i.form.email.trim() || undefined,
      address: i.form.address.trim() || undefined,
      state: i.form.state || undefined,
    },
    delivery_window: i.deliveryWindow,
    items: i.items.map((it) => ({
      variant_id: it.variantId,
      name: it.name,
      size: it.size,
      qty: it.qty,
    })),
    total_ngn: i.total,
    error_message: i.errorMessage,
    response: i.response,
  };
}
