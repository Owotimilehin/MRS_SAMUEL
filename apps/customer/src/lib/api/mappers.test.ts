// apps/customer/src/lib/api/mappers.test.ts
import { describe, it, expect } from "vitest";
import { toUiProduct } from "./mappers";
import type { ApiProduct } from "./types";

const api: ApiProduct = {
  id: "p1", name: "Sunrise Blend", slug: "sunrise", category: "regular",
  ingredients: ["carrot", "orange"], image_url: null,
  tagline: "Morning in a bottle", story: "story", pairing: "toast", note: null,
  benefits: ["energy"], best_for: ["mornings"],
  ingredient_details: [{ name: "carrot", benefit: "vitamin a" }],
  palette: { surface: "#fff", accent: "#f80", text: "#000" },
  bottle_url: "https://cdn/bottle.png", cluster_url: null, fruit_url: null,
  price_ngn: 2500,
  variants: [
    { id: "v330", size_ml: 330, sku: "S-330", price_ngn: 2500 },
    { id: "v650", size_ml: 650, sku: "S-650", price_ngn: 4200 },
  ],
};

describe("toUiProduct", () => {
  it("collapses variants into prices + variantIds keyed by size label", () => {
    const p = toUiProduct(api);
    expect(p.prices).toEqual({ "330ml": 2500, "650ml": 4200 });
    expect(p.variantIds).toEqual({ "330ml": "v330", "650ml": "v650" });
  });

  it("maps regular→Classic and image_url/bottle_url→image", () => {
    const p = toUiProduct(api);
    expect(p.category).toBe("Classic");
    expect(p.image).toBe("https://cdn/bottle.png");
  });

  it("maps non-regular category→Special", () => {
    expect(toUiProduct({ ...api, category: "special" }).category).toBe("Special");
    expect(toUiProduct({ ...api, category: "punch" }).category).toBe("Special");
  });

  it("derives cluster from slug when API omits it", () => {
    expect(toUiProduct(api).cluster).toBe("citrus");
  });

  it("falls back to a bundled bottle when no image url is present", () => {
    const p = toUiProduct({ ...api, image_url: null, bottle_url: null });
    expect(typeof p.image).toBe("string");
    expect(p.image.length).toBeGreaterThan(0);
  });
});
