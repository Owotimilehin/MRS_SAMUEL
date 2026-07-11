/* eslint-disable @typescript-eslint/no-explicit-any -- fakeTx is a loose
   stand-in for Drizzle's transaction handle; typing it precisely would mean
   re-deriving Drizzle's generic query-builder types for no test value. */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Payaza verify call so verifyAndReconcile can be driven without HTTP.
// isPayazaSuccess keeps its real (trivial) behaviour.
const mockVerify = vi.fn();
vi.mock("../../src/payments/payaza.js", () => ({
  verifyPayazaTransaction: (...args: unknown[]) => mockVerify(...args),
  isPayazaSuccess: (status: string) => status.toLowerCase() === "completed",
}));

import { applyPayazaConfirmation, verifyAndReconcile, applyOfflinePayment } from "../../src/payments/reconcile.js";
import { saleOrder, saleOrderItem, stockLedger, stockReservation, payment, outboxEvent } from "@ms/db";

// Minimal fake tx: records inserts/updates and returns a seeded order. select()
// is table-aware so the item-loop in applyPayazaConfirmation gets one fake item
// when querying saleOrderItem, the seeded order when querying saleOrder, and an
// empty array for anything else.
//
// `casWins` controls what the status-flip UPDATE's `.returning()` resolves to:
// defaulting to a winning CAS (`[{ id: "o1" }]`) so existing happy-path tests
// don't need to change. Pass `casWins: false` to simulate a concurrent caller
// having already won the race (`.returning()` -> `[]`).
function fakeTx(order: any, opts?: { casWins?: boolean; existingCancelAlert?: boolean }) {
  const casWins = opts?.casWins ?? true;
  const calls: any = { inserts: [], updates: [], deletes: [] };
  const tx = {
    select: () => ({
      from: (t: any) => ({
        where: () => {
          const rows =
            t === saleOrder
              ? order
                ? [order]
                : []
              : t === saleOrderItem
                ? [{ productId: "p1", variantId: null, quantity: 1 }]
                : t === outboxEvent
                  ? opts?.existingCancelAlert
                    ? [{ id: "existing-alert" }]
                    : []
                  : [];
          // Promise-like so both `await where()` and `where().limit(n)` work.
          const p: any = Promise.resolve(rows);
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
    insert: (t: any) => ({
      values: (v: any) => {
        calls.inserts.push({ t, v });
        return Promise.resolve();
      },
    }),
    update: (t: any) => ({
      set: (v: any) => ({
        where: () => {
          calls.updates.push({ t, v });
          return {
            returning: (_sel?: any) =>
              Promise.resolve(casWins ? [{ id: "o1" }] : []),
          };
        },
      }),
    }),
    delete: (t: any) => ({
      where: () => {
        calls.deletes.push({ t });
        return Promise.resolve();
      },
    }),
  };
  return { tx, calls };
}
const baseOrder = {
  id: "o1", orderNumber: "SO-1", status: "confirmed", totalNgn: 3500,
  isPreorder: false, branchId: "b1", customerId: "c1",
  scheduledDeliveryAt: null, deliveryState: "Lagos",
};

function status(over: Partial<{ amountNgn: number | null; feeNgn: number | null; netNgn: number | null }>) {
  return {
    status: "Completed",
    amountNgn: 3600,
    feeNgn: 100,
    netNgn: 3500,
    processorReference: "P-1",
    authorization: null,
    raw: { data: { amount_received: 3600, fee: 100 } },
    ...over,
  } as const;
}

describe("applyPayazaConfirmation", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("no-ops when the order is already paid", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder, status: "paid" } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
    );
    expect(r).toEqual({ kind: "already_processed", status: "paid" });
    expect(calls.updates).toHaveLength(0);
  });

  it("alerts the owner when a SUCCESS payment lands on a CANCELLED order", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder, status: "cancelled" } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
    );
    expect(r).toEqual({ kind: "already_processed", status: "cancelled" });
    // Emits a refund-alert outbox event, and never moves money/stock.
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.paid_after_cancel")).toBe(true);
    expect(calls.updates).toHaveLength(0);
  });

  it("does NOT re-alert when a paid-after-cancel event already exists (dedupe)", async () => {
    const { tx, calls } = fakeTx(null, { existingCancelAlert: true });
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder, status: "cancelled" } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
    );
    expect(r).toEqual({ kind: "already_processed", status: "cancelled" });
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.paid_after_cancel")).toBe(false);
  });

  it("parks underpaid when NET is below the product total", async () => {
    const { tx, calls } = fakeTx(null);
    // Customer paid 3400 gross, fee 100 -> net 3300 < total 3500.
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3400, feeNgn: 100, netNgn: 3300 }),
    );
    expect(r).toEqual({ kind: "underpaid", totalNgn: 3500, netNgn: 3300, shortfallNgn: 200 });
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.fee_shortfall")).toBe(true);
    // Order flagged reconcile_needed with the shortfall recorded.
    expect(calls.updates.some((u: any) => u.v.status === "reconcile_needed" && u.v.feeShortfallNgn === 200)).toBe(true);
  });

  it("marks PAID when NET meets the product total even though gross is fee-inclusive", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3600, feeNgn: 100, netNgn: 3500 }),
    );
    expect(r.kind).toBe("paid");
    // ANALYTICS BOUNDARY: revenue figure (amount_ngn) is the product total, NOT the gross.
    expect(
      calls.inserts.some(
        (i: any) => i.t === payment && i.v.status === "paid" && i.v.amountNgn === 3500 && i.v.grossNgn === 3600 && i.v.feeNgn === 100 && i.v.netNgn === 3500,
      ),
    ).toBe(true);
  });

  it("falls back to gross>=total when Payaza reports no fee (net null)", async () => {
    const { tx } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
    );
    expect(r.kind).toBe("paid");
  });

  it("marks an in-stock order paid, ledgers stock, and clears the reservation", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3600, netNgn: 3500 }),
    );
    expect(r.kind).toBe("paid");
    // Payment row recorded for the order total via Payaza.
    expect(
      calls.inserts.some(
        (i: any) =>
          i.t === payment && i.v.status === "paid" && i.v.processor === "payaza" && i.v.amountNgn === 3500,
      ),
    ).toBe(true);
    // Stock actually ledgered OUT for the one fake item (qty 1 -> delta -1).
    expect(
      calls.inserts.some(
        (i: any) => i.t === stockLedger && i.v.delta === -1 && i.v.productId === "p1",
      ),
    ).toBe(true);
    // The held reservation is released.
    expect(calls.deletes.some((d: any) => d.t === stockReservation)).toBe(true);
  });

  it("does NOT ledger stock or delete the reservation for a preorder (prepaid, not yet made)", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder, isPreorder: true } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
    );
    expect(r.kind).toBe("paid");
    // Payment is still captured...
    expect(calls.inserts.some((i: any) => i.t === payment && i.v.status === "paid")).toBe(true);
    // ...but stock is untouched until staff fulfil it from the Preorders queue.
    expect(calls.inserts.some((i: any) => i.t === stockLedger)).toBe(false);
    expect(calls.deletes.some((d: any) => d.t === stockReservation)).toBe(false);
    // And it emits the preorder-specific paid event.
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.preorder_paid")).toBe(true);
  });

  it("accepts the reported amount when acceptReportedAmount=true (override mismatch)", async () => {
    const { tx } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3400, netNgn: 3300 }),
      { acceptReportedAmount: true },
    );
    expect(r.kind).toBe("paid");
  });

  it("loses the CAS to a concurrent winner: returns already_processed and inserts nothing", async () => {
    // Simulates two concurrent reconcile calls (e.g. webhook + cron sweep)
    // racing the same stuck order: this caller's status-flip UPDATE matches
    // zero rows because a concurrent caller already flipped confirmed->paid.
    const { tx, calls } = fakeTx(null, { casWins: false });
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3500, netNgn: 3500 }),
    );
    expect(r).toEqual({ kind: "already_processed", status: "confirmed" });
    expect(calls.inserts).toHaveLength(0);
  });

  it("stamps the payment row with the given processor (opay)", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
      { processor: "opay" },
    );
    expect(r.kind).toBe("paid");
    const paymentRow = calls.inserts.find((i: any) => i.t === payment);
    expect(paymentRow?.v.processor).toBe("opay");
  });
});

