// apps/customer/src/lib/stock-summary.test.ts
// Tests the pure sortByStock650 helper (node env, no DOM).
import { describe, it, expect } from "vitest";
import { sortByStock650 } from "@/lib/stock-summary";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

/** Minimal Product stub: id to identify, availableBySize for the sort key. */
function makeProduct(id: string, availableBySize: Partial<Record<Size, number>>): Product {
  return {
    id,
    productId: `uuid-${id}`,
    name: id,
    tagline: "",
    ingredients: [],
    ingredientDetails: [],
    benefits: [],
    story: "",
    pairing: "",
    bestFor: [],
    category: "Classic",
    cluster: "citrus",
    palette: { surface: "#fff", accent: "#f80", text: "#000" },
    image: "bottle.png",
    prices: { "330ml": 2500, "650ml": 4200 },
    variantIds: {},
    availableBySize,
  };
}

const ids = (products: Product[]) => products.map((p) => p.id);

describe("sortByStock650", () => {
  it("surfaces products with 650ml in stock above out-of-stock ones", () => {
    const out = makeProduct("out", { "650ml": 0 });
    const inStock = makeProduct("in", { "650ml": 5 });
    expect(ids(sortByStock650([out, inStock]))).toEqual(["in", "out"]);
  });

  it("preserves original order within the in-stock bucket", () => {
    const a = makeProduct("a", { "650ml": 1 });
    const b = makeProduct("b", { "650ml": 99 });
    // b has more stock but a came first — order is preserved (no count sort).
    expect(ids(sortByStock650([a, b]))).toEqual(["a", "b"]);
  });

  it("preserves original order within the out-of-stock bucket", () => {
    const a = makeProduct("a", { "650ml": 0 });
    const b = makeProduct("b", { "650ml": 0 });
    expect(ids(sortByStock650([a, b]))).toEqual(["a", "b"]);
  });

  it("sinks a product with no 650ml variant to the bottom bucket", () => {
    const only330 = makeProduct("only330", { "330ml": 20 }); // no 650ml key
    const has650 = makeProduct("has650", { "650ml": 1 });
    expect(ids(sortByStock650([only330, has650]))).toEqual(["has650", "only330"]);
  });

  it("does not mutate the input array", () => {
    const input = [makeProduct("out", { "650ml": 0 }), makeProduct("in", { "650ml": 5 })];
    const before = ids(input);
    sortByStock650(input);
    expect(ids(input)).toEqual(before);
  });

  it("handles an empty list", () => {
    expect(sortByStock650([])).toEqual([]);
  });

  it("handles a single-element list", () => {
    const a = makeProduct("a", { "650ml": 0 });
    expect(ids(sortByStock650([a]))).toEqual(["a"]);
  });
});
