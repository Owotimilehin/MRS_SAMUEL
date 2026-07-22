import { describe, it, expect } from "vitest";
import { extractOpayReference } from "../../src/routes/webhooks-opay.js";

describe("extractOpayReference", () => {
  it("reads a top-level reference (worker re-fire shape)", () => {
    expect(extractOpayReference({ reference: "MS-1001" })).toBe("MS-1001");
  });

  it("reads a reference nested under data", () => {
    expect(extractOpayReference({ data: { reference: "MS-1002" } })).toBe("MS-1002");
  });

  it("reads a reference nested under payload", () => {
    expect(extractOpayReference({ payload: { reference: "MS-1003" } })).toBe("MS-1003");
  });

  it("finds a reference nested deeper than the known shapes", () => {
    expect(extractOpayReference({ event: { order: { reference: "MS-1004" } } })).toBe("MS-1004");
  });

  it("does NOT grab OPay's own transaction_reference / orderNo (exact key only)", () => {
    // Only OPay's identifiers are present, not OUR merchant reference — must not
    // return one of those, or we'd query status by the wrong id (a no-op bug).
    expect(
      extractOpayReference({ data: { transaction_reference: "OP-999", orderNo: "OP-777" } }),
    ).toBeUndefined();
  });

  it("prefers our reference even when OPay identifiers sit alongside it", () => {
    expect(
      extractOpayReference({ data: { reference: "MS-1005", transaction_reference: "OP-999" } }),
    ).toBe("MS-1005");
  });

  it("treats an empty-string reference as missing", () => {
    expect(extractOpayReference({ reference: "   " })).toBeUndefined();
  });

  it("returns undefined for a missing reference", () => {
    expect(extractOpayReference({ status: "SUCCESS" })).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(extractOpayReference(null)).toBeUndefined();
    expect(extractOpayReference("MS-1001")).toBeUndefined();
    expect(extractOpayReference(42)).toBeUndefined();
  });

  it("is depth-bounded and does not throw on deep/cyclic-ish nesting", () => {
    let deep: Record<string, unknown> = { reference: "MS-DEEP" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    // Beyond the depth cap it simply returns undefined rather than throwing.
    expect(() => extractOpayReference(deep)).not.toThrow();
  });
});