describe("verifyAndReconcile heals a stuck reconcile_needed order", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockVerify.mockReset();
  });

  function fakeDb(order: any) {
    const { tx, calls } = fakeTx(order);
    const db = { transaction: (cb: any) => cb(tx) };
    return { db, calls };
  }

  it("re-checks a reconcile_needed order Payaza reports paid in full -> paid", async () => {
    mockVerify.mockResolvedValue(status({ amountNgn: 8600, feeNgn: 100, netNgn: 8500 }));
    const { db, calls } = fakeDb({ ...baseOrder, status: "reconcile_needed", totalNgn: 8500 });
    const r = await verifyAndReconcile(db as any, "SO-1");
    expect(r.kind).toBe("paid");
    // It nudged reconcile_needed -> confirmed, then flipped -> paid.
    expect(calls.updates.some((u: any) => u.v.status === "confirmed")).toBe(true);
    expect(calls.updates.some((u: any) => u.v.status === "paid")).toBe(true);
  });

  it("leaves a reconcile_needed order untouched when Payaza shows no payment", async () => {
    mockVerify.mockResolvedValue({ status: "Pending" });
    const { db, calls } = fakeDb({ ...baseOrder, status: "reconcile_needed", totalNgn: 8500 });
    const r = await verifyAndReconcile(db as any, "SO-1");
    expect(r).toEqual({ kind: "not_completed", payazaStatus: "Pending" });
    // No status writes at all — not auto-cancelled, not nudged.
    expect(calls.updates).toHaveLength(0);
  });
});

