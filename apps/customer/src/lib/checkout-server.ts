/**
 * No-JS checkout submit handler.
 *
 * Runs in the SSR Node entry (`server.ts`) BEFORE the request reaches
 * TanStack, so the `<form method="POST" action="/checkout/place">` on the
 * checkout page works with zero client JavaScript: the browser POSTs here, we
 * create the order against the same API the JS path uses, and 303-redirect the
 * customer straight to the payment provider's hosted cashier (itself a full-page
 * redirect). This is what removes the pre-hydration dead-tap entirely — the
 * button is a native submit, live the instant the HTML paints.
 *
 * The JS path still intercepts submit for the richer flow (redirect overlay,
 * scheduling, inline validation); this is the floor beneath it, never the
 * ceiling.
 *
 * The POST is self-contained: the basket and the fulfilment branch arrive as
 * hidden fields rendered during SSR, so a blocked or expired `ms_cart` cookie
 * cannot produce the "full basket, empty submit" contradiction. The cookie is
 * still the SSR read path, and still the fallback here.
 */
import { apiFetch, asApiError } from "@/lib/api/client";
import type { ApiBranch, ApiPlacedOrder } from "@/lib/api/types";
import { readCartFromCookieHeader, CART_COOKIE_NAME } from "@/lib/cart-cookie";
import {
  parseCheckoutForm,
  parseCartItemsFromForm,
  checkoutFormErrors,
  buildPlaceOrderBody,
  stableIdempotencyKey,
  type CheckoutFormValues,
  BRANCH_FIELD,
  CHECKOUT_POST_PATH,
  CART_CLEARED_COOKIE,
} from "@/lib/checkout-post";

function seeOther(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * Bounce back to /checkout with an error CODE only.
 *
 * The code indexes a fixed message on the page. An earlier version also echoed
 * the raw API message as `?m=`, which meant anyone could hand a customer a link
 * that rendered attacker-chosen text inside the real branding — a phishing
 * surface for the price of a query string.
 */
function backToCheckout(code: string): Response {
  return seeOther(`/checkout?e=${encodeURIComponent(code)}`);
}

const CLEAR_CART_COOKIE = `${CART_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
const SIGNAL_CART_CLEARED = `${CART_CLEARED_COOKIE}=1; Path=/; Max-Age=600; SameSite=Lax`;

/**
 * Fire-and-forget telemetry so no-JS attempts appear in /owner/checkout-log
 * alongside the JS ones. That log exists to diagnose dead taps, so it must not
 * be blind to the very customers this path rescues.
 *
 * Body must satisfy `checkoutLogSchema` on the API. `items` there requires a
 * name and size per line, which the no-JS handler does not have (the form
 * carries ids and quantities only), so the basket size travels in `response`
 * instead. Never allowed to affect the order.
 */
async function logNoJsAttempt(
  attemptId: string,
  stage: "pressed" | "order_created" | "order_failed",
  values: CheckoutFormValues,
  extra: { orderNumber?: string; errorMessage?: string; itemCount?: number } = {},
): Promise<void> {
  try {
    await apiFetch("/v1/public/telemetry/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attempt_id: attemptId,
        stage,
        ...(extra.orderNumber ? { order_number: extra.orderNumber } : {}),
        customer: {
          name: values.name,
          phone: values.phone.replace(/[\s-]/g, ""),
          ...(values.email ? { email: values.email } : {}),
          address: values.address,
          state: values.state,
        },
        ...(extra.errorMessage ? { error_message: extra.errorMessage } : {}),
        response: { source: "nojs", ...(extra.itemCount !== undefined ? { item_count: extra.itemCount } : {}) },
      }),
    });
  } catch {
    /* telemetry is never allowed to affect checkout */
  }
}

/**
 * Handle a checkout POST. Returns a redirect Response when it owns the request,
 * or `null` to let normal SSR proceed (any other method/path).
 */
export async function handleCheckoutPost(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== CHECKOUT_POST_PATH) return null;

  // --- read the form + basket ---
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return backToCheckout("badform");
  }
  const values = parseCheckoutForm(form);

  // Hidden fields first (self-contained POST); cookie only as a fallback for a
  // page cached from before this shipped.
  const fromForm = parseCartItemsFromForm(form);
  const cartLines =
    fromForm.length > 0 ? fromForm : readCartFromCookieHeader(request.headers.get("cookie"));
  if (cartLines.length === 0) return backToCheckout("empty");

  if (checkoutFormErrors(values).length > 0) return backToCheckout("fields");

  // Same content ⇒ same key, so a double-tap collapses onto one order instead
  // of creating two.
  const idempotencyKey = stableIdempotencyKey(values, cartLines);

  // --- resolve the fulfilment branch ---
  // SSR already resolved it and rendered it as a hidden field, which keeps an
  // extra API round-trip (and its failure mode) out of the money path. Fall
  // back to the catalog only when the field is missing.
  let branchId = (form.get(BRANCH_FIELD) ?? "").trim() || null;
  if (!branchId) {
    try {
      const branches = await apiFetch<ApiBranch[]>("/v1/public/catalog/branches");
      branchId = (branches.find((b) => b.is_online_default) ?? branches[0])?.id ?? null;
    } catch {
      return backToCheckout("branch");
    }
  }
  if (!branchId) return backToCheckout("branch");

  void logNoJsAttempt(idempotencyKey, "pressed", values, { itemCount: cartLines.length });

  // --- create the order (same endpoint the JS path uses) ---
  const body = buildPlaceOrderBody(values, branchId, cartLines);

  let order: ApiPlacedOrder;
  try {
    order = await apiFetch<ApiPlacedOrder>("/v1/public/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = asApiError(e);
    const code = err && (err.code === "conflict" || err.status === 422) ? "stock" : "order";
    void logNoJsAttempt(idempotencyKey, "order_failed", values, { errorMessage: err?.code ?? "unknown" });
    return backToCheckout(code);
  }

  void logNoJsAttempt(idempotencyKey, "order_created", { order_number: order.order_number });

  // --- hand off to payment ---
  // Provider-agnostic: anything offering a full-page redirect (OPay's hosted
  // cashier) works without JS. A provider that only offers a client-side popup
  // cannot be completed here, so the customer goes to the order's tracking page
  // where the resume-payment flow takes over once JS is available.
  const redirectUrl =
    order.payment.provider === "opay" ? order.payment.redirect_url : null;

  if (redirectUrl) {
    // The order owns the items now. Clear the cookie basket and tell the client
    // to drop its localStorage copy when it next boots.
    return seeOther(redirectUrl, [CLEAR_CART_COOKIE, SIGNAL_CART_CLEARED]);
  }

  return seeOther(`/order/${order.order_number}?await_payment=1`);
}
