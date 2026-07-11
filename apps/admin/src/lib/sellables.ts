import type { ProductRow, VariantRow, PriceRow } from "../db/local.js";

// A single sellable line on the till: one can size of one flavour, priced.
export interface Sellable {
  product: ProductRow;
  variant: VariantRow;
  price: number;
}

// Price for an exact can size: most recent open price for that variant, falling
// back to a product-level (variant-less) price for legacy rows.
export function priceForVariant(
  prices: PriceRow[],
  productId: string,
  variantId: string,
): number {
  const open = prices.filter((p) => !p.valid_to);
  const byNewest = (a: PriceRow, b: PriceRow): number =>
    a.valid_from > b.valid_from ? -1 : 1;
  const exact = open.filter((p) => p.variant_id === variantId).sort(byNewest);
  if (exact[0]) return exact[0].price_ngn;
  const fallback = open
    .filter((p) => p.product_id === productId && p.variant_id == null)
    .sort(byNewest);
  return fallback[0]?.price_ngn ?? 0;
}

/**
 * Expand the synced catalog into one sellable per (flavour × size), sorted by
 * flavour name then size.
 *
 * RETIRED SIZES ARE INCLUDED. Retiring a size (`variant.is_active === false`)
 * is a STOREFRONT-only rule: it hides the size from online customers (see the
 * API's public-catalog) but the till must still sell it — there may be stock on
 * hand and the counter is the source of truth for what staff can ring up. Only
 * soft-deleted variants are dropped, and the sync layer already excludes those.
 * A deactivated *product* (a whole flavour discontinued) is still skipped.
 */
export function buildSellables(
  products: ProductRow[],
  variants: VariantRow[],
  prices: PriceRow[],
): Sellable[] {
  const byProduct = new Map(products.map((p) => [p.id, p]));
  return variants
    .map((v) => {
      const product = byProduct.get(v.product_id);
      if (!product || !product.is_active) return null;
      return { product, variant: v, price: priceForVariant(prices, product.id, v.id) };
    })
    .filter((s): s is Sellable => s !== null)
    .sort(
      (a, b) =>
        a.product.name.localeCompare(b.product.name) || a.variant.size_ml - b.variant.size_ml,
    );
}
