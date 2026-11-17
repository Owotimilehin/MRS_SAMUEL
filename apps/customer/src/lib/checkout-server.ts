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
  validNgPhone,
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

/** Where the "Try payment again" button on the page below posts to. */
const CHECKOUT_PAY_PATH = "/checkout/pay";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * The page a no-JS customer gets when their order was saved but OPay's payment
 * page could not be opened.
 *
 * The order's own page cannot help them: it reads the phone from localStorage
 * and needs JavaScript for its "Complete payment" button. This is plain HTML
 * with one form button; the phone they just typed travels in a hidden field of
 * their own response (never in a URL), so the retry needs nothing from them.
 */
function payLaterPage(orderNumber: string, phone: string, failedAgain: boolean): Response {
  const order = escapeHtml(orderNumber);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Complete your payment — Mrs. Samuel Fruit Juice</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      a, button { display: inline-block; padding: 0.75rem 1.25rem; border-radius: 999px; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      button { background: #111; color: #fff; width: 100%; font-weight: 600; }
      a { color: #111; margin-top: 0.75rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Your order ${order} is saved</h1>
      <p>${
        failedAgain
          ? "We still couldn't open the payment page. Please wait a moment and try again."
          : "We couldn't open the payment page just now. Your order is safe, so please don't place it again."
      }</p>
      <form method="POST" action="${CHECKOUT_PAY_PATH}">
        <input type="hidden" name="order" value="${order}" />
        <input type="hidden" name="phone" value="${escapeHtml(phone)}" />
        <button type="submit">Try payment again</button>
      </form>
      <a href="/order/${encodeURIComponent(orderNumber)}">View your order</a>
    </div>
  </body>
</html>`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  // The order owns the items: clear the basket exactly as the redirect to OPay
  // does, or the customer returns to a full basket and orders the same twice.
  headers.append("set-cookie", CLEAR_CART_COOKIE);
  headers.append("set-cookie", SIGNAL_CART_CLEARED);
  return new Response(html, { status: 200, headers });
}

/** "Try payment again": open a fresh OPay session for the order and go there. */
async function handlePayPost(request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return backToCheckout("badform");
  }
  const orderNumber = (form.get("order") ?? "").trim();
  const phone = (form.get("phone") ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,40}$/.test(orderNumber) || !validNgPhone(phone)) {
    return backToCheckout("badform");
  }
  try {
    const { redirect_url } = await apiFetch<{ redirect_url: string }>(
      `/v1/public/orders/${encodeURIComponent(orderNumber)}/opay-session?phone=${encodeURIComponent(phone.replace(/[\s-]/g, ""))}`,
      { method: "POST" },
    );
    return seeOther(redirect_url);
  } catch {
    return payLaterPage(orderNumber, phone, true);
  }
}

/**
 * Handle a checkout POST. Returns a redirect Response when it owns the request,
 * or `null` to let normal SSR proceed (any other method/path).
 */
export async function handleCheckoutPost(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === CHECKOUT_PAY_PATH) {
    return handlePayPost(request);
  }
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
    const code =
      err?.code === "order_closed"
        ? "closed"
        : err && (err.code === "conflict" || err.status === 422)
          ? "stock"
          : "order";
    void logNoJsAttempt(idempotencyKey, "order_failed", values, { errorMessage: err?.code ?? "unknown" });
    return backToCheckout(code);
  }

  void logNoJsAttempt(idempotencyKey, "order_created", values, { orderNumber: order.order_number });

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

  // The order exists but no payment page could be opened (OPay unreachable).
  // Not the order's own page: without JavaScript it can neither show the order
  // nor start payment. A plain page with a "Try payment again" button instead.
  return payLaterPage(order.order_number, values.phone, false);
}
