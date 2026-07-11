import { describe, it, expect } from "vitest";
import { buildSellables, priceForVariant } from "./sellables.js";
import type { ProductRow, VariantRow, PriceRow } from "../db/local.js";

const product = (over: Partial<ProductRow> = {}): ProductRow => ({
  id: "p1",
  name: "Guava punch",
  slug: "guava-punch",
  category: "juice",
  ingredients: [],
  is_active: true,
  ...over,
});

const variant = (over: Partial<VariantRow> = {}): VariantRow => ({
  id: "v-330",
  product_id: "p1",
  size_ml: 330,
  sku: "GP-330",
  is_active: true,
  ...over,
});

const price = (over: Partial<PriceRow> = {}): PriceRow => ({
  id: "pr1",
  product_id: "p1",
  variant_id: "v-330",
  size_ml: 330,
  price_ngn: 2500,
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_to: null,
  ...over,
});

describe("buildSellables", () => {
  // The bug: retiring a 330ml (is_active=false) dropped it from the till, so
  // only flavours with an active 330ml could be sold at the counter. Retire is
  // a customer-facing rule — the till must still sell the size.
  it("includes a RETIRED size so the till can still sell it", () => {
    const retired = variant({ id: "v-330", is_active: false });
    const out = buildSellables([product()], [retired], [price()]);
    const s = out.find((x) => x.variant.id === "v-330");
    expect(s).toBeDefined();
    expect(s!.price).toBe(2500);
  });

  it("still skips a variant whose whole flavour (product) is deactivated", () => {
    const out = buildSellables(
      [product({ is_active: false })],
      [variant({ is_active: false })],
      [price()],
    );
    expect(out).toHaveLength(0);
  });

  it("sorts by flavour name then size", () => {
    const products = [
      product({ id: "p1", name: "Zesty Sunrise" }),
      product({ id: "p2", name: "Apple Zing" }),
    ];
    const variants = [
      variant({ id: "a-650", product_id: "p2", size_ml: 650, is_active: false }),
      variant({ id: "a-330", product_id: "p2", size_ml: 330 }),
      variant({ id: "z-330", product_id: "p1", size_ml: 330 }),
    ];
    const prices = [
      price({ id: "1", product_id: "p2", variant_id: "a-330", price_ngn: 2000 }),
      price({ id: "2", product_id: "p2", variant_id: "a-650", price_ngn: 4000 }),
      price({ id: "3", product_id: "p1", variant_id: "z-330", price_ngn: 2500 }),
    ];
    const names = buildSellables(products, variants, prices).map(
      (s) => `${s.product.name} ${s.variant.size_ml}`,
    );
    expect(names).toEqual(["Apple Zing 330", "Apple Zing 650", "Zesty Sunrise 330"]);
  });
});

describe("priceForVariant", () => {
  it("prefers the most recent open exact-variant price", () => {
    const prices = [
      price({ id: "old", valid_from: "2026-01-01T00:00:00.000Z", price_ngn: 2000 }),
      price({ id: "new", valid_from: "2026-06-01T00:00:00.000Z", price_ngn: 2500 }),
    ];
    expect(priceForVariant(prices, "p1", "v-330")).toBe(2500);
  });

  it("falls back to a legacy product-level (variant-less) price", () => {
    const legacy = price({ id: "leg", variant_id: null, price_ngn: 1800 });
    expect(priceForVariant([legacy], "p1", "v-330")).toBe(1800);
  });

  it("returns 0 when no price applies", () => {
    expect(priceForVariant([], "p1", "v-330")).toBe(0);
  });
});
