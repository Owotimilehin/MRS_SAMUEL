/**
 * No-JS checkout submit handler.
 *
 * Runs in the SSR Node entry (`server.ts`) BEFORE the request reaches
 * TanStack, so the `<form method="POST" action="/checkout/place">` on the
 * checkout page works with zero client JavaScript: the browser POSTs here, we
 * create the order against the same API the JS path uses, and 303-redirect the
 * customer straight to OPay's hosted cashier (itself a full-page redirect).
 * This is what removes the pre-hydration dead-tap entirely — the button is a
 * native submit, live the instant the HTML paints.
 *
 * The JS path still intercepts submit for the richer flow (Payaza popup,
 * redirect overlay, scheduling, inline validation); this is the floor beneath
 * it, never the ceiling.
 */
import { apiFetch, asApiError } from "@/lib/api/client";
import type { ApiBranch, ApiPlacedOrder } from "@/lib/api/types";
import { readCartFromCookieHeader, CART_COOKIE_NAME } from "@/lib/cart-cookie";
import {
  parseCheckoutForm,
  checkoutFormErrors,
  buildPlaceOrderBody,
} from "@/lib/checkout-post";

/** Path the checkout <form> posts to. */
export const CHECKOUT_POST_PATH = "/checkout/place";

function seeOther(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location, ...extraHeaders },
  });
}

/** Bounce back to /checkout with an error code the page renders as a message. */
function backToCheckout(code: string, message?: string): Response {
  const q = new URLSearchParams({ e: code });
  if (message) q.set("m", message);
  return seeOther(`/checkout?${q.toString()}`);
}

/** Clear the server cart cookie once the order owns the items. */
const CLEAR_CART_COOKIE = `${CART_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;

/**
 * Handle a checkout POST. Returns a redirect Response when it owns the request,
 * or `null` to let normal SSR proceed (any other method/path).
 */
export async function handleCheckoutPost(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== CHECKOUT_POST_PATH) return null;

  // --- read the form + basket ---
  let values;
  try {
    const raw = await request.text();
    values = parseCheckoutForm(new URLSearchParams(raw));
  } catch {
    return backToCheckout("badform");
  }

  const cartLines = readCartFromCookieHeader(request.headers.get("cookie"));
  if (cartLines.length === 0) return backToCheckout("empty");

  const errors = checkoutFormErrors(values);
  if (errors.length > 0) return backToCheckout("fields");

  // --- resolve the online-fulfilment branch ---
  let branchId: string | null;
  try {
    const branches = await apiFetch<ApiBranch[]>("/v1/public/catalog/branches");
    branchId = (branches.find((b) => b.is_online_default) ?? branches[0])?.id ?? null;
  } catch {
    return backToCheckout("branch");
  }
  if (!branchId) return backToCheckout("branch");

  // --- create the order (same endpoint the JS path uses) ---
  const body = buildPlaceOrderBody(values, branchId, cartLines);
  const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `nojs-${Date.now()}-${Math.random()}`;

  let order: ApiPlacedOrder;
  try {
    order = await apiFetch<ApiPlacedOrder>("/v1/public/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = asApiError(e);
    if (err && (err.code === "conflict" || err.status === 422)) {
      return backToCheckout("stock", err.message);
    }
    return backToCheckout("order", err?.message);
  }

  // --- hand off to payment ---
  if (order.payment.provider === "opay") {
    // Straight to OPay's hosted cashier; the webhook + reconcile sweep confirm
    // payment server-side even if the customer never loads the return page with
    // JS. Clear the basket cookie — the order owns the items now.
    return seeOther(order.payment.redirect_url, { "set-cookie": CLEAR_CART_COOKIE });
  }

  // Payaza (fallback) is a client-side popup with no redirect equivalent, so a
  // no-JS customer can't complete it inline. The order exists and is unpaid;
  // send them to its tracking page, where the resume-payment flow takes over
  // once JS is available. Keep the basket so nothing is lost if they abandon.
  return seeOther(`/order/${order.order_number}?await_payment=1`);
}
