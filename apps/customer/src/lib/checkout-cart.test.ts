import { describe, it, expect } from "vitest";
import { resolveCart } from "./checkout-cart";
import type { ApiProduct } from "@/lib/api/types";

const product = (over: Partial<ApiProduct> = {}): ApiProduct =>
  ({
    id: "p1",
    name: "Sunrise Blend",
    slug: "sunrise",
    category: "regular",
    ingredients: [],
    image_url: "/sunrise.png",
    tagline: null,
    story: null,
    pairing: null,
    note: null,
    benefits: [],
    best_for: [],
    ingredient_details: [],
    palette: null,
    bottle_url: null,
    cluster_url: null,
    fruit_url: null,
    price_ngn: 3500,
    variants: [
      { id: "v-650", size_ml: 650, price_ngn: 3500, available: 5 },
      { id: "v-330", size_ml: 330, price_ngn: 2000, available: 0 },
    ],
    ...over,
  }) as ApiProduct;

describe("resolveCart", () => {
  it("prices the basket from the catalog, not the cookie", () => {
    const cart = resolveCart([{ variantId: "v-650", qty: 2 }], [product()]);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({
      name: "Sunrise Blend",
      size: "650ml",
      unitPriceNgn: 3500,
      qty: 2,
      lineTotalNgn: 7000,
    });
    expect(cart.subtotalNgn).toBe(7000);
    expect(cart.itemCount).toBe(2);
  });

  it("sums multiple lines across sizes", () => {
    const cart = resolveCart(
      [
        { variantId: "v-650", qty: 2 },
        { variantId: "v-330", qty: 3 },
      ],
      [product()],
    );
    expect(cart.subtotalNgn).toBe(2 * 3500 + 3 * 2000);
    expect(cart.itemCount).toBe(5);
  });

  it("flags a line as preorder when qty exceeds available stock", () => {
    const cart = resolveCart([{ variantId: "v-650", qty: 9 }], [product()]);
    expect(cart.lines[0].preorder).toBe(true);
    expect(cart.hasPreorder).toBe(true);
  });

  it("does not flag preorder when stock covers the quantity", () => {
    const cart = resolveCart([{ variantId: "v-650", qty: 5 }], [product()]);
    expect(cart.lines[0].preorder).toBe(false);
    expect(cart.hasPreorder).toBe(false);
  });

  it("treats a zero-stock variant as a preorder line rather than dropping it", () => {
    const cart = resolveCart([{ variantId: "v-330", qty: 1 }], [product()]);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].preorder).toBe(true);
  });

  it("drops variants that are no longer in the catalog and reports them", () => {
    const cart = resolveCart(
      [
        { variantId: "v-650", qty: 1 },
        { variantId: "v-retired", qty: 4 },
      ],
      [product()],
    );
    expect(cart.lines.map((l) => l.variantId)).toEqual(["v-650"]);
    expect(cart.droppedVariantIds).toEqual(["v-retired"]);
    expect(cart.subtotalNgn).toBe(3500);
  });

  it("returns an empty basket for an empty cookie", () => {
    const cart = resolveCart([], [product()]);
    expect(cart.lines).toEqual([]);
    expect(cart.subtotalNgn).toBe(0);
    expect(cart.hasPreorder).toBe(false);
  });

  it("ignores a price sent in the cookie — catalog price always wins", () => {
    // A tampered cookie can only carry variantId + qty; even if a caller passes
    // an object with extra fields, the resolved price comes from the catalog.
    const tampered = [{ variantId: "v-650", qty: 1, unitPriceNgn: 1 } as never];
    const cart = resolveCart(tampered, [product()]);
    expect(cart.lines[0].unitPriceNgn).toBe(3500);
    expect(cart.subtotalNgn).toBe(3500);
  });

  it("handles a product with no variants without throwing", () => {
    const cart = resolveCart(
      [{ variantId: "v-650", qty: 1 }],
      [product({ variants: [] as never })],
    );
    expect(cart.lines).toEqual([]);
    expect(cart.droppedVariantIds).toEqual(["v-650"]);
  });
});
