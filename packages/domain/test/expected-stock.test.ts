import { describe, it, expect } from "vitest";
import { expectedStockKey, expectedStockMap, type ExpectedStockLine } from "../src/daily-close.js";

describe("expectedStock helpers", () => {
  it("keys a typed and an untyped line distinctly", () => {
    expect(expectedStockKey("p1", "v1")).toBe("p1::v1");
    expect(expectedStockKey("p1", null)).toBe("p1::");
  });

  it("builds a balance map keyed per (product, variant)", () => {
    const lines: ExpectedStockLine[] = [
      { product_id: "p1", variant_id: "v50", size_ml: 50, balance: 90 },
      { product_id: "p1", variant_id: "v330", size_ml: 330, balance: 40 },
      { product_id: "p1", variant_id: null, size_ml: null, balance: 5 },
    ];
    const map = expectedStockMap(lines);
    expect(map.get("p1::v50")).toBe(90);
    expect(map.get("p1::v330")).toBe(40);
    expect(map.get("p1::")).toBe(5);
    expect(map.size).toBe(3);
  });
});
