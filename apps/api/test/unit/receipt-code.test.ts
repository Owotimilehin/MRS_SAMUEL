import { describe, it, expect } from "vitest";
import { parseReceiptCode, parseSalesSearch } from "../../src/lib/receipt-code.js";

describe("parseReceiptCode", () => {
  it("accepts R- plus 8 hex in any case, with or without the dash", () => {
    expect(parseReceiptCode("R-1A2B3C4D")).toBe("1a2b3c4d");
    expect(parseReceiptCode("r1a2b3c4d")).toBe("1a2b3c4d");
    expect(parseReceiptCode("  R-deadbeef ")).toBe("deadbeef");
  });

  it("rejects anything else", () => {
    for (const bad of ["", "R-", "R-1234567", "R-123456789", "R-1234567g", "1a2b3c4d", "R-1a2b%", "R_1a2b3c4d"]) {
      expect(parseReceiptCode(bad)).toBeNull();
    }
  });
});

describe("parseSalesSearch", () => {
  it("routes a receipt code to an id-prefix search", () => {
    expect(parseSalesSearch("R-ABCDEF01")).toEqual({ kind: "receipt", idPrefix: "abcdef01" });
  });

  it("routes order numbers and their tails to an order search", () => {
    expect(parseSalesSearch("SO-2026-00123")).toEqual({ kind: "order", term: "SO-2026-00123" });
    expect(parseSalesSearch("00123")).toEqual({ kind: "order", term: "00123" });
  });

  it("refuses LIKE wildcards, quotes, spaces and blank input", () => {
    for (const bad of ["", "   ", "%", "SO_2026", "a'b", "SO 2026", "x".repeat(33)]) {
      expect(parseSalesSearch(bad)).toBeNull();
    }
  });
});
