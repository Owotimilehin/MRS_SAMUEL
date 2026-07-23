import { describe, it, expect } from "vitest";
import {
  CART_COOKIE_NAME,
  encodeCartCookie,
  decodeCartCookie,
  readCartFromCookieHeader,
  MAX_CART_COOKIE_BYTES,
} from "./cart-cookie";

describe("cart cookie codec", () => {
  it("round-trips variant id + quantity", () => {
    const lines = [
      { variantId: "a1b2c3d4-0000-4000-8000-000000000001", qty: 2 },
      { variantId: "a1b2c3d4-0000-4000-8000-000000000002", qty: 1 },
    ];
    expect(decodeCartCookie(encodeCartCookie(lines))).toEqual(lines);
  });

  it("encodes to a cookie-safe value (no ; , space or quotes)", () => {
    const raw = encodeCartCookie([{ variantId: "v-1", qty: 3 }]);
    expect(raw).not.toMatch(/[;,\s"\\]/);
  });

  it("returns an empty cart for missing, empty or corrupt values", () => {
    expect(decodeCartCookie(undefined)).toEqual([]);
    expect(decodeCartCookie("")).toEqual([]);
    expect(decodeCartCookie("not-valid-%%%")).toEqual([]);
    expect(decodeCartCookie("eyJib2d1cyI6dHJ1ZX0")).toEqual([]);
  });

  it("drops lines with a non-positive or non-finite quantity", () => {
    const raw = encodeCartCookie([
      { variantId: "keep", qty: 2 },
      { variantId: "zero", qty: 0 },
      { variantId: "neg", qty: -4 },
    ]);
    expect(decodeCartCookie(raw)).toEqual([{ variantId: "keep", qty: 2 }]);
  });

  it("clamps absurd quantities rather than trusting the client", () => {
    const raw = encodeCartCookie([{ variantId: "v", qty: 99999 }]);
    const [line] = decodeCartCookie(raw);
    expect(line.qty).toBeLessThanOrEqual(99);
  });

  it("stays under the cookie size budget for a large basket", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      variantId: `a1b2c3d4-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
      qty: 3,
    }));
    expect(encodeCartCookie(lines).length).toBeLessThan(MAX_CART_COOKIE_BYTES);
  });

  it("truncates rather than emitting an oversized cookie", () => {
    const lines = Array.from({ length: 500 }, (_, i) => ({
      variantId: `variant-with-a-fairly-long-identifier-${i}`,
      qty: 2,
    }));
    expect(encodeCartCookie(lines).length).toBeLessThanOrEqual(MAX_CART_COOKIE_BYTES);
  });

  it("reads the cart out of a full Cookie header, ignoring other cookies", () => {
    const value = encodeCartCookie([{ variantId: "v-9", qty: 4 }]);
    const header = `ms_session=abc; ${CART_COOKIE_NAME}=${value}; other=1`;
    expect(readCartFromCookieHeader(header)).toEqual([{ variantId: "v-9", qty: 4 }]);
  });

  it("returns an empty cart when the header has no cart cookie", () => {
    expect(readCartFromCookieHeader("ms_session=abc; other=1")).toEqual([]);
    expect(readCartFromCookieHeader(null)).toEqual([]);
  });

  it("does not confuse a cookie whose name merely ends with the cart name", () => {
    const value = encodeCartCookie([{ variantId: "real", qty: 1 }]);
    const header = `not_ms_cart=deadbeef; ${CART_COOKIE_NAME}=${value}`;
    expect(readCartFromCookieHeader(header)).toEqual([{ variantId: "real", qty: 1 }]);
  });
});
