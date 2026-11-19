import { describe, it, expect } from "vitest";
import {
  ADDRESS_QUESTION_TEXT,
  ORDER_TEMPLATE_TEXT,
  cartLineLabel,
  cartLinesText,
  cartReceivedText,
  cartSubtotalNgn,
  formatNaira,
  fulfilmentQuestionBody,
  greetingName,
  orderUpdateParams,
  orderUpdateTemplateFor,
  paymentMessageBody,
  paymentMessagePreview,
  renderOrderTemplate,
  type CartTextLine,
} from "./catalogue.js";

const line = (over: Partial<CartTextLine> = {}): CartTextLine => ({
  name: "Pineapple Ginger",
  sizeMl: 330,
  quantity: 2,
  lineTotalNgn: 3000,
  sellable: true,
  ...over,
});

describe("cart wording", () => {
  it("formats naira and a line the way the customer sees it", () => {
    expect(formatNaira(4500)).toBe("₦4,500");
    expect(cartLineLabel(line())).toBe("2 × Pineapple Ginger 330ml — ₦3,000");
    expect(cartLineLabel(line({ sellable: false, lineTotalNgn: null }))).toBe("Pineapple Ginger 330ml — no longer available");
  });

  it("lists at most 12 lines and says how many more", () => {
    const many = Array.from({ length: 15 }, (_, i) => line({ name: `Juice ${i + 1}` }));
    const text = cartLinesText(many).split("\n");
    expect(text).toHaveLength(13);
    expect(text[0]).toBe("• 2 × Juice 1 330ml — ₦3,000");
    expect(text[12]).toBe("…and 3 more");
  });

  it("the subtotal counts only what can still be sold", () => {
    expect(cartSubtotalNgn([line(), line({ sellable: false, lineTotalNgn: null }), line({ lineTotalNgn: 1500, quantity: 1 })])).toBe(4500);
  });

  it("the delivery-or-pickup question shows shop prices and the subtotal", () => {
    expect(fulfilmentQuestionBody([line()])).toBe(
      "Thank you! We have your cart:\n• 2 × Pineapple Ginger 330ml — ₦3,000\nSubtotal: ₦3,000\n\nHow would you like to get your order?",
    );
  });

  it("the address question and the thank-you read as written", () => {
    expect(ADDRESS_QUESTION_TEXT).toBe("Please type your full delivery address in one message: house number, street, area and city.");
    expect(cartReceivedText("delivery", null)).toBe(
      "Thank you. A member of our team will confirm your order and send your payment link shortly.",
    );
    expect(cartReceivedText("pickup", { name: "Lekki Branch", address: "1 Admiralty Way" })).toBe(
      "Thank you. You can collect from Lekki Branch, 1 Admiralty Way. A member of our team will confirm your order and send your payment link shortly.",
    );
  });

  it("the payment message names the order, the lines, delivery or pickup, and the total", () => {
    expect(
      paymentMessageBody({ orderNumber: "SO-2026-00042", lines: [line()], fulfilment: "delivery", deliveryFeeNgn: 500, branchName: "Lekki Branch", totalNgn: 3500 }),
    ).toBe(
      "Your order SO-2026-00042 is ready.\n• 2 × Pineapple Ginger 330ml — ₦3,000\nDelivery: ₦500\nTotal: ₦3,500\n\n" +
        "Tap Pay now to pay safely with OPay. The link works for 30 minutes. If it stops working, tell us and we will send a new one.",
    );
    expect(
      paymentMessageBody({ orderNumber: "SO-2026-00042", lines: [line()], fulfilment: "pickup", deliveryFeeNgn: 0, branchName: "Lekki Branch", totalNgn: 3000 }),
    ).toContain("\nPickup at Lekki Branch\nTotal: ₦3,000\n");
    expect(paymentMessagePreview("SO-2026-00042", 3500)).toBe("Sent payment link for SO-2026-00042 (₦3,500)");
  });
});

describe("order updates", () => {
  it("only paid, out for delivery and delivered have a message", () => {
    expect(orderUpdateTemplateFor("paid")).toBe("order_paid");
    expect(orderUpdateTemplateFor("out_for_delivery")).toBe("order_out_for_delivery");
    expect(orderUpdateTemplateFor("delivered")).toBe("order_delivered");
    for (const s of ["confirmed", "handed_over", "cancelled", "failed", "reconcile_needed", "draft"]) {
      expect(orderUpdateTemplateFor(s)).toBeNull();
    }
  });

  it("fills the blanks in order", () => {
    const o = { firstName: "Ada", orderNumber: "SO-2026-00042", totalNgn: 3500, paymentLink: "https://pay.example.com/x" };
    expect(orderUpdateParams("order_confirmed", o)).toEqual(["Ada", "SO-2026-00042", "₦3,500", "https://pay.example.com/x"]);
    expect(orderUpdateParams("order_paid", o)).toEqual(["Ada", "SO-2026-00042", "₦3,500"]);
    expect(orderUpdateParams("order_delivered", o)).toEqual(["Ada", "SO-2026-00042"]);
    expect(renderOrderTemplate("order_paid", orderUpdateParams("order_paid", o))).toBe(
      "Thank you Ada. We have received your payment of ₦3,500 for order SO-2026-00042. We are preparing it now.",
    );
    // Every blank a template has is one we fill.
    for (const [name, text] of Object.entries(ORDER_TEMPLATE_TEXT)) {
      const blanks = new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]));
      expect(blanks.size).toBe(orderUpdateParams(name as keyof typeof ORDER_TEMPLATE_TEXT, o).length);
    }
  });

  it("greets by first name, or 'there'", () => {
    expect(greetingName("Ada Obi")).toBe("Ada");
    expect(greetingName("  ")).toBe("there");
    expect(greetingName(null)).toBe("there");
    expect(greetingName("+2348012345678")).toBe("there");
  });
});
