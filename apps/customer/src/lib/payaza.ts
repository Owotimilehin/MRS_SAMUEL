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

/** The three ways a pay-tap can fail before the customer sees a working popup.
 *  Logged with every failure so we can tell them apart in the checkout log
 *  instead of guessing from a generic message. */
export type PayazaFailureReason = "sdk_load_failed" | "popup_not_visible" | "sdk_error";

/** A snapshot of the customer's network at failure time (Network Information API,
 *  where supported) — the single most useful signal for "why did it fail", since
 *  these failures cluster on slow/saving connections. All fields best-effort. */
export interface PayazaConnectionInfo {
  effectiveType?: string; // "slow-2g" | "2g" | "3g" | "4g"
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
}

/** Structured diagnostics attached to every payment failure so the checkout log
 *  answers "which stage broke, how long it took, was the SDK/iframe there, and
 *  on what network" — turning "the window didn't open" into an actionable row. */
export interface PayazaFailureDiagnostics {
  reason: PayazaFailureReason;
  message: string;
  /** ms from launch (pay-tap) to this failure. */
  elapsedMs: number;
  /** Was window.PayazaCheckout defined (i.e. did the SDK script load)? */
  sdkLoaded: boolean;
  /** Was Payaza's checkout iframe in the DOM at all (even if not visible)? */
  iframePresent: boolean;
  /** Had the iframe flipped to visible (opacity 1)? */
  iframeVisible: boolean;
  /** How many SDK <script> load attempts the loader made. */
  loadAttempts: number;
  /** The watchdog window in effect (ms). */
  timeoutMs: number;
  connection: PayazaConnectionInfo | null;
  timestamp: string;
}

/** The customer-facing message for a failure reason. `sdk_error` keeps Payaza's
 *  own (more specific) message when present. Pure so it's unit-tested. */
export function payazaFailureMessage(reason: PayazaFailureReason, sdkMessage?: string): string {
  switch (reason) {
    case "sdk_load_failed":
      return "We couldn't start the secure payment window. Check your connection and try again.";
    case "popup_not_visible":
      return "The payment window is taking longer than usual to open. If it doesn't appear, please check your connection and tap Try again.";
    case "sdk_error":
      return sdkMessage ?? "Payment could not be completed. Please try again.";
  }
}

/** Read the Network Information API if the browser exposes it (Chrome/Android —
 *  which is most of our customers). Returns null where unsupported (iOS Safari). */
export function readConnectionInfo(): PayazaConnectionInfo | null {
  if (typeof navigator === "undefined") return null;
  const c = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  }).connection;
  if (!c) return null;
  return {
    ...(typeof c.effectiveType === "string" ? { effectiveType: c.effectiveType } : {}),
    ...(typeof c.downlink === "number" ? { downlinkMbps: c.downlink } : {}),
    ...(typeof c.rtt === "number" ? { rttMs: c.rtt } : {}),
    ...(typeof c.saveData === "boolean" ? { saveData: c.saveData } : {}),
  };
}

/** True if Payaza's checkout iframe exists in the DOM at all, regardless of
 *  whether it has become visible. Distinguishes "SDK never inserted the iframe"
 *  from "iframe inserted but never rendered" in failure diagnostics. */
function payazaIframePresent(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector('iframe[src^="https://checkout-v2.payaza.africa"]');
}

let loadPromise: Promise<PayazaGlobal> | null = null;

/** How many SDK <script> load attempts the last loadSdk() made — surfaced in
 *  failure diagnostics. */
let lastSdkLoadAttempts = 0;

/** How many times to attempt fetching the SDK <script> in a single press before
 *  surfacing a load failure. Payaza's CDN bundle intermittently fails to fetch
 *  on flaky Nigerian mobile networks; one failed <script> would otherwise leave
 *  the customer unable to pay ("We couldn't start the secure payment window"). */
const SDK_LOAD_ATTEMPTS = 3;

/** Backoff before the Nth SDK-load retry (0-based): 600ms, 1200ms, … Exported so
 *  the backoff shape is unit-tested without a DOM. */
export function sdkRetryDelayMs(retryIndex: number): number {
  return 600 * (retryIndex + 1);
}

/** Append the Payaza SDK <script> once, resolving with the global it defines. */
function appendSdkScript(): Promise<PayazaGlobal> {
  return new Promise<PayazaGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.PayazaCheckout) resolve(window.PayazaCheckout);
      else reject(new Error("Payaza SDK loaded but PayazaCheckout is undefined"));
    };
    script.onerror = () => {
      // Drop the failed node so a retry appends a fresh one instead of stacking.
      script.remove();
      reject(new Error("Failed to load Payaza checkout SDK"));
    };
    document.head.appendChild(script);
  });
}

