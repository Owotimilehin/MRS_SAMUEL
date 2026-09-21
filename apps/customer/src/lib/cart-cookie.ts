/**
 * Server-readable mirror of the basket.
 *
 * The rich cart (full product objects, for the drawer/summary UI) stays in
 * localStorage — see `lib/cart.tsx`. That is invisible to the server, which is
 * why /checkout could only ever server-render "Your basket is empty" and the
 * whole checkout depended on React hydrating before a customer could order.
 *
 * This cookie carries the minimum the server needs to rebuild the basket
 * itself: variant id + quantity. Prices, names and stock are always resolved
 * server-side from the catalog — never trusted from the cookie — so a tampered
 * cookie can change *what* is ordered but never *what it costs*.
 *
 * Encoding is base64url of compact JSON `[["<variantId>",<qty>], ...]`, which
 * keeps the value free of characters that need cookie quoting (`;` `,` space).
 */

export const CART_COOKIE_NAME = "ms_cart";

/** Browsers guarantee ~4096 bytes per cookie including name and attributes. */
export const MAX_CART_COOKIE_BYTES = 3500;

/** Per-line ceiling; the API re-validates stock regardless. */
const MAX_QTY = 99;

export interface CartCookieLine {
  variantId: string;
  qty: number;
}

const toBase64Url = (s: string): string => {
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(s)))
      : Buffer.from(s, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s: string): string | null => {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return typeof atob === "function"
      ? decodeURIComponent(escape(atob(padded)))
      : Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
};

const sanitize = (line: unknown): CartCookieLine | null => {
  if (!Array.isArray(line) || line.length < 2) return null;
  const [variantId, qty] = line as [unknown, unknown];
  if (typeof variantId !== "string" || variantId === "") return null;
  if (typeof qty !== "number" || !Number.isFinite(qty)) return null;
  const n = Math.floor(qty);
  if (n <= 0) return null;
  return { variantId, qty: Math.min(n, MAX_QTY) };
};

/**
 * Encode basket lines for the cookie. Oversized baskets are truncated (oldest
 * lines win) rather than emitting a value the browser would silently drop —
 * a dropped cookie would resurrect the "empty basket at checkout" bug.
 */
export function encodeCartCookie(lines: readonly CartCookieLine[]): string {
  const packed: Array<[string, number]> = [];
  let encoded = toBase64Url("[]");

  for (const line of lines) {
    const clean = sanitize([line.variantId, line.qty]);
    if (!clean) continue;
    const next = [...packed, [clean.variantId, clean.qty] as [string, number]];
    const candidate = toBase64Url(JSON.stringify(next));
    if (candidate.length > MAX_CART_COOKIE_BYTES) break;
    packed.push([clean.variantId, clean.qty]);
    encoded = candidate;
  }

  return encoded;
}

/** Decode a cookie value into basket lines. Never throws; corrupt ⇒ empty. */
export function decodeCartCookie(raw: string | undefined | null): CartCookieLine[] {
  if (!raw) return [];
  const json = fromBase64Url(raw);
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitize).filter((l): l is CartCookieLine => l !== null);
  } catch {
    return [];
  }
}

/** Pull the cart out of a raw `Cookie:` request header. */
export function readCartFromCookieHeader(header: string | undefined | null): CartCookieLine[] {
  if (!header) return [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    // Trim so " ms_cart=…" matches, but compare the whole name so a cookie
    // like `not_ms_cart` can never be mistaken for ours.
    if (part.slice(0, eq).trim() !== CART_COOKIE_NAME) continue;
    return decodeCartCookie(part.slice(eq + 1).trim());
  }
  return [];
}

/** `document.cookie` assignment value. Lax so it survives the OPay return. */
export function serializeCartCookie(lines: readonly CartCookieLine[]): string {
  const value = encodeCartCookie(lines);
  return `${CART_COOKIE_NAME}=${value}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
}
