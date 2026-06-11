import type { CartItem } from "./cart";

// Structural shape the resolver needs from a catalog product. The richer
// CatalogProduct from api.ts is assignable to this.
export interface CatalogVariantLike {
  id: string;
  size_ml: number;
  price_ngn: number;
}
export interface CatalogProductLike {
  slug: string;
  variants: CatalogVariantLike[];
}

const SIZE_ML: Record<string, number> = { "330ml": 330, "650ml": 650 };

export interface ResolvedLine {
  item: CartItem;
  variantId: string | null;
  livePriceNgn: number | null;
  staticPriceNgn: number;
  matched: boolean;
  priceChanged: boolean;
}

export function resolveCart(items: CartItem[], catalog: CatalogProductLike[]): ResolvedLine[] {
  const bySlug = new Map(catalog.map((p) => [p.slug, p]));
  return items.map((item) => {
    const staticPriceNgn = item.product.prices[item.size];
    const product = bySlug.get(item.product.id);
    const sizeMl = SIZE_ML[item.size];
    const variant = product?.variants.find((v) => v.size_ml === sizeMl);
    if (!product || !variant) {
      return { item, variantId: null, livePriceNgn: null, staticPriceNgn, matched: false, priceChanged: false };
    }
    return {
      item,
      variantId: variant.id,
      livePriceNgn: variant.price_ngn,
      staticPriceNgn,
      matched: true,
      priceChanged: variant.price_ngn !== staticPriceNgn,
    };
  });
}

export function allResolved(lines: ResolvedLine[]): boolean {
  return lines.length > 0 && lines.every((l) => l.matched);
}

export function liveSubtotal(lines: ResolvedLine[]): number {
  return lines.reduce((sum, l) => sum + (l.livePriceNgn ?? 0) * l.item.qty, 0);
}

export function toOrderItems(lines: ResolvedLine[]): { variant_id: string; quantity: number }[] {
  return lines
    .filter((l) => l.matched && l.variantId)
    .map((l) => ({ variant_id: l.variantId as string, quantity: l.item.qty }));
}
