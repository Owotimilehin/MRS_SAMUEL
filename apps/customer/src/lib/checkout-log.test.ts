import { describe, it, expect } from "vitest";
import { buildCheckoutLogPayload } from "./checkout-log";

const base = {
  attemptId: "att-1",
  form: { name: "Ada", phone: "0800 000 0000", email: "", address: "1 Main", state: "Lagos" },
  items: [{ variantId: "v1", name: "Mango", size: "650ml", qty: 2 }],
  total: 5000,
  deliveryWindow: "afternoon",
};

describe("buildCheckoutLogPayload", () => {
  it("includes normalised delivery details + items for a press", () => {
    const p = buildCheckoutLogPayload({ ...base, stage: "pressed" });
    expect(p.attempt_id).toBe("att-1");
    expect(p.stage).toBe("pressed");
    expect(p.customer).toEqual({
      name: "Ada",
      phone: "08000000000", // spaces stripped
      email: undefined,
      address: "1 Main",
      state: "Lagos",
    });
    expect(p.items).toEqual([{ variant_id: "v1", name: "Mango", size: "650ml", qty: 2 }]);
    expect(p.total_ngn).toBe(5000);
    expect(p.delivery_window).toBe("afternoon");
  });

  it("carries an error message and order number when given", () => {
    const p = buildCheckoutLogPayload({
      ...base,
      stage: "payment_failed",
      errorMessage: "popup blocked",
      orderNumber: "SO-1",
    });
    expect(p.stage).toBe("payment_failed");
    expect(p.error_message).toBe("popup blocked");
    expect(p.order_number).toBe("SO-1");
  });

  it("omits empty optional customer fields", () => {
    const p = buildCheckoutLogPayload({
      ...base,
      form: { name: "", phone: "", email: "", address: "", state: "Lagos" },
      stage: "validation_failed",
    });
    expect(p.customer).toEqual({
      name: undefined,
      phone: undefined,
      email: undefined,
      address: undefined,
      state: "Lagos",
    });
  });
});
