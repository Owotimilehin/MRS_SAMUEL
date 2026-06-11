import { describe, it, expect } from "vitest";
import type { CartItem } from "./cart";
import type { Product } from "@/data/products";
import {
  resolveCart,
  allResolved,
  liveSubtotal,
  toOrderItems,
  type CatalogProductLike,
} from "./resolve-cart";

// Minimal Product stub — only the fields the resolver reads.
function product(id: string, prices: { "330ml": number; "650ml": number }): Product {
  return { id, prices } as unknown as Product;
}
function cartItem(id: string, size: "330ml" | "650ml", qty: number, prices: { "330ml": number; "650ml": number }): CartItem {
  return { id: `${id}-${size}`, product: product(id, prices), size, qty };
}

const catalog: CatalogProductLike[] = [
  {
    slug: "sunrise",
    variants: [
      { id: "v-330", size_ml: 330, price_ngn: 2600 },
      { id: "v-650", size_ml: 650, price_ngn: 3500 },
    ],
  },
];

describe("resolveCart", () => {
  it("matches on slug + size and re-prices from live data", () => {
    const lines = resolveCart([cartItem("sunrise", "330ml", 2, { "330ml": 2500, "650ml": 3500 })], catalog);
    expect(lines[0].matched).toBe(true);
    expect(lines[0].variantId).toBe("v-330");
    expect(lines[0].livePriceNgn).toBe(2600);
    expect(lines[0].priceChanged).toBe(true); // 2500 -> 2600
  });

  it("flags an unknown slug as unmatched", () => {
    const lines = resolveCart([cartItem("ghost", "330ml", 1, { "330ml": 2500, "650ml": 3500 })], catalog);
    expect(lines[0].matched).toBe(false);
    expect(lines[0].variantId).toBeNull();
  });

  it("flags a size not sold for that product as unmatched", () => {
    const onlyBig: CatalogProductLike[] = [{ slug: "sunrise", variants: [{ id: "v-650", size_ml: 650, price_ngn: 3500 }] }];
    const lines = resolveCart([cartItem("sunrise", "330ml", 1, { "330ml": 2500, "650ml": 3500 })], onlyBig);
    expect(lines[0].matched).toBe(false);
  });

  it("allResolved requires a non-empty, fully-matched cart", () => {
    expect(allResolved([])).toBe(false);
    const ok = resolveCart([cartItem("sunrise", "650ml", 1, { "330ml": 2500, "650ml": 3500 })], catalog);
    expect(allResolved(ok)).toBe(true);
  });

  it("liveSubtotal and toOrderItems use live prices and matched variants", () => {
    const lines = resolveCart(
      [
        cartItem("sunrise", "330ml", 2, { "330ml": 2500, "650ml": 3500 }),
        cartItem("ghost", "650ml", 1, { "330ml": 2500, "650ml": 3500 }),
      ],
      catalog,
    );
    expect(liveSubtotal(lines)).toBe(5200); // 2 * 2600, ghost contributes 0
    expect(toOrderItems(lines)).toEqual([{ variant_id: "v-330", quantity: 2 }]);
  });
});
