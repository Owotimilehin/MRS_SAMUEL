import { describe, it, expect } from "vitest";
import { cartTextLines, parseOrderMessage, type PricedLine } from "./catalogue-chat.js";

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
