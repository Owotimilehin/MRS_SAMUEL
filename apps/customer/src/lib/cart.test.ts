// apps/customer/src/lib/cart.test.ts
import { describe, it, expect } from "vitest";
import { isPreorderLine } from "./cart";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

/** Build a minimal Product stub with just the fields cart helpers need. */
function makeProduct(overrides: { availableBySize?: Partial<Record<Size, number>> } = {}): Product {
  return {
    id: "test-juice",
    productId: "uuid-test",
    name: "Test Juice",
    tagline: "Tasty",
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
    variantIds: { "330ml": "v330", "650ml": "v650" },
    availableBySize: overrides.availableBySize ?? { "330ml": 0, "650ml": 0 },
  };
}

describe("isPreorderLine", () => {
  it("flips a line to preorder when qty exceeds stock", () => {
    const p = makeProduct({ availableBySize: { "650ml": 3, "330ml": 0 } });
    expect(isPreorderLine(p, "650ml", 3)).toBe(false);
    expect(isPreorderLine(p, "650ml", 4)).toBe(true);
    expect(isPreorderLine(p, "330ml", 1)).toBe(true);
  });

  it("returns false when qty is exactly at stock level", () => {
    const p = makeProduct({ availableBySize: { "650ml": 5, "330ml": 2 } });
    expect(isPreorderLine(p, "650ml", 5)).toBe(false);
    expect(isPreorderLine(p, "330ml", 2)).toBe(false);
  });

  it("returns true for any qty when size is absent from availableBySize (defaults to 0)", () => {
    const p = makeProduct({ availableBySize: {} });
    expect(isPreorderLine(p, "650ml", 1)).toBe(true);
    expect(isPreorderLine(p, "330ml", 1)).toBe(true);
  });
});
