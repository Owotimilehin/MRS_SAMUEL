// apps/customer/src/components/StockBanner.test.ts
// Tests the pure deriveStockSummary helper exported from stock-summary.ts (node env, no DOM).
import { describe, it, expect } from "vitest";
import { deriveStockSummary } from "@/lib/stock-summary";
import { buildBannerMessages } from "./StockBanner";
import type { Product } from "@/lib/api/mappers";
import type { Size } from "@/lib/visuals";

/** Minimal Product stub with just the fields deriveStockSummary needs. */
function makeProduct(availableBySize: Partial<Record<Size, number>>): Product {
  return {
    id: "test",
    productId: "uuid-test",
    name: "Test Juice",
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

describe("deriveStockSummary", () => {
  it("marks 650ml in_stock and 330ml preorder when only 650ml has stock", () => {
    const products = [makeProduct({ "650ml": 10, "330ml": 0 })];
    const summary = deriveStockSummary(products);
    // "650ml" → delivery
    expect(summary["650ml"]).toBe("in_stock");
    // "330ml" → preorder
    expect(summary["330ml"]).toBe("preorder");
  });

  it("marks a size in_stock if ANY product has stock for that size", () => {
    const products = [
      makeProduct({ "650ml": 0, "330ml": 0 }),
      makeProduct({ "650ml": 3, "330ml": 0 }),
    ];
    const summary = deriveStockSummary(products);
    expect(summary["650ml"]).toBe("in_stock");
    expect(summary["330ml"]).toBe("preorder");
  });

  it("marks both sizes preorder when no products have stock", () => {
    const products = [makeProduct({ "650ml": 0, "330ml": 0 })];
    const summary = deriveStockSummary(products);
    expect(summary["650ml"]).toBe("preorder");
    expect(summary["330ml"]).toBe("preorder");
  });

  it("marks both sizes in_stock when all sizes have stock", () => {
    const products = [makeProduct({ "650ml": 5, "330ml": 2 })];
    const summary = deriveStockSummary(products);
    expect(summary["650ml"]).toBe("in_stock");
    expect(summary["330ml"]).toBe("in_stock");
  });

  it("returns preorder for a size absent from availableBySize (defaults to 0)", () => {
    const products = [makeProduct({})];
    const summary = deriveStockSummary(products);
    expect(summary["650ml"]).toBe("preorder");
    expect(summary["330ml"]).toBe("preorder");
  });

  it("returns preorder for all sizes on an empty product list", () => {
    const summary = deriveStockSummary([]);
    expect(summary["650ml"]).toBe("preorder");
    expect(summary["330ml"]).toBe("preorder");
  });
});

describe("buildBannerMessages", () => {
  it("assembles in_stock message with 'delivery' text and size for 650ml", () => {
    const summary = { "650ml": "in_stock" as const, "330ml": "preorder" as const };
    const messages = buildBannerMessages(summary);
    expect(messages["650ml"]).toBeDefined();
    expect(messages["650ml"]!.toLowerCase()).toContain("delivery");
    expect(messages["650ml"]).toContain("650ml");
  });

  it("assembles preorder message with 'preorder' text and size for 330ml", () => {
    const summary = { "650ml": "in_stock" as const, "330ml": "preorder" as const };
    const messages = buildBannerMessages(summary);
    expect(messages["330ml"]).toBeDefined();
    expect(messages["330ml"]!.toLowerCase()).toContain("preorder");
    expect(messages["330ml"]).toContain("330ml");
  });

  it("handles all in_stock sizes", () => {
    const summary = { "650ml": "in_stock" as const, "330ml": "in_stock" as const };
    const messages = buildBannerMessages(summary);
    expect(messages["650ml"]!.toLowerCase()).toContain("delivery");
    expect(messages["330ml"]!.toLowerCase()).toContain("delivery");
  });

  it("handles all preorder sizes", () => {
    const summary = { "650ml": "preorder" as const, "330ml": "preorder" as const };
    const messages = buildBannerMessages(summary);
    expect(messages["650ml"]!.toLowerCase()).toContain("preorder");
    expect(messages["330ml"]!.toLowerCase()).toContain("preorder");
  });
});
