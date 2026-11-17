// apps/customer/src/lib/api/shopper.server.ts
import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

/**
 * Tells the API which shopper a server-side call is being made for.
 *
 * Every API call from this app leaves the storefront's own server, so the API
 * sees one in-network address for all shoppers and would rate-limit them as a
 * single caller. We forward the shopper's address in X-Shopper-IP, together
 * with the internal shared secret (INTERNAL_RECONCILE_TOKEN) that proves the
 * header came from us: the API ignores X-Shopper-IP without it, so a shopper
 * cannot forge an address to dodge the limit.
 *
 * Server-only (.server.ts): the secret never reaches the browser. The env is
 * read per request, never at module scope (see config.server.ts).
 */

const requestHeaders = new AsyncLocalStorage<Record<string, string>>();

/**
 * The shopper's address as seen by this server. Production traffic arrives
 * through Cloudflare, which sets CF-Connecting-IP itself and discards any value
 * the client sent. Failing that, the right-most X-Forwarded-For hop is the one
 * appended by the proxy directly in front of us. Null when neither is present
 * (local dev, direct hits): the API then keys the call as it always has.
 */
export function shopperIpFrom(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",");
  return hops[hops.length - 1]?.trim() || null;
}

/** Headers to add to API calls made while serving `request`. Empty unless both
 *  the shared secret and a shopper address are available. */
export function shopperHeadersFor(request: Request): Record<string, string> {
  const token = process.env.INTERNAL_RECONCILE_TOKEN;
  const ip = shopperIpFrom(request);
  if (!token || !ip) return {};
  return { "x-internal-token": token, "x-shopper-ip": ip };
}

/** Run `fn` so every apiFetch it (transitively) awaits carries the shopper's headers. */
export function withShopper<T>(request: Request, fn: () => T): T {
  return requestHeaders.run(shopperHeadersFor(request), fn);
}

/** The headers for the request currently being served ({} outside one). */
export function currentShopperHeaders(): Record<string, string> {
  return requestHeaders.getStore() ?? {};
}