function loadSdk(): Promise<PayazaGlobal> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Payaza SDK can only load in the browser"));
  }
  if (window.PayazaCheckout) return Promise.resolve(window.PayazaCheckout);
  if (loadPromise) return loadPromise;
  lastSdkLoadAttempts = 0;
  loadPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < SDK_LOAD_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, sdkRetryDelayMs(attempt - 1)));
      }
      // A prior attempt's <script> may have populated the global asynchronously.
      if (window.PayazaCheckout) return window.PayazaCheckout;
      lastSdkLoadAttempts = attempt + 1;
      try {
        return await appendSdkScript();
      } catch (err) {
        lastError = err;
      }
    }
    // Don't cache the failure — let a later press retry from scratch.
    loadPromise = null;
    throw lastError ?? new Error("Failed to load Payaza checkout SDK");
  })();
  return loadPromise;
}

/**
 * Pre-warm Payaza while the customer is still filling in the checkout form, so
 * tapping Pay opens an already-loaded popup instead of starting a cold DNS + TLS
 * + SDK download + iframe fetch at the worst possible moment. Safe to call on
 * page mount and repeatedly: it reuses the cached load, and a warming failure is
 * swallowed (the real pay-tap retries with full error handling). Pairs with a
 * <link rel="preconnect"> to checkout-v2.payaza.africa in the checkout route head.
 */
export function prewarmPayaza(): void {
  if (typeof window === "undefined") return;
  void loadSdk().catch(() => {
    /* best-effort warm-up; the pay-tap will retry and surface any real error */
  });
}

/** How long to wait for the Payaza portal to actually become visible before we
 *  show the customer a retryable hint instead of a silent dead spinner. Generous
 *  (40s) so a slow Nigerian mobile network still gets the popup: the poll
 *  resolves the instant the portal appears, so a real (even slow) open is never
 *  interrupted, and 20s was cutting off portals that were still rendering. */
const POPUP_OPEN_TIMEOUT_MS = 40_000;

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
  handlers: {
    onPaid: () => void;
    onClose?: () => void;
    onError?: (message: string, diagnostics?: PayazaFailureDiagnostics) => void;
  },
): Promise<void> {
  const startedAt = Date.now();
  // Snapshot everything we know about *this* failure so the checkout log can tell
  // the three failure modes apart (and on what network they happen).
  const diagnose = (reason: PayazaFailureReason, message: string): PayazaFailureDiagnostics => ({
    reason,
    message,
    elapsedMs: Date.now() - startedAt,
    sdkLoaded: typeof window !== "undefined" && !!window.PayazaCheckout,
    iframePresent: payazaIframePresent(),
    iframeVisible: isPayazaPopupVisible(),
    loadAttempts: lastSdkLoadAttempts,
    timeoutMs: POPUP_OPEN_TIMEOUT_MS,
    connection: readConnectionInfo(),
    timestamp: new Date().toISOString(),
  });

  let Payaza: PayazaGlobal;
  try {
    Payaza = await loadSdk();
  } catch {
    // Network/CSP/blocked SDK — tell the customer instead of hanging silently.
    const message = payazaFailureMessage("sdk_load_failed");
    handlers.onError?.(message, diagnose("sdk_load_failed", message));
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
      // Keep Payaza's own message (e.g. a specific validation error) for the
      // customer, but tag the diagnostics as an SDK-reported error.
      if (settle()) handlers.onError?.(errorMessage, diagnose("sdk_error", errorMessage));
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

  // Watchdog: if the portal hasn't become visible within the timeout, the
  // customer would otherwise hang on a spinner with no idea what to do. Surface
  // a retryable hint — but deliberately do NOT tear down Payaza's iframe/loader.
  // On slow mobile networks the portal can still finish rendering after this
  // point, and the money decision is entirely server-side (webhook + reconcile
  // sweep confirm the payment regardless of what the client shows), so
  // destroying a slow-but-loading popup only guarantees the customer can't pay.
  // We leave the popup alone so a late open still works.
  void waitForPopupOpen(POPUP_OPEN_TIMEOUT_MS).then((opened) => {
    if (opened || settled) return; // opened fine, or already resolved — nothing to do.
    if (!settle()) return;
    const message = payazaFailureMessage("popup_not_visible");
    handlers.onError?.(message, diagnose("popup_not_visible", message));
  });
}
