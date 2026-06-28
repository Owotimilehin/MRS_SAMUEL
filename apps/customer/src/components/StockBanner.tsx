import { useState } from "react";
import type { Size } from "@/lib/visuals";
import type { StockSummary, StockStatus } from "@/lib/stock-summary";

export type { StockSummary, StockStatus } from "@/lib/stock-summary";
export { deriveStockSummary } from "@/lib/stock-summary";

interface StockBannerProps {
  summary: StockSummary;
}

const SIZE_LABELS: Record<Size, string> = {
  "650ml": "650ml",
  "330ml": "330ml",
};

function buildBannerParts(summary: StockSummary): { inStock: Size[]; preorder: Size[] } {
  const inStock: Size[] = [];
  const preorder: Size[] = [];
  for (const [size, status] of Object.entries(summary) as [Size, StockStatus][]) {
    if (status === "in_stock") inStock.push(size);
    else preorder.push(size);
  }
  return { inStock, preorder };
}

export function StockBanner({ summary }: StockBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const { inStock, preorder } = buildBannerParts(summary);
  if (inStock.length === 0 && preorder.length === 0) return null;

  const parts: string[] = [];
  if (inStock.length > 0) {
    parts.push(
      `${inStock.map((s) => SIZE_LABELS[s]).join(" & ")} ready for same-day delivery`
    );
  }
  if (preorder.length > 0) {
    parts.push(
      `${preorder.map((s) => SIZE_LABELS[s]).join(" & ")} on preorder (arrives next delivery day)`
    );
  }
  const message = parts.join(" · ");

  return (
    <div
      className="relative z-20 bg-[color:var(--brand)] text-white text-[13px] font-medium text-center px-10 py-2.5 leading-snug"
      role="status"
      aria-live="polite"
    >
      <span>{message}</span>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss stock banner"
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100 transition-opacity"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
