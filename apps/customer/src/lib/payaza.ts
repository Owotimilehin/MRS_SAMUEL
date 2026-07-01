import type { PayazaCheckoutConfig } from "./api/types";

/**
 * Thin loader + launcher for Payaza's checkout popup SDK
 * (https://checkout-v2.payaza.africa/js/v1/bundle.js). Payaza has no
 * server-side redirect — the popup runs client-side, keyed by the merchant
 * public key, and on success our /v1/webhooks/payaza handler re-queries Payaza
 * (by merchant_reference = our order number) to authoritatively mark the order
 * paid. So the popup callback just needs to move the customer to the tracking
 * page; the money decision is server-side.
 */

const SDK_URL = "https://checkout-v2.payaza.africa/js/v1/bundle.js";

interface PayazaInstance {
  setCallback(cb: (res: unknown) => void): void;
  setOnClose(cb: () => void): void;
  showPopup(): void;
  // Internal SDK teardown helpers — used best-effort by the watchdog to clear
  // Payaza's own full-screen loader/iframe if the portal never finishes opening.
  removeLoader?(): void;
  removePopup?(): void;
}
interface PayazaGlobal {
  setup(opts: Record<string, unknown>): PayazaInstance;
}
declare global {
  interface Window {
    PayazaCheckout?: PayazaGlobal;
  }
}

/**
 * Decide what a Payaza SDK callback response means. The SDK fires the SAME
 * `callback` for success AND failure (handleSuccess + handleClientError both
 * call it), so the launcher MUST branch on the response `type` rather than
 * assume every callback is a completed payment. Treating an error as "paid" is
 * exactly what made the popup "do nothing" — a validation/merchant error never
 * opened the popup, yet the old code navigated away as if payment succeeded.
 *
 * - `success`            → paid.
 * - `error`/`error-client` → surface the message so the customer sees it.
 * - anything else (`copy`/`info`/`action`) → in-flight, neither paid nor error.
 */
export function interpretPayazaResponse(
  res: unknown,
): { paid: boolean; errorMessage: string | null } {
  const r = (res ?? {}) as {
    type?: string;
    data?: { message?: string; errors?: Array<{ field?: string; errors?: string[] }> };
  };
  if (r.type === "success") return { paid: true, errorMessage: null };
  if (r.type === "error" || r.type === "error-client") {
    const fieldError = r.data?.errors?.flatMap((e) => e.errors ?? [])[0];
    const message =
      fieldError ?? r.data?.message ?? "Payment could not be completed. Please try again.";
    return { paid: false, errorMessage: message };
  }
  return { paid: false, errorMessage: null };
}

/**
 * Guarantee non-blank first/last names for the SDK. Payaza validates both
 * `first_name` and `last_name` as REQUIRED + NOT_BLANK; a single-word customer
 * name (very common) yields a blank last name, the SDK fails validation, and
 * the popup silently never opens. Fall back so the popup always opens.
 */
export function payazaNames(config: { firstName?: string; lastName?: string }): {
  firstName: string;
  lastName: string;
} {
  const firstName = config.firstName?.trim() || "Customer";
  const lastName = config.lastName?.trim() || firstName;
  return { firstName, lastName };
}

let loadPromise: Promise<PayazaGlobal> | null = null;

function loadSdk(): Promise<PayazaGlobal> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Payaza SDK can only load in the browser"));
  }
  if (window.PayazaCheckout) return Promise.resolve(window.PayazaCheckout);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<PayazaGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.PayazaCheckout) resolve(window.PayazaCheckout);
      else reject(new Error("Payaza SDK loaded but PayazaCheckout is undefined"));
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("Failed to load Payaza checkout SDK"));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

/** How long to wait for the Payaza portal to actually become visible before we
 *  treat it as a failed-to-open and stop the customer hanging on a dead spinner.
 *  Generous so a slow network still gets the popup; the poll resolves the instant
 *  the portal appears, so a real (even slow) open is never interrupted. */
const POPUP_OPEN_TIMEOUT_MS = 20_000;

/**
 * True once Payaza's checkout iframe is on the page AND visible. The SDK appends
 * the iframe at opacity 0 and only flips it to opacity 1 once its contents have
 * loaded (`showHiddenIframe`), so opacity === "1" is our signal that the portal
 * actually opened rather than hanging on the loader overlay.
 */
export function isPayazaPopupVisible(): boolean {
  if (typeof document === "undefined") return false;
  const frame = document.querySelector<HTMLElement>(
    'iframe[src^="https://checkout-v2.payaza.africa"]',
  );
  return !!frame && frame.style.opacity === "1";
}

/** Resolve `true` as soon as the portal is visible, or `false` if it never
 *  becomes visible within `timeoutMs`. */
async function waitForPopupOpen(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPayazaPopupVisible()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return isPayazaPopupVisible();
}

/**
 * Open the Payaza checkout popup for an order. Resolves once the popup is shown
 * (the actual payment outcome is confirmed server-side via webhook). `onPaid`
 * fires on the SDK success callback so the caller can navigate to tracking.
 */
export async function launchPayazaCheckout(
  config: PayazaCheckoutConfig,
  handlers: { onPaid: () => void; onClose?: () => void; onError?: (message: string) => void },
): Promise<void> {
  let Payaza: PayazaGlobal;
  try {
    Payaza = await loadSdk();
  } catch {
    // Network/CSP/blocked SDK — tell the customer instead of hanging silently.
    handlers.onError?.(
      "We couldn't start the secure payment window. Check your connection and try again.",
    );
    return;
  }

  // A press is "settled" once the SDK reports a terminal outcome (paid/closed/
  // error) OR the watchdog fires. Guards against double-firing and stops the
  // watchdog from interrupting a payment that actually opened.
  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    return true;
  };

  // Route the SDK callback by response type: pay only on success, surface
  // errors, ignore in-flight messages. Wired to BOTH the setup callback and
  // setCallback because the SDK reads whichever is set last.
  const handle = (res: unknown) => {
    const { paid, errorMessage } = interpretPayazaResponse(res);
    if (paid) {
      if (settle()) handlers.onPaid();
    } else if (errorMessage) {
      if (settle()) handlers.onError?.(errorMessage);
    }
    // non-terminal (copy/info/action): leave unsettled.
  };
  const onClose = () => {
    if (settle()) handlers.onClose?.();
  };

  const { firstName, lastName } = payazaNames(config);
  const instance = Payaza.setup({
    merchant_key: config.merchantKey,
    connection_mode: config.connectionMode,
    checkout_amount: config.amount / 100, // SDK wants naira, not kobo
    currency_code: config.currency,
    email_address: config.email,
    first_name: firstName,
    last_name: lastName,
    phone_number: config.phone ?? "",
    transaction_reference: config.reference,
    onClose,
    callback: handle,
  });
  instance.setCallback(handle);
  instance.setOnClose(onClose);
  instance.showPopup();

  // Watchdog: if the portal never actually becomes visible (Payaza's iframe
  // loads its overlay but the checkout never renders and no callback fires),
  // the customer would otherwise hang forever on a dead spinner. Detect the
  // no-open, tear down Payaza's leftover overlay, and surface a retryable error.
  void waitForPopupOpen(POPUP_OPEN_TIMEOUT_MS).then((opened) => {
    if (opened || settled) return; // opened fine, or already resolved — nothing to do.
    if (!settle()) return;
    try {
      instance.removeLoader?.();
      instance.removePopup?.();
    } catch {
      /* best-effort teardown of the SDK's own overlay */
    }
    handlers.onError?.(
      "The payment window didn't open. Please check your connection and try again.",
    );
  });
}
