/**
 * Rebuild a basket server-side from the cart cookie + the live catalog.
 *
 * The cookie only carries variant ids and quantities. Everything a customer
 * sees or pays — name, size, unit price, stock — is resolved here from the
 * catalog, so a hand-edited cookie can change which variants are in the basket
 * (the API re-validates those anyway) but can never change a price.
 *
 * Pure and I/O-free so it can be unit-tested; the server function in
 * `api/server-fns.ts` supplies the cookie value and the catalog.
 */
import type { ApiProduct } from "@/lib/api/types";
import type { CartCookieLine } from "@/lib/cart-cookie";

export interface ResolvedCartLine {
  variantId: string;
  productSlug: string;
  name: string;
  /** e.g. "650ml" */
  size: string;
  unitPriceNgn: number;
  qty: number;
  available: number;
  /** Wanted qty exceeds available stock — mirrors isPreorderLine() on the client. */
  preorder: boolean;
  lineTotalNgn: number;
  image: string | null;
}

export interface ResolvedCart {
  lines: ResolvedCartLine[];
  subtotalNgn: number;
  itemCount: number;
  hasPreorder: boolean;
  /** Cookie lines whose variant is no longer sellable, dropped from the basket. */
  droppedVariantIds: string[];
}

export const EMPTY_CART: ResolvedCart = {
  lines: [],
  subtotalNgn: 0,
  itemCount: 0,
  hasPreorder: false,
  droppedVariantIds: [],
};

export function resolveCart(
  cookieLines: readonly CartCookieLine[],
  products: readonly ApiProduct[],
): ResolvedCart {
  // variantId -> owning product + variant
  const index = new Map<string, { product: ApiProduct; variant: ApiProduct["variants"][number] }>();
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      index.set(variant.id, { product, variant });
    }
  }

  const lines: ResolvedCartLine[] = [];
  const droppedVariantIds: string[] = [];

  for (const line of cookieLines) {
    const hit = index.get(line.variantId);
    if (!hit) {
      droppedVariantIds.push(line.variantId);
      continue;
    }
    const { product, variant } = hit;
    const unitPriceNgn = variant.price_ngn;
    const available = variant.available ?? 0;
    lines.push({
      variantId: variant.id,
      productSlug: product.slug,
      name: product.name,
      size: `${variant.size_ml}ml`,
      unitPriceNgn,
      qty: line.qty,
      available,
      preorder: line.qty > available,
      lineTotalNgn: unitPriceNgn * line.qty,
      image: product.image_url ?? product.bottle_url ?? null,
    });
  }

  return {
    lines,
    subtotalNgn: lines.reduce((s, l) => s + l.lineTotalNgn, 0),
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
    hasPreorder: lines.some((l) => l.preorder),
    droppedVariantIds,
  };
}
