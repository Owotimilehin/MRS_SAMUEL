import { describe, it, expect } from "vitest";
import {
  parseCheckoutForm,
  parseCartItemsFromForm,
  checkoutFormErrors,
  buildPlaceOrderBody,
  stableIdempotencyKey,
  validNgPhone,
} from "./checkout-post";

describe("validNgPhone", () => {
  it("accepts 0-prefixed and +234 numbers, ignoring spaces/dashes", () => {
    expect(validNgPhone("08012345678")).toBe(true);
    expect(validNgPhone("0801 234 5678")).toBe(true);
    expect(validNgPhone("+2348012345678")).toBe(true);
  });
  it("rejects short or non-numeric input", () => {
    expect(validNgPhone("123")).toBe(false);
    expect(validNgPhone("hello")).toBe(false);
    expect(validNgPhone("")).toBe(false);
  });
});

describe("parseCheckoutForm", () => {
  it("reads and trims fields from URLSearchParams", () => {
    const p = new URLSearchParams();
    p.set("name", "  Ada  ");
    p.set("phone", " 08012345678 ");
    p.set("address", " 12 Allen Ave ");
    p.set("email", " a@b.com ");
    const v = parseCheckoutForm(p);
    expect(v).toMatchObject({ name: "Ada", phone: "08012345678", address: "12 Allen Ave", email: "a@b.com" });
  });
  it("defaults state to Lagos when absent", () => {
    expect(parseCheckoutForm(new URLSearchParams()).state).toBe("Lagos");
  });
});

describe("parseCartItemsFromForm", () => {
  const form = (...items: string[]): URLSearchParams => {
    const p = new URLSearchParams();
    for (const i of items) p.append("item", i);
    return p;
  };

  it("reads the basket from repeated hidden inputs", () => {
    expect(parseCartItemsFromForm(form("v-1:2", "v-2:1"))).toEqual([
      { variantId: "v-1", qty: 2 },
      { variantId: "v-2", qty: 1 },
    ]);
  });

  it("keeps uuids intact by splitting on the LAST colon", () => {
    const id = "3f1a-9c2b:odd";
    expect(parseCartItemsFromForm(form(`${id}:4`))).toEqual([{ variantId: id, qty: 4 }]);
  });

  it("drops malformed, zero and negative quantities", () => {
    expect(parseCartItemsFromForm(form("v-1:0", "v-2:-3", "v-3:abc", "nocolon", ":5"))).toEqual([]);
  });

  it("clamps an absurd quantity", () => {
    expect(parseCartItemsFromForm(form("v-1:100000"))[0]?.qty).toBe(99);
  });

  it("returns empty when the form carries no items", () => {
    expect(parseCartItemsFromForm(new URLSearchParams())).toEqual([]);
  });
});

/**
 * The whole point: a double-tap on a slow connection must not create a second
 * order. Same content ⇒ same key ⇒ the API collapses the retry.
 */
describe("stableIdempotencyKey", () => {
  const values = {
    name: "Ada", phone: "0801 234 5678", email: "", altPhone: "",
    address: "12 Allen Ave", state: "Lagos", notes: "",
  };
  const cart = [{ variantId: "v-1", qty: 2 }];
  const at = new Date("2026-08-18T10:00:00Z");

  it("is identical for a repeated submit of the same order", () => {
    expect(stableIdempotencyKey(values, cart, at)).toBe(stableIdempotencyKey(values, cart, at));
  });

  it("ignores basket ordering and phone formatting", () => {
    const a = stableIdempotencyKey(values, [{ variantId: "a", qty: 1 }, { variantId: "b", qty: 2 }], at);
    const b = stableIdempotencyKey(
      { ...values, phone: "08012345678" },
      [{ variantId: "b", qty: 2 }, { variantId: "a", qty: 1 }],
      at,
    );
    expect(a).toBe(b);
  });

  it("differs when the basket changes", () => {
    expect(stableIdempotencyKey(values, cart, at)).not.toBe(
      stableIdempotencyKey(values, [{ variantId: "v-1", qty: 3 }], at),
    );
  });

  it("differs for a different customer", () => {
    expect(stableIdempotencyKey(values, cart, at)).not.toBe(
      stableIdempotencyKey({ ...values, phone: "08099999999" }, cart, at),
    );
  });

  it("lets the same basket be ordered again in a later hour", () => {
    const later = new Date("2026-08-18T12:00:00Z");
    expect(stableIdempotencyKey(values, cart, at)).not.toBe(
      stableIdempotencyKey(values, cart, later),
    );
  });

  it("is uuid-shaped", () => {
    expect(stableIdempotencyKey(values, cart, at)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("checkoutFormErrors", () => {
  const base = { name: "Ada", phone: "08012345678", email: "", altPhone: "", address: "12 Allen Ave", state: "Lagos", notes: "" };
  it("passes a complete form", () => {
    expect(checkoutFormErrors(base)).toEqual([]);
  });
  it("flags each missing/invalid required field", () => {
    expect(checkoutFormErrors({ ...base, name: "" })).toContain("your full name");
    expect(checkoutFormErrors({ ...base, phone: "123" })).toContain("a valid phone number");
    expect(checkoutFormErrors({ ...base, address: "" })).toContain("your delivery address");
  });
});

describe("buildPlaceOrderBody", () => {
  const values = { name: "Ada", phone: "0801 234 5678", email: "a@b.com", altPhone: "0700-000-0000", address: "12 Allen", state: "Lagos", notes: "gate code 5" };

  it("builds the API body with normalised phone and cart items", () => {
    const body = buildPlaceOrderBody(values, "branch-1", [
      { variantId: "v-1", qty: 2 },
      { variantId: "v-2", qty: 1 },
    ]);
    expect(body).toEqual({
      branch_id: "branch-1",
      delivery_fee_ngn: 0,
      delivery_state: "Lagos",
      customer: {
        name: "Ada",
        phone: "08012345678",
        email: "a@b.com",
        alt_phone: "07000000000",
        address: "12 Allen",
      },
      items: [
        { variant_id: "v-1", quantity: 2 },
        { variant_id: "v-2", quantity: 1 },
      ],
      notes: "gate code 5",
    });
  });

  it("omits optional email/alt_phone/notes when empty", () => {
    const body = buildPlaceOrderBody(
      { ...values, email: "", altPhone: "", notes: "" },
      "b",
      [{ variantId: "v", qty: 1 }],
    );
    expect(body.customer).not.toHaveProperty("email");
    expect(body.customer).not.toHaveProperty("alt_phone");
    expect(body).not.toHaveProperty("notes");
  });

  it("never carries a price — only variant id + quantity reach the API", () => {
    const body = buildPlaceOrderBody(values, "b", [{ variantId: "v", qty: 3 }]);
    expect(JSON.stringify(body)).not.toMatch(/price|ngn.*[1-9]/i.source);
    expect(body.items[0]).toEqual({ variant_id: "v", quantity: 3 });
  });
});
