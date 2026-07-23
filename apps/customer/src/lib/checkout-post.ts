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

const str = (v: FormDataEntryValue | string | undefined | null): string =>
  typeof v === "string" ? v : "";

/** Nigerian-phone check — mirrors validNgPhone() in checkout.tsx. */
export function validNgPhone(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "");
  return /^(\+?234|0)\d{9,10}$/.test(s);
}

/** Pull the checkout fields out of a urlencoded/multipart form body. */
export function parseCheckoutForm(
  body: Record<string, FormDataEntryValue> | URLSearchParams,
): CheckoutFormValues {
  const get =
    body instanceof URLSearchParams
      ? (k: string) => str(body.get(k))
      : (k: string) => str(body[k]);
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
