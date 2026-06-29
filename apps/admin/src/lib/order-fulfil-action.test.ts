import { describe, it, expect } from "vitest";
import { nextFulfilAction } from "./order-fulfil-action.js";

describe("nextFulfilAction", () => {
  const base = { channel: "online", deliveryState: "Lagos", deliveryFeeNgn: 1500 };

  it("unproduced preorder → produce", () => {
    expect(nextFulfilAction({ ...base, status: "paid", isPreorder: true, producedAt: null }))
      .toEqual({ kind: "produce", label: "Fulfil & produce" });
  });
  it("produced delivery preorder at paid → advance (out for delivery)", () => {
    expect(nextFulfilAction({ ...base, status: "paid", isPreorder: true, producedAt: "2026-06-29T10:00:00Z" }))
      .toEqual({ kind: "advance", label: "Mark out for delivery" });
  });
  it("non-preorder paid delivery order → advance", () => {
    expect(nextFulfilAction({ ...base, status: "paid", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "advance", label: "Mark out for delivery" });
  });
  it("paid pickup order → advance (hand over)", () => {
    expect(nextFulfilAction({ channel: "online", status: "paid", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "advance", label: "Mark ready for pickup" });
  });
  it("out_for_delivery → advance (mark delivered)", () => {
    expect(nextFulfilAction({ ...base, status: "out_for_delivery", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "advance", label: "Mark delivered" });
  });
  it("delivered → none", () => {
    expect(nextFulfilAction({ ...base, status: "delivered", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "none", label: "" });
  });
});
