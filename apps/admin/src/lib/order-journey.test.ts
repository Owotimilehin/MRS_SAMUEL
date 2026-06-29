import { describe, expect, it } from "vitest";
import { deriveOrderJourney, isDeliveryOrder, type OrderJourneyInput } from "./order-journey.js";

/**
 * Unit suite for the order-detail journey model shared by the owner + branch
 * detail pages. Verifies the step states track the server /advance lifecycle for
 * both the delivery and pickup paths, plus the payment-hold / reconcile /
 * cancelled special cases.
 */

function base(over: Partial<OrderJourneyInput>): OrderJourneyInput {
  return {
    status: "paid",
    channel: "online",
    isPreorder: false,
    scheduledDeliveryAt: null,
    deliveryState: null,
    deliveryAddressFormatted: null,
    deliveryFeeNgn: 0,
    delivery: null,
    ...over,
  };
}

function stateOf(j: ReturnType<typeof deriveOrderJourney>, key: string): string | undefined {
  return j.steps.find((s) => s.key === key)?.state;
}

describe("isDeliveryOrder", () => {
  it("is a delivery order when any delivery signal is present", () => {
    expect(isDeliveryOrder(base({ deliveryState: "Lagos" }))).toBe(true);
    expect(isDeliveryOrder(base({ deliveryAddressFormatted: "12 Adeola Odeku" }))).toBe(true);
    expect(isDeliveryOrder(base({ deliveryFeeNgn: 1500 }))).toBe(true);
    expect(isDeliveryOrder(base({ delivery: { status: "assigned" } }))).toBe(true);
  });

  it("is a pickup order when no delivery signal is present", () => {
    expect(isDeliveryOrder(base({}))).toBe(false);
  });
});

describe("deriveOrderJourney — delivery path", () => {
  const del = (over: Partial<OrderJourneyInput>) => base({ deliveryState: "Lagos", ...over });

  it("paid → preparing is the current step", () => {
    const j = deriveOrderJourney(del({ status: "paid" }));
    expect(j.track).toBe("delivery");
    expect(stateOf(j, "placed")).toBe("done");
    expect(stateOf(j, "paid")).toBe("done");
    expect(stateOf(j, "mid")).toBe("current");
    expect(stateOf(j, "dispatched")).toBe("upcoming");
    expect(j.currentLabel).toBe("Preparing");
  });

  it("out_for_delivery marks preparing done and dispatch current", () => {
    const j = deriveOrderJourney(del({ status: "out_for_delivery" }));
    expect(stateOf(j, "mid")).toBe("done");
    expect(stateOf(j, "dispatched")).toBe("current");
    expect(stateOf(j, "done")).toBe("upcoming");
    expect(j.currentLabel).toBe("Out for delivery");
  });

  it("delivered marks every step done", () => {
    const j = deriveOrderJourney(del({ status: "delivered" }));
    expect(j.steps.every((s) => s.state === "done")).toBe(true);
    expect(j.currentLabel).toBe("Delivered");
  });

  it("scheduled orders relabel the middle step", () => {
    const j = deriveOrderJourney(del({ status: "paid", scheduledDeliveryAt: "2026-06-30T08:00:00Z" }));
    expect(j.steps.find((s) => s.key === "mid")?.label).toBe("Scheduled");
  });

  it("preorders (unscheduled) show In production", () => {
    const j = deriveOrderJourney(del({ status: "paid", isPreorder: true }));
    expect(j.steps.find((s) => s.key === "mid")?.label).toBe("In production");
  });
});

describe("deriveOrderJourney — pickup path", () => {
  it("collapses dispatch + final into ready → collected", () => {
    const j = deriveOrderJourney(base({ status: "paid" }));
    expect(j.track).toBe("pickup");
    expect(j.steps.map((s) => s.key)).toEqual(["placed", "paid", "mid", "done"]);
    expect(j.steps.find((s) => s.key === "mid")?.label).toBe("Ready for pickup");
    expect(j.steps.find((s) => s.key === "done")?.label).toBe("Collected");
  });

  it("handed_over marks ready done and collected current", () => {
    const j = deriveOrderJourney(base({ status: "handed_over" }));
    expect(stateOf(j, "mid")).toBe("done");
    expect(stateOf(j, "done")).toBe("current");
    expect(j.currentLabel).toBe("Collected");
  });
});

describe("deriveOrderJourney — special cases", () => {
  it("confirmed is a payment hold with paid not yet done", () => {
    const j = deriveOrderJourney(base({ status: "confirmed", deliveryState: "Lagos" }));
    expect(j.special).toBe("payment_hold");
    expect(stateOf(j, "paid")).toBe("current");
    expect(j.currentLabel).toBe("Awaiting payment");
  });

  it("reconcile_needed flags review", () => {
    const j = deriveOrderJourney(base({ status: "reconcile_needed", deliveryState: "Lagos" }));
    expect(j.special).toBe("reconcile");
    expect(stateOf(j, "paid")).toBe("current");
    expect(j.currentLabel).toBe("Payment needs review");
  });

  it("cancelled assigns no current step", () => {
    const j = deriveOrderJourney(base({ status: "cancelled", deliveryState: "Lagos" }));
    expect(j.special).toBe("cancelled");
    expect(j.steps.some((s) => s.state === "current")).toBe(false);
    expect(j.currentLabel).toBe("Cancelled");
  });
});
