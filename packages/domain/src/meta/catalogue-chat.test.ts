import { describe, it, expect } from "vitest";
import type { DbClient } from "@ms/db";
import {
  askClaimAfter,
  askOutcomeOf,
  cartTextLines,
  claimAsk,
  parseOrderMessage,
  switchOrderUpdatesOn,
  type AskOutcome,
  type PricedLine,
} from "./catalogue-chat.js";

const V1 = "v-3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const V2 = "v-9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

describe("parseOrderMessage", () => {
  it("parseOrderMessage reads lines, note and catalog id; tolerates decimal item_price and missing fields", () => {
    const parsed = parseOrderMessage({
      from: "2348012345678",
      id: "wamid.cart1",
      type: "order",
      order: {
        catalog_id: "123456789012345",
        text: "  Please add straws  ",
        product_items: [
          { product_retailer_id: V1, quantity: 2, item_price: 1500, currency: "NGN" },
          // Meta documents an integer price but its own example is 7.99.
          { product_retailer_id: V2, quantity: 1, item_price: 7.99, currency: "USD" },
          // Missing quantity, price and currency.
          { product_retailer_id: "SKU-OTHER" },
          // No id at all: not a line.
          { quantity: 4, item_price: 100 },
        ],
      },
    });
    expect(parsed).toEqual({
      catalogId: "123456789012345",
      note: "Please add straws",
      lines: [
        { product_retailer_id: V1, quantity: 2, item_price: 1500, currency: "NGN" },
        { product_retailer_id: V2, quantity: 1, item_price: 7.99, currency: "USD" },
        { product_retailer_id: "SKU-OTHER", quantity: 1, item_price: null, currency: null },
      ],
    });
  });

  it("keeps quantities to whole units between 1 and 99", () => {
    const lines = parseOrderMessage({
      id: "c",
      type: "order",
      order: {
        product_items: [
          { product_retailer_id: "a", quantity: 250 },
          { product_retailer_id: "b", quantity: 2.9 },
          { product_retailer_id: "c", quantity: 0 },
          { product_retailer_id: "d", quantity: -3 },
          { product_retailer_id: "e", quantity: "7" as unknown as number },
        ],
      },
    })!.lines;
    expect(lines.map((l) => l.quantity)).toEqual([99, 2, 1, 1, 7]);
  });

  it("is null for other messages and for a cart with no usable line", () => {
    expect(parseOrderMessage({ id: "t", type: "text", text: { body: "hi" } })).toBeNull();
    expect(parseOrderMessage({ id: "o", type: "order" })).toBeNull();
    expect(parseOrderMessage({ id: "o", type: "order", order: { catalog_id: "1", product_items: [] } })).toBeNull();
    expect(parseOrderMessage({ id: "o", type: "order", order: { product_items: [{ quantity: 2 }] } })).toBeNull();
    const noNote = parseOrderMessage({ id: "o", type: "order", order: { product_items: [{ product_retailer_id: "a", quantity: 1 }] } });
    expect(noNote).toMatchObject({ catalogId: null, note: null });
  });
});

describe("cartTextLines", () => {
  it("carries the shop's name, size and line total, never Meta's price", () => {
    const priced: PricedLine = {
      retailerId: V1,
      variantId: V1.slice(2),
      name: "Pineapple Ginger",
      sizeMl: 330,
      quantity: 2,
      shopPriceNgn: 1500,
      lineTotalNgn: 3000,
      metaPrice: 1,
      priceDiffers: true,
      sellable: true,
      inStock: true,
    };
    expect(cartTextLines([priced])).toEqual([{ name: "Pineapple Ginger", sizeMl: 330, quantity: 2, lineTotalNgn: 3000, sellable: true }]);
  });
});

/**
 * A stand-in for the database that records each UPDATE: what it set and
 * whether it joined another table (the baseline does). `answer` is what an
 * UPDATE without a join returns.
 */
function fakeDb(answer: unknown[]) {
  const updates: { set: Record<string, unknown>; joined: boolean }[] = [];
  const update = () => {
    const u = { set: {} as Record<string, unknown>, joined: false };
    updates.push(u);
    const b = {
      set: (s: Record<string, unknown>) => ((u.set = s), b),
      from: () => ((u.joined = true), b),
      where: () => b,
      returning: async () => (u.joined ? [{ id: "cart-1" }] : answer),
    };
    return b;
  };
  const tx = { update };
  const db = { update, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as DbClient;
  return { db, updates };
}

describe("order updates never announce a status from before the switch-on", () => {
  it("off → on stamps the moment and marks placed orders as told, in one go", async () => {
    const { db, updates } = fakeDb([{ id: "link-1" }]);
    expect(await switchOrderUpdatesOn(db, "link-1")).toBe(true);
    expect(updates).toHaveLength(2);
    expect(updates[0]!.set).toMatchObject({ orderUpdatesEnabled: true });
    expect(updates[0]!.set).toHaveProperty("orderUpdatesEnabledAt");
    // The baseline: last_notified_status := the order's current status, and no message.
    expect(updates[1]!.joined).toBe(true);
    expect(updates[1]!.set).toHaveProperty("lastNotifiedStatus");
    expect(updates[1]!.set).toMatchObject({ notifyAttempts: 0 });
  });

  it("when they are already on, nothing is re-stamped and no update still due is swallowed", async () => {
    const { db, updates } = fakeDb([]);
    expect(await switchOrderUpdatesOn(db, "link-1")).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates.some((u) => u.joined)).toBe(false);
  });
});

describe('"delivery or pickup?" is asked once', () => {
  it("reads a returned message as sent, refused or no answer", () => {
    expect(askOutcomeOf({ status: "sent", payload: null })).toBe("sent");
    expect(askOutcomeOf({ status: "failed", payload: { error: "x" } })).toBe("refused");
    expect(askOutcomeOf({ status: "failed", payload: { unconfirmed: true } })).toBe("no_answer");
  });

  it("gives the claim back only when the question certainly did not reach the customer", () => {
    const table: [AskOutcome, "keep" | "release"][] = [
      ["sent", "keep"],
      ["no_answer", "keep"],
      ["error", "keep"],
      ["refused", "release"],
      ["not_sent", "release"],
    ];
    for (const [outcome, want] of table) expect(askClaimAfter(outcome)).toBe(want);
  });

  it("claimAsk returns the claim's time, or null when someone already holds it", async () => {
    const at = new Date("2026-11-22T10:00:00Z");
    expect(await claimAsk(fakeDb([{ at }]).db, "cart-1", at)).toEqual(at);
    expect(await claimAsk(fakeDb([]).db, "cart-1", at)).toBeNull();
  });
});
