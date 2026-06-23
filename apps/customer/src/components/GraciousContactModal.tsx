import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface Props {
  onContinue: () => void;
  onClose: () => void;
}

/**
 * Shown at checkout when the order is made-to-order (a line is out of stock or
 * a preorder-only size). Reassures the customer and lets them proceed to
 * payment unchanged.
 */
export function GraciousContactModal({ onContinue, onClose }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);

  // Focus the CTA on mount for keyboard/screen-reader accessibility.
  useEffect(() => {
    btnRef.current?.focus();
  }, []);

  // Dismiss on Escape — matches the CartDrawer / other overlays pattern.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <AnimatePresence>
      {/* Scrim — same classNames as CartDrawer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
        aria-hidden="true"
      />

      {/* Card */}
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gracious-modal-heading"
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ type: "spring", damping: 26, stiffness: 280 }}
        onClick={(e) => e.stopPropagation()}
        className="fixed inset-0 z-50 m-auto flex h-fit max-h-[90dvh] w-full max-w-sm flex-col overflow-y-auto rounded-[1.5rem] bg-white p-7 shadow-2xl ring-1 ring-black/5"
      >
        <h2
          id="gracious-modal-heading"
          className="font-display text-2xl text-[color:var(--brand)] leading-snug"
        >
          🍊 You can still place this order!
        </h2>

        <p className="mt-3 text-sm text-[color:var(--brand)]/75 leading-relaxed">
          Some of these are being freshly prepared. Pay now and we&apos;ll
          WhatsApp you within 5 minutes of payment with the nearest delivery
          time — delivery is typically under 24 hours.
        </p>

        <button
          ref={btnRef}
          type="button"
          onClick={onContinue}
          className="mt-6 w-full rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-4 text-sm font-bold hover:opacity-90 transition"
        >
          Continue to payment
        </button>

        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-full py-2 text-xs font-semibold text-[color:var(--brand)]/50 hover:text-[color:var(--brand)]/80 transition"
        >
          Go back
        </button>
      </motion.div>
    </AnimatePresence>
  );
}
