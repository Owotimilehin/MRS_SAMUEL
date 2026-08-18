/**
 * Pure core of the no-JS checkout POST. The server handler in `server.ts`
 * supplies the parsed form body, the branch id and the cart lines; these
 * functions validate and shape the request to POST /v1/public/orders — the
 * exact same API the JS `placeOrder` server function calls, so both paths
 * create orders identically.
 *
 * No I/O here so it can be unit-tested. Prices/stock are never taken from the
 * form — only variant id + quantity (from the cart cookie) reach the API.
 */
import type { CartCookieLine } from "@/lib/cart-cookie";

export interface CheckoutFormValues {
  name: string;
  phone: string;
  email: string;
  altPhone: string;
  address: string;
  state: string;
  notes: string;
}

/**
 * Nigerian-phone check. Single source of truth — `checkout.tsx` imports this
 * rather than keeping its own copy, so the two cannot drift apart on the field
 * most likely to reject a real customer.
 */
export function validNgPhone(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "");
  return /^(\+?234|0)\d{9,10}$/.test(s);
}

/** Path the checkout <form> posts to. Lives here, not in `checkout-server.ts`,
 *  so the client bundle can reference it without importing server-only code. */
export const CHECKOUT_POST_PATH = "/checkout/place";

/**
 * One-shot flag telling the client to drop its localStorage basket on next boot.
 *
 * The no-JS 303 clears the server-readable cart cookie, but a redirect cannot
 * touch localStorage. Without this the customer paid, came back, and React
 * restored a basket of juice they had already bought.
 */
export const CART_CLEARED_COOKIE = "ms_cart_cleared";

/** Hidden input name carrying one basket line as `variantId:qty`. */
export const CART_ITEM_FIELD = "item";

/** Hidden input name carrying the fulfilment branch resolved during SSR. */
export const BRANCH_FIELD = "branch_id";

/** Pull the checkout fields out of the urlencoded form body. */
export function parseCheckoutForm(body: URLSearchParams): CheckoutFormValues {
  const get = (k: string): string => body.get(k) ?? "";
  return {
    name: get("name").trim(),
    phone: get("phone").trim(),
    email: get("email").trim(),
    altPhone: get("altPhone").trim(),
    address: get("address").trim(),
    state: get("state").trim() || "Lagos",
    notes: get("notes").trim(),
  };
}

/**
 * Which required fields are missing/invalid, as friendly labels. Empty array
 * ⇒ the form is good enough to attempt the order (the API is still the final
 * authority on stock/validation).
 */
export function checkoutFormErrors(values: CheckoutFormValues): string[] {
  const missing: string[] = [];
  if (values.name === "") missing.push("your full name");
  if (!validNgPhone(values.phone)) missing.push("a valid phone number");
  if (values.address.length < 3) missing.push("your delivery address");
  return missing;
}

/**
 * Read the basket out of the form's hidden `item` inputs (`variantId:qty`).
 *
 * The page already server-renders the resolved basket, so emitting it as hidden
 * fields makes the POST self-contained: it no longer depends on the `ms_cart`
 * cookie surviving the round trip. That matters because a blocked, proxy-
 * stripped or ITP-expired cookie would otherwise show the customer a full
 * basket and then reject the submit as empty.
 *
 * Quantities are clamped the same way the cookie clamps them; the API remains
 * the authority on stock, and prices are never taken from the client.
 */
export function parseCartItemsFromForm(body: URLSearchParams): CartCookieLine[] {
  const lines: CartCookieLine[] = [];
  for (const raw of body.getAll(CART_ITEM_FIELD)) {
    const sep = raw.lastIndexOf(":");
    if (sep <= 0) continue;
    const variantId = raw.slice(0, sep).trim();
    const qty = Math.floor(Number(raw.slice(sep + 1)));
    if (variantId === "" || !Number.isFinite(qty) || qty <= 0) continue;
    lines.push({ variantId, qty: Math.min(qty, 99) });
  }
  return lines;
}

/**
 * A deterministic idempotency key for a no-JS submit.
 *
 * The JS path holds one key in a ref so a retry replays the same attempt. A
 * plain form POST has nowhere to hold that, and minting a fresh random key per
 * request meant a double-tap — overwhelmingly likely on the slow connections
 * this whole feature exists to serve — created two real orders and two payment
 * sessions.
 *
 * Deriving the key from the submitted content instead makes the repeat POST
 * collapse onto the first order server-side. Two genuinely different baskets
 * still get different keys, and a customer deliberately reordering the same
 * basket is separated by the time bucket.
 */
export function stableIdempotencyKey(
  values: CheckoutFormValues,
  cartLines: readonly CartCookieLine[],
  now: Date = new Date(),
): string {
  const basket = cartLines
    .map((l) => `${l.variantId}:${l.qty}`)
    .sort()
    .join(",");
  // Hour bucket: a deliberate re-order of the same basket later is a new order,
  // but every retry inside the same submit collapses onto one.
  const bucket = Math.floor(now.getTime() / 3_600_000);
  const seed = [
    values.name.toLowerCase(),
    values.phone.replace(/[\s-]/g, ""),
    values.address.toLowerCase(),
    values.state,
    basket,
    bucket,
  ].join("|");

  // FNV-1a, 32 bits at a time, into a UUID-shaped string. Not cryptographic —
  // it only needs to be stable and well-distributed across baskets.
  const block = (salt: string): string => {
    let h = 0x811c9dc5;
    const s = `${salt}${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const a = block("a");
  const b = block("b");
  const c = block("c");
  const d = block("d");
  return `${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d}`;
}

export interface PlaceOrderBody {
  branch_id: string;
  delivery_fee_ngn: 0;
  delivery_state: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
    alt_phone?: string;
    address: string;
  };
  items: Array<{ variant_id: string; quantity: number }>;
  notes?: string;
}

/**
 * Shape the POST /v1/public/orders body from validated values + the cart
 * cookie. The no-JS path is always dispatch-now (no window/schedule); the API
 * treats a missing window as ASAP, and scheduling stays a JS enhancement.
 */
export function buildPlaceOrderBody(
  values: CheckoutFormValues,
  branchId: string,
  cartLines: readonly CartCookieLine[],
): PlaceOrderBody {
  const phone = values.phone.replace(/[\s-]/g, "");
  return {
    branch_id: branchId,
    delivery_fee_ngn: 0,
    delivery_state: values.state,
    customer: {
      name: values.name,
      phone,
      ...(values.email ? { email: values.email } : {}),
      ...(values.altPhone ? { alt_phone: values.altPhone.replace(/[\s-]/g, "") } : {}),
      address: values.address,
    },
    items: cartLines.map((l) => ({ variant_id: l.variantId, quantity: l.qty })),
    ...(values.notes ? { notes: values.notes } : {}),
  };
}
