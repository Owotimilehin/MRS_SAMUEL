// apps/customer/src/lib/stock-summary.ts
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

export type StockStatus = "in_stock" | "preorder";
export type StockSummary = Partial<Record<Size, StockStatus>>;

const SIZES: Size[] = ["330ml", "650ml"];

/**
 * Derive a per-size stock summary from a list of products.
 * A size is "in_stock" if ANY product has availableBySize[size] > 0, else "preorder".
 */
export function deriveStockSummary(products: Product[]): StockSummary {
  const summary: StockSummary = {};
  for (const size of SIZES) {
    const hasStock = products.some((p) => (p.availableBySize[size] ?? 0) > 0);
    summary[size] = hasStock ? "in_stock" : "preorder";
  }
  return summary;
}

/**
 * Stable three-tier sort, original order preserved within each tier:
 *   2 — 650ml in stock
 *   1 — 650ml not in stock, but 330ml in stock (buyable now, just not in 650ml)
 *   0 — nothing in stock
 * So a 330ml-in-stock bottle (even one with no 650ml variant at all) outranks a
 * zero-stock 650ml bottle. Returns a new array; the input is not mutated.
 */
export function sortByStock650(products: Product[]): Product[] {
  const rank = (p: Product): number => {
    if ((p.availableBySize["650ml"] ?? 0) > 0) return 2;
    if ((p.availableBySize["330ml"] ?? 0) > 0) return 1;
    return 0;
  };
  // filter-per-tier keeps the sort stable (original order within each tier).
  return [
    ...products.filter((p) => rank(p) === 2),
    ...products.filter((p) => rank(p) === 1),
    ...products.filter((p) => rank(p) === 0),
  ];
}
