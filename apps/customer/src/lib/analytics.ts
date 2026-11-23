/**
 * GA4 conversion tracking (SEO roadmap task F5).
 *
 * Nothing loads and nothing is sent until GA_MEASUREMENT_ID is set. The ID is
 * public (it appears in every page's HTML), so it lives here, not in a secret.
 *
 * Events: add_to_cart, begin_checkout, purchase, whatsapp_click, phone_click.
 * Privacy: params carry only product ids/names, sizes, amounts in NGN, the
 * order number and the page path. Never a phone number, name, email or address.
 */

/** TODO(owner): GA4 Admin → Data streams → Web → "Measurement ID" (G-XXXXXXXXXX). */
export const GA_MEASUREMENT_ID = "";

export const CURRENCY = "NGN";

type Params = Record<string, string | number | boolean | object[] | undefined>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function analyticsEnabled(id: string = GA_MEASUREMENT_ID): boolean {
  return /^G-[A-Z0-9]{4,}$/.test(id);
}

/** <head> scripts for the root route: the gtag loader plus its init snippet. */
export function gaHeadScripts(
  id: string = GA_MEASUREMENT_ID,
): { src?: string; async?: boolean; children?: string }[] {
  if (!analyticsEnabled(id)) return [];
  return [
    { src: `https://www.googletagmanager.com/gtag/js?id=${id}`, async: true },
    {
      children: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','${id}');`,
    },
  ];
}

/** Send one GA4 event. A no-op on the server, without an ID, or if gtag is blocked. */
export function track(event: string, params: Params = {}): void {
  if (typeof window === "undefined" || !analyticsEnabled()) return;
  try {
    window.gtag?.("event", event, params);
  } catch {
    // Analytics must never break the shop.
  }
}

/** Classify a link a shopper clicked: WhatsApp, a phone call, or neither. */
export function contactKind(
  href: string | null | undefined,
): "whatsapp_click" | "phone_click" | null {
  if (!href) return null;
  const h = href.trim().toLowerCase();
  if (h.startsWith("tel:")) return "phone_click";
  if (
    /^(https?:)?\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|wa\.link)\//.test(h) ||
    h.startsWith("whatsapp:")
  )
    return "whatsapp_click";
  return null;
}

/**
 * One document-level listener for WhatsApp and phone links, so every such
 * link on the site is tracked without editing each component. Sends only
 * where on the site the tap happened, never the number. Returns a cleanup.
 */
export function installContactClickTracking(): () => void {
  if (typeof document === "undefined") return () => {};
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    const kind = contactKind(a?.getAttribute("href"));
    if (kind) track(kind, { page_path: window.location.pathname });
  };
  document.addEventListener("click", onClick, { capture: true });
  return () => document.removeEventListener("click", onClick, { capture: true });
}

/** Fire `purchase` once per order per browser, even across page reloads. */
export function trackPurchaseOnce(
  orderNumber: string,
  valueNgn: number,
  items: object[] = [],
): void {
  if (typeof window === "undefined" || !analyticsEnabled()) return;
  const key = `ms_ga_purchase_${orderNumber}`;
  try {
    if (window.localStorage.getItem(key)) return;
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: still send; GA dedupes purchases by transaction_id.
  }
  track("purchase", { transaction_id: orderNumber, value: valueNgn, currency: CURRENCY, items });
}
