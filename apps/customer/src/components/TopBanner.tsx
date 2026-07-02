import { useState } from "react";

/**
 * The owner's custom homepage banner. Same brand bar as StockBanner, but the
 * text is owner-authored. Supports simple multi-line messages.
 */
export function TopBanner({ message }: { message: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      className="relative z-20 bg-[color:var(--brand)] text-white text-[13px] font-medium text-center px-10 py-2.5 leading-snug whitespace-pre-line"
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss banner"
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100 transition-opacity"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
