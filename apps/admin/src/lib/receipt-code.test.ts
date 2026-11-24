import { describe, it, expect } from "vitest";
import {
  receiptCodeFromSaleId,
  parseReceiptCode,
  isValidSalesSearch,
  isServerOrderNumber,
} from "./receipt-code.js";

describe("receiptCodeFromSaleId", () => {
  it("is R- plus the first 8 hex of the id, upper-cased", () => {
    expect(receiptCodeFromSaleId("1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d")).toBe("R-1A2B3C4D");
  });

  it("round-trips through the parser back to the id prefix", () => {
    const id = crypto.randomUUID();
    expect(parseReceiptCode(receiptCodeFromSaleId(id))).toBe(id.slice(0, 8));
  });
});

describe("parseReceiptCode", () => {
  it("accepts any case, with or without the dash, ignoring spaces around it", () => {
    expect(parseReceiptCode("r-deadbeef")).toBe("deadbeef");
    expect(parseReceiptCode("RDEADBEEF")).toBe("deadbeef");
    expect(parseReceiptCode("  R-DEADBEEF  ")).toBe("deadbeef");
  });

  it("rejects wrong lengths, non-hex and missing R", () => {
    for (const bad of ["", "R-", "R-DEADBEE", "R-DEADBEEF0", "R-DEADBEEG", "DEADBEEF", "R_DEADBEEF", "LOCAL-abc"]) {
      expect(parseReceiptCode(bad)).toBeNull();
    }
  });
});

describe("isValidSalesSearch", () => {
  it("accepts receipt codes and order numbers", () => {
    expect(isValidSalesSearch("R-DEADBEEF")).toBe(true);
    expect(isValidSalesSearch("SO-2026-00123")).toBe(true);
    expect(isValidSalesSearch("00123")).toBe(true);
  });

  it("rejects wildcards, spaces and blanks", () => {
    for (const bad of ["", "  ", "%", "SO_1", "a b", "x'y"]) expect(isValidSalesSearch(bad)).toBe(false);
  });
});

describe("isServerOrderNumber", () => {
  it("tells real SO numbers from till placeholders", () => {
    expect(isServerOrderNumber("SO-2026-00001")).toBe(true);
    expect(isServerOrderNumber("R-DEADBEEF")).toBe(false);
    expect(isServerOrderNumber("LOCAL-lx3k9")).toBe(false);
    expect(isServerOrderNumber(undefined)).toBe(false);
  });
});
