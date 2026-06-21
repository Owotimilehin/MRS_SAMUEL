import { describe, it, expect } from "vitest";
import { deriveJourney, type TrackingOrderLike } from "./order-journey";

const base: TrackingOrderLike = {
  status: "paid", payment_status: "paid", is_preorder: false,
  scheduled_delivery_at: null, delivery_state: "Lagos",
  paid_at: "2026-06-21T13:00:00Z", out_for_delivery_at: null,
  delivered_at: null, delivery: null,
};

describe("deriveJourney", () => {
  it("live track when a rider exists, in Lagos, immediate", () => {
    const j = deriveJourney({ ...base, delivery: { status: "searching_rider" } });
    expect(j.track).toBe("live");
    expect(j.steps.map((s) => s.key)).toEqual(["placed","paid","preparing","on_the_way","delivered"]);
    expect(j.currentStep.key).toBe("preparing");
    expect(j.methodLabel).toBe("Live rider");
  });

  it("scheduled track when scheduled_delivery_at set", () => {
    const j = deriveJourney({ ...base, scheduled_delivery_at: "2026-06-22T11:00:00Z" });
    expect(j.track).toBe("scheduled");
    expect(j.steps.map((s) => s.key)).toContain("scheduled");
  });

  it("coordinated track when outside Lagos, overriding schedule", () => {
    const j = deriveJourney({ ...base, delivery_state: "Oyo", scheduled_delivery_at: "2026-06-22T11:00:00Z" });
    expect(j.track).toBe("coordinated");
    expect(j.methodLabel).toBe("We'll arrange delivery to Oyo");
  });

  it("payment_hold special when confirmed/unpaid", () => {
    const j = deriveJourney({ ...base, status: "confirmed", payment_status: "pending", paid_at: null });
    expect(j.special).toBe("payment_hold");
    expect(j.steps.find((s) => s.key === "paid")?.state).toBe("current");
  });

  it("reconcile special is calm, not cancelled", () => {
    expect(deriveJourney({ ...base, status: "reconcile_needed" }).special).toBe("reconcile");
  });

  it("cancelled special + track coordinated", () => {
    const j = deriveJourney({ ...base, status: "cancelled" });
    expect(j.special).toBe("cancelled");
    expect(j.track).toBe("coordinated");
  });

  it("cancelled forces coordinated track even with a rider or schedule", () => {
    const j = deriveJourney({ ...base, status: "cancelled", delivery: { status: "in_transit" }, scheduled_delivery_at: "2026-06-22T11:00:00Z" });
    expect(j.track).toBe("coordinated");
    expect(j.special).toBe("cancelled");
  });

  it("out_for_delivery marks the OTW step current and preparing done", () => {
    const j = deriveJourney({ ...base, delivery: { status: "in_transit" }, out_for_delivery_at: "2026-06-21T13:20:00Z" });
    expect(j.steps.find((s) => s.key === "preparing")?.state).toBe("done");
    expect(j.currentStep.key).toBe("on_the_way");
  });

  it("delivered marks all done", () => {
    const j = deriveJourney({ ...base, status: "delivered", delivery: { status: "delivered" }, out_for_delivery_at: "x", delivered_at: "2026-06-21T13:40:00Z" });
    expect(j.steps.every((s) => s.state === "done")).toBe(true);
    expect(j.currentStep.key).toBe("delivered");
  });

  it("preorder relabels the prep step", () => {
    const j = deriveJourney({ ...base, is_preorder: true, delivery: { status: "searching_rider" } });
    expect(j.steps.find((s) => s.key === "preparing")?.label).toBe("In production 🥤");
  });
});