describe("applyOfflinePayment (transfer/cash outside Payaza)", () => {
  it("marks a confirmed non-preorder paid via transfer and deducts stock", async () => {
    const { tx, calls } = fakeTx({ ...baseOrder, status: "confirmed", totalNgn: 3500 });
    const r = await applyOfflinePayment(tx as any, { ...baseOrder, status: "confirmed", totalNgn: 3500 } as any, {
      method: "transfer",
      amountNgn: 3500,
      collectedByUserId: "staff-1",
    });
    expect(r.kind).toBe("paid");
    // A manual (NOT payaza) payment row for the transfer.
    expect(
      calls.inserts.some(
        (i: any) =>
          i.t === payment &&
          i.v.status === "paid" &&
          i.v.method === "transfer" &&
          i.v.processor === "manual" &&
          i.v.collectedByUserId === "staff-1",
      ),
    ).toBe(true);
    // Stock ledgered out for the one fake item; reservation released.
    expect(calls.inserts.some((i: any) => i.t === stockLedger && i.v.delta === -1)).toBe(true);
    expect(calls.deletes.some((d: any) => d.t === stockReservation)).toBe(true);
  });

  it("pays a reconcile_needed preorder WITHOUT moving stock", async () => {
    const order = { ...baseOrder, status: "reconcile_needed", isPreorder: true, totalNgn: 8500 };
    const { tx, calls } = fakeTx(order);
    const r = await applyOfflinePayment(tx as any, order as any, {
      method: "transfer",
      amountNgn: 8500,
      collectedByUserId: "staff-1",
    });
    expect(r.kind).toBe("paid");
    expect(calls.inserts.some((i: any) => i.t === payment && i.v.processor === "manual")).toBe(true);
    // Preorder defers stock to fulfilment.
    expect(calls.inserts.some((i: any) => i.t === stockLedger)).toBe(false);
    expect(calls.deletes.some((d: any) => d.t === stockReservation)).toBe(false);
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.preorder_paid")).toBe(true);
  });

  it("is idempotent: an already-paid order records no second payment", async () => {
    const { tx, calls } = fakeTx({ ...baseOrder, status: "paid" });
    const r = await applyOfflinePayment(tx as any, { ...baseOrder, status: "paid" } as any, {
      method: "cash",
      amountNgn: 3500,
      collectedByUserId: "staff-1",
    });
    expect(r).toEqual({ kind: "already_processed", status: "paid" });
    expect(calls.inserts).toHaveLength(0);
  });

  it("loses the CAS to a concurrent winner and inserts nothing", async () => {
    const { tx, calls } = fakeTx({ ...baseOrder, status: "confirmed" }, { casWins: false });
    const r = await applyOfflinePayment(tx as any, { ...baseOrder, status: "confirmed" } as any, {
      method: "cash",
      amountNgn: 3500,
      collectedByUserId: "staff-1",
    });
    expect(r).toEqual({ kind: "already_processed", status: "confirmed" });
    expect(calls.inserts).toHaveLength(0);
  });
});
