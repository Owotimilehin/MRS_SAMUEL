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
  handlers: { onPaid: () => void; onClose?: () => void },
): Promise<void> {
  const Payaza = await loadSdk();
  const instance = Payaza.setup({
    merchant_key: config.merchantKey,
    connection_mode: config.connectionMode,
    checkout_amount: config.amount / 100, // SDK wants naira, not kobo
    currency_code: config.currency,
    email_address: config.email,
    first_name: config.firstName ?? "",
    last_name: config.lastName ?? "",
    phone_number: config.phone ?? "",
    transaction_reference: config.reference,
    onClose: () => handlers.onClose?.(),
    callback: () => handlers.onPaid(),
  });
  instance.setCallback(() => handlers.onPaid());
  instance.setOnClose(() => handlers.onClose?.());
  instance.showPopup();
}
