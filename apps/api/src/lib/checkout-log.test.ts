import { describe, it, expect } from "vitest";
import { statusForStage, isFailureStage, checkoutLogSchema } from "./checkout-log.js";

describe("statusForStage", () => {
  it("maps each stage to a status", () => {
    expect(statusForStage("pressed")).toBe("info");
    expect(statusForStage("order_created")).toBe("ok");
    expect(statusForStage("payment_paid")).toBe("ok");
    expect(statusForStage("payment_closed")).toBe("abandoned");
    expect(statusForStage("validation_failed")).toBe("error");
    expect(statusForStage("order_failed")).toBe("error");
    expect(statusForStage("payment_failed")).toBe("error");
  });
});

describe("isFailureStage", () => {
  it("is true only for failure stages", () => {
    expect(isFailureStage("validation_failed")).toBe(true);
    expect(isFailureStage("order_failed")).toBe(true);
    expect(isFailureStage("payment_failed")).toBe(true);
    expect(isFailureStage("pressed")).toBe(false);
    expect(isFailureStage("order_created")).toBe(false);
    expect(isFailureStage("payment_paid")).toBe(false);
    expect(isFailureStage("payment_closed")).toBe(false);
  });
});

describe("checkoutLogSchema", () => {
  it("accepts a valid payload", () => {
    const r = checkoutLogSchema.safeParse({
      attempt_id: "abc",
      stage: "pressed",
      customer: { name: "Ada", phone: "08000000000" },
      items: [{ variant_id: "v1", name: "Mango", size: "650ml", qty: 2 }],
      total_ngn: 5000,
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown stage", () => {
    expect(checkoutLogSchema.safeParse({ attempt_id: "a", stage: "nope" }).success).toBe(false);
  });

  it("rejects a missing attempt_id", () => {
    expect(checkoutLogSchema.safeParse({ stage: "pressed" }).success).toBe(false);
  });

  it("rejects oversized error_message", () => {
    expect(
      checkoutLogSchema.safeParse({ attempt_id: "a", stage: "order_failed", error_message: "x".repeat(1001) }).success,
    ).toBe(false);
  });

  it("rejects more than 50 items", () => {
    const items = Array.from({ length: 51 }, () => ({ variant_id: "v", name: "n", size: "650ml", qty: 1 }));
    expect(checkoutLogSchema.safeParse({ attempt_id: "a", stage: "pressed", items }).success).toBe(false);
  });
});
