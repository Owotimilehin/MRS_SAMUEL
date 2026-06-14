import { describe, it, expect } from "vitest";
import { looksLikeBareId } from "./product-name.js";

describe("looksLikeBareId", () => {
  it("flags 8-char hex names (the junk-product fingerprint)", () => {
    expect(looksLikeBareId("0a5c7c72")).toBe(true);
    expect(looksLikeBareId("624f8ab2")).toBe(true);
    expect(looksLikeBareId("E4DB2505")).toBe(true); // case-insensitive
  });
  it("flags full and truncated uuids", () => {
    expect(looksLikeBareId("0a5c7c72-1234-4abc-8def-1234567890ab")).toBe(true);
  });
  it("accepts real flavour names", () => {
    expect(looksLikeBareId("Crimson Elixir")).toBe(false);
    expect(looksLikeBareId("Lemon Sip")).toBe(false);
    expect(looksLikeBareId("Pure Green")).toBe(false);
    expect(looksLikeBareId("7Up Clone")).toBe(false); // has non-hex letters
  });
});
