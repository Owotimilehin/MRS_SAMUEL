import { describe, expect, it } from "vitest";
import { productOffer } from "./product-offer";

const base = { prices: { "330ml": 2500, "650ml": 3500 } };

describe("productOffer (SEO Q3)", () => {
  it("in stock: cheapest size that has stock", () => {
    expect(
      productOffer({
        ...base,
        variantIds: { "330ml": "a", "650ml": "b" },
        availableBySize: { "330ml": 0, "650ml": 36 },
      }),
    ).toEqual({ priceNgn: 3500, availability: "InStock" });
    expect(
      productOffer({
        ...base,
        variantIds: { "330ml": "a", "650ml": "b" },
        availableBySize: { "330ml": 4, "650ml": 36 },
      }),
    ).toEqual({ priceNgn: 2500, availability: "InStock" });
  });

  it("no stock anywhere: PreOrder at the cheapest size sold", () => {
    expect(
      productOffer({
        prices: { "330ml": 2800, "650ml": 4500 },
        variantIds: { "330ml": "a", "650ml": "b" },
        availableBySize: { "330ml": 0, "650ml": 0 },
      }),
    ).toEqual({ priceNgn: 2800, availability: "PreOrder" });
  });

  it("ignores the mapper's price fallback for a size that is not sold", () => {
    // Mapper fills prices["330ml"] even when only 650ml exists.
    expect(
      productOffer({
        prices: { "330ml": 3500, "650ml": 3500 },
        variantIds: { "650ml": "b" },
        availableBySize: { "650ml": 5 },
      }),
    ).toEqual({ priceNgn: 3500, availability: "InStock" });
  });

  it("no sellable variants: OutOfStock, or null with no price", () => {
    expect(productOffer({ ...base, variantIds: {}, availableBySize: {} })).toEqual({
      priceNgn: 2500,
      availability: "OutOfStock",
    });
    expect(
      productOffer({ prices: { "330ml": 0, "650ml": 0 }, variantIds: {}, availableBySize: {} }),
    ).toBeNull();
  });
});
