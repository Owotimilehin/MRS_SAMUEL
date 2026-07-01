import { describe, it, expect } from "vitest";
import { deriveOrderActions } from "./order-actions.js";

const del = { channel: "online", deliveryState: "Lagos", deliveryFeeNgn: 1500 };
const pickup = { channel: "online", deliveryFeeNgn: 0 };

describe("deriveOrderActions — primary CTA priority", () => {
  it("confirmed (unsettled) → primary Re-check, accept as secondary, cancel in danger", () => {
    const a = deriveOrderActions({ ...del, status: "confirmed" });
    expect(a.primary).toEqual({ id: "recheck_payment", label: "↻ Re-check payment" });
    expect(a.secondary).toContainEqual({ id: "accept_paid", label: "Accept as paid" });
    expect(a.danger).toContainEqual({ id: "cancel_refund", label: "Cancel & mark refund owed" });
  });

  it("reconcile_needed → primary Re-check", () => {
    expect(deriveOrderActions({ ...del, status: "reconcile_needed" }).primary?.id).toBe("recheck_payment");
  });

  it("failed ride outranks fulfilment → primary Re-book", () => {
    const a = deriveOrderActions({ ...del, status: "paid", delivery: { status: "failed" } });
    expect(a.primary).toEqual({ id: "rebook_rider", label: "↻ Re-book rider" });
  });

  it("cancelled ride (order not delivered) → primary Re-book", () => {
    expect(deriveOrderActions({ ...del, status: "out_for_delivery", delivery: { status: "cancelled" } }).primary?.id)
      .toBe("rebook_rider");
  });

  it("unproduced preorder at paid → primary Produce", () => {
    expect(deriveOrderActions({ ...del, status: "paid", isPreorder: true, producedAt: null }).primary)
      .toEqual({ id: "produce", label: "Fulfil & produce" });
  });

  it("paid delivery order, no ride → primary Book rider, manual advance as secondary", () => {
    const a = deriveOrderActions({ ...del, status: "paid" });
    expect(a.primary).toEqual({ id: "book_rider", label: "Book rider" });
    expect(a.secondary).toContainEqual({ id: "advance", label: "Mark out for delivery" });
  });

  it("paid pickup order → primary Mark ready for pickup", () => {
    expect(deriveOrderActions({ ...pickup, status: "paid" }).primary)
      .toEqual({ id: "advance", label: "Mark ready for pickup" });
  });

  it("paid + live ride → no primary but keeps force-delivered fallback", () => {
    const a = deriveOrderActions({ ...del, status: "paid", delivery: { status: "assigned" } });
    expect(a.primary).toBeNull();
    expect(a.secondary).toContainEqual({ id: "force_delivered", label: "Force delivered (fallback)" });
  });

  it("out_for_delivery, no live ride → primary Mark delivered, force in secondary", () => {
    const a = deriveOrderActions({ ...del, status: "out_for_delivery" });
    expect(a.primary).toEqual({ id: "advance", label: "Mark delivered" });
    expect(a.secondary).toContainEqual({ id: "force_delivered", label: "Force delivered (fallback)" });
  });

  it("handed_over → primary Mark collected", () => {
    expect(deriveOrderActions({ ...pickup, status: "handed_over" }).primary)
      .toEqual({ id: "advance", label: "Mark collected" });
  });

  it("live ride suppresses manual advance (webhook-driven) but keeps force fallback", () => {
    const a = deriveOrderActions({ ...del, status: "out_for_delivery", delivery: { status: "in_transit" } });
    expect(a.primary).toBeNull();
    expect(a.secondary).toContainEqual({ id: "force_delivered", label: "Force delivered (fallback)" });
  });

  it("delivered → terminal, no actions", () => {
    const a = deriveOrderActions({ ...del, status: "delivered" });
    expect(a.primary).toBeNull();
    expect(a.secondary).toEqual([]);
    expect(a.danger).toEqual([]);
  });

  it("cancelled → terminal, no actions", () => {
    const a = deriveOrderActions({ ...del, status: "cancelled" });
    expect(a.primary).toBeNull();
    expect(a.danger).toEqual([]);
  });
});

describe("deriveOrderActions — payment/refund gating", () => {
  it("settled paid order shows NO recheck/accept", () => {
    const a = deriveOrderActions({ ...del, status: "paid" });
    const ids = [a.primary, ...a.secondary].filter(Boolean).map((b) => b!.id);
    expect(ids).not.toContain("recheck_payment");
    expect(ids).not.toContain("accept_paid");
  });

  it("refund owed surfaces Mark refunded regardless of status", () => {
    expect(deriveOrderActions({ ...del, status: "delivered", refundOwedNgn: 4500 }).secondary)
      .toContainEqual({ id: "mark_refunded", label: "Mark refunded" });
  });

  it("cancel & refund NOT available after dispatch", () => {
    expect(deriveOrderActions({ ...del, status: "out_for_delivery" }).danger)
      .not.toContainEqual({ id: "cancel_refund", label: "Cancel & mark refund owed" });
  });
});
