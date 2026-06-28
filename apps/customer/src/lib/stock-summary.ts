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
