// apps/customer/src/lib/api/mappers.test.ts
import { describe, it, expect } from "vitest";
import { toUiProduct, toUiPostSummary } from "./mappers";
import type { ApiProduct, ApiBlogSummary } from "./types";

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

/** Helper: build an ApiProduct with per-size overrides (available). */
function fixtureWithVariants(sizes: Partial<Record<"650ml" | "330ml", { available?: number }>>): ApiProduct {
  const variants = (Object.entries(sizes) as [string, { available?: number }][]).map(([label, opts]) => ({
    id: `v-${label}`,
    size_ml: parseInt(label),
    sku: `S-${label}`,
    price_ngn: label === "650ml" ? 4200 : 2500,
    available: opts.available ?? 0,
  }));
  return { ...api, variants } as ApiProduct;
}

describe("availableBySize", () => {
  it("maps per-size available counts", () => {
    const p = toUiProduct(fixtureWithVariants({ "650ml": { available: 5 }, "330ml": { available: 0 } }));
    expect(p.availableBySize["650ml"]).toBe(5);
    expect(p.availableBySize["330ml"]).toBe(0);
  });

  it("defaults to 0 for a size with no available field on the variant", () => {
    const p = toUiProduct(fixtureWithVariants({ "650ml": {}, "330ml": {} }));
    expect(p.availableBySize["650ml"]).toBe(0);
    expect(p.availableBySize["330ml"]).toBe(0);
  });
});

describe("toUiPostSummary", () => {
  const base: ApiBlogSummary = {
    id: "b1", slug: "s", title: "T", excerpt: "e", cover_url: null,
    published_at: "2026-05-01T00:00:00.000Z", author: "Mr X", read_mins: 6,
    category: "Wellness", cluster: "root",
  };

  it("passes through a valid cluster", () => {
    expect(toUiPostSummary(base).cover).toBe("root");
  });

  it("falls back to tropical for an unknown cluster", () => {
    expect(toUiPostSummary({ ...base, cluster: "not-a-cluster" }).cover).toBe("tropical");
  });

  it("defaults author/read_mins when null", () => {
    const p = toUiPostSummary({ ...base, author: null, read_mins: null });
    expect(p.author).toBe("Mrs. Samuel");
    expect(p.readMins).toBe(4);
  });
});
