import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Lock, Loader2, ExternalLink } from "lucide-react";

/** How long we wait for the browser to actually leave for the payment page
 *  before assuming the redirect stalled and revealing a manual link. On a
 *  healthy network the page unloads well before this; on a flaky one it doesn't,
 *  and the customer needs a way through. */
const MANUAL_LINK_DELAY_MS = 4000;

/**
 * Full-screen overlay shown while we hand the customer off to the hosted payment
 * page (OPay's cashier). It appears the instant we start the redirect, so the tap
 * gets immediate feedback, and — if the full-page navigation stalls on a flaky
 * network — it reveals a manual "Continue to payment" link (a real anchor, so the
 * tap is a fresh user-gesture navigation, the most reliable retry). A secondary
 * "View order status" link is an escape hatch if the payment host is unreachable.
 *
 * Rendered only when `url` is set; the parent triggers the actual
 * `window.location.href = url` after mounting this so it paints first.
 */
export function RedirectingOverlay({ url, trackUrl }: { url: string | null; trackUrl?: string }) {
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    if (!url) {
      setShowManual(false);
      return;
    }
    const t = setTimeout(() => setShowManual(true), MANUAL_LINK_DELAY_MS);
    return () => clearTimeout(t);
  }, [url]);

  return (
    <AnimatePresence>
      {url && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center p-6 bg-[color:var(--brand)] text-white"
          role="status"
          aria-live="polite"
        >
          <div className="w-full max-w-sm text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-white/10">
              <Lock className="h-7 w-7" />
            </div>
            <div className="mt-5 flex items-center justify-center gap-2 font-display text-2xl">
              <Loader2 className="h-5 w-5 animate-spin" /> Taking you to secure payment…
            </div>
            <p className="mt-2 text-sm text-white/70">
              Please don't close this page. You'll come right back once payment is done.
            </p>

            <AnimatePresence>
              {showManual && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-8"
                >
                  <p className="text-sm text-white/80">Not redirected yet?</p>
                  <a
                    href={url}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-4 text-sm font-bold hover:opacity-90 transition"
                  >
                    Continue to payment <ExternalLink className="h-4 w-4" />
                  </a>
                  {trackUrl && (
                    <a
                      href={trackUrl}
                      className="mt-3 inline-block text-xs text-white/60 underline underline-offset-2 hover:text-white/80"
                    >
                      View order status instead
                    </a>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
