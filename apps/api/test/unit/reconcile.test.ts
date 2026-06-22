/* eslint-disable @typescript-eslint/no-explicit-any -- fakeTx is a loose
   stand-in for Drizzle's transaction handle; typing it precisely would mean
   re-deriving Drizzle's generic query-builder types for no test value. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyPayazaConfirmation } from "../../src/payments/reconcile.js";
import { saleOrder, saleOrderItem } from "@ms/db";

// Minimal fake tx: records inserts/updates and returns a seeded order. select()
// is table-aware so the item-loop in applyPayazaConfirmation gets one fake item
// when querying saleOrderItem, the seeded order when querying saleOrder, and an
// empty array for anything else.
//
// `casWins` controls what the status-flip UPDATE's `.returning()` resolves to:
// defaulting to a winning CAS (`[{ id: "o1" }]`) so existing happy-path tests
// don't need to change. Pass `casWins: false` to simulate a concurrent caller
// having already won the race (`.returning()` -> `[]`).
function fakeTx(order: any, opts?: { casWins?: boolean }) {
  const casWins = opts?.casWins ?? true;
  const calls: any = { inserts: [], updates: [], deletes: [] };
  const tx = {
    select: () => ({
      from: (t: any) => ({
        where: () => {
          if (t === saleOrder) return Promise.resolve(order ? [order] : []);
          if (t === saleOrderItem) {
            return Promise.resolve([{ productId: "p1", variantId: null, quantity: 1 }]);
          }
          return Promise.resolve([]);
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

describe("applyPayazaConfirmation", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("no-ops when the order is already paid", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder, status: "paid" } as any,
      { status: "Completed", amountNgn: 3500, processorReference: "P-1", authorization: null },
    );
    expect(r).toEqual({ kind: "already_processed", status: "paid" });
    expect(calls.updates).toHaveLength(0);
  });

  it("parks reconcile_needed when the amount differs", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      { status: "Completed", amountNgn: 3000, processorReference: "P-1", authorization: null },
    );
    expect(r).toEqual({ kind: "amount_mismatch", expectedNgn: 3500, reportedNgn: 3000 });
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.amount_mismatch")).toBe(true);
  });

  it("marks an in-stock order paid and ledgers stock", async () => {
    const { tx, calls } = fakeTx(null);
    // one item returned by the item select — extend fakeTx select to vary by table if needed
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      { status: "Completed", amountNgn: 3500, processorReference: "P-1", authorization: null },
    );
    expect(r.kind).toBe("paid");
    expect(calls.inserts.some((i: any) => i.v.status === "paid" && i.v.processor === "payaza")).toBe(true);
  });

  it("accepts the reported amount when acceptReportedAmount=true (override mismatch)", async () => {
    const { tx } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      { status: "Completed", amountNgn: 3000, processorReference: "P-1", authorization: null },
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
      { status: "Completed", amountNgn: 3500, processorReference: "P-1", authorization: null },
    );
    expect(r).toEqual({ kind: "already_processed", status: "confirmed" });
    expect(calls.inserts).toHaveLength(0);
  });
});
