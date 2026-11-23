import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

export type OfferAvailability = "InStock" | "OutOfStock" | "PreOrder";

export interface ProductOffer {
  /** Lowest price (₦) a shopper can actually buy at, given the availability. */
  priceNgn: number;
  availability: OfferAvailability;
}

const SIZES: Size[] = ["330ml", "650ml"];

/**
 * The single Offer for a juice's Product schema, from live catalogue data.
 *
 * - Only sizes the product really sells count (`variantIds`), so the mapper's
 *   price fallback for a missing size never leaks into the schema.
 * - Any size with stock: InStock, priced at the cheapest size that is in stock
 *   (never advertise an in-stock price for a size that is sold out).
 * - Sizes exist but none has stock: PreOrder at the cheapest size. The shop
 *   still takes these orders and presses them for a later slot (see
 *   `deliveryPromise` in availability-label.ts), so OutOfStock would be wrong.
 * - No sellable sizes at all: OutOfStock, or null when there is no price.
 */
export function productOffer(
  p: Pick<Product, "prices" | "variantIds" | "availableBySize">,
): ProductOffer | null {
  const sold = SIZES.filter((s) => p.variantIds[s] && p.prices[s] > 0);
  if (sold.length === 0) {
    const any = SIZES.map((s) => p.prices[s]).filter((n) => n > 0);
    return any.length ? { priceNgn: Math.min(...any), availability: "OutOfStock" } : null;
  }
  const inStock = sold.filter((s) => (p.availableBySize[s] ?? 0) > 0);
  const pool = inStock.length ? inStock : sold;
  return {
    priceNgn: Math.min(...pool.map((s) => p.prices[s])),
    availability: inStock.length ? "InStock" : "PreOrder",
  };
}
