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

  // Route the SDK callback by response type: pay only on success, surface
  // errors, ignore in-flight messages. Wired to BOTH the setup callback and
  // setCallback because the SDK reads whichever is set last.
  const handle = (res: unknown) => {
    const { paid, errorMessage } = interpretPayazaResponse(res);
    if (paid) handlers.onPaid();
    else if (errorMessage) handlers.onError?.(errorMessage);
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
    onClose: () => handlers.onClose?.(),
    callback: handle,
  });
  instance.setCallback(handle);
  instance.setOnClose(() => handlers.onClose?.());
  instance.showPopup();
}
