import { describe, it, expect } from "vitest";
import {
  readEntries,
  writeEntry,
  removeEntry,
  isTerminalOrder,
  isStale,
  isAwaitingPayment,
  reconcileEntries,
  STALE_MS,
  type OngoingEntry,
} from "./ongoing-orders";
import type { ApiOrderTracking } from "./api/types";

function mkOrder(partial: Partial<ApiOrderTracking> & { order_number: string }): ApiOrderTracking {
  return {
    order_number: partial.order_number,
    status: partial.status ?? "paid",
    payment_status: partial.payment_status ?? "paid",
    total_ngn: 0,
    subtotal_ngn: 0,
    delivery_fee_ngn: 0,
    channel: "online",
    created_at: "2026-06-24T12:00:00Z",
    scheduled_delivery_at: partial.scheduled_delivery_at ?? null,
    delivery_state: partial.delivery_state ?? "Lagos",
    is_preorder: partial.is_preorder ?? false,
    fulfilled_at: partial.fulfilled_at ?? null,
    paid_at: partial.paid_at ?? null,
    out_for_delivery_at: partial.out_for_delivery_at ?? null,
    delivered_at: partial.delivered_at ?? null,
    reservation_expires_at: null,
    resume_payment: null,
    support_whatsapp: null,
    items: [],
    delivery: partial.delivery ?? {
      status: "pending",
      rider_name: null,
      rider_phone: null,
      rider_vehicle: null,
      tracking_url: null,
      eta_minutes: null,
      provider: "bolt",
    },
  };
}

class FakeStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("ongoing-orders storage", () => {
  it("reads only ms_track_* entries that carry a phone", () => {
    const s = new FakeStorage();
    s.setItem("ms_track_SO-1", JSON.stringify({ phone: "08010000001" }));
    s.setItem(
      "ms_track_SO-2",
      JSON.stringify({ phone: "08010000002", placedAt: "2026-06-24T10:00:00Z" }),
    );
    s.setItem("ms_track_SO-3", JSON.stringify({ noPhone: true })); // skipped — no phone
    s.setItem("unrelated_key", JSON.stringify({ phone: "08019999999" })); // skipped — wrong prefix
    s.setItem("ms_track_SO-4", "not json"); // skipped — malformed

    const entries = readEntries(s);
    const byNumber = Object.fromEntries(entries.map((e) => [e.orderNumber, e]));

    expect(entries).toHaveLength(2);
    expect(byNumber["SO-1"]).toEqual({ orderNumber: "SO-1", phone: "08010000001", placedAt: null });
    expect(byNumber["SO-2"].placedAt).toBe("2026-06-24T10:00:00Z");
  });

  it("writes and removes a round-trippable entry", () => {
    const s = new FakeStorage();
    writeEntry(s, "SO-9", "08055555555", "2026-06-24T12:00:00Z");
    expect(readEntries(s)).toEqual([
      { orderNumber: "SO-9", phone: "08055555555", placedAt: "2026-06-24T12:00:00Z" },
    ]);
    removeEntry(s, "SO-9");
    expect(readEntries(s)).toEqual([]);
  });
});

describe("isTerminalOrder", () => {
  it("is true for delivered / cancelled / refunded / fulfilled, or when a delivered/fulfilled timestamp is set", () => {
    expect(isTerminalOrder({ status: "delivered" })).toBe(true);
    expect(isTerminalOrder({ status: "cancelled" })).toBe(true);
    expect(isTerminalOrder({ status: "refunded" })).toBe(true);
    expect(isTerminalOrder({ status: "fulfilled" })).toBe(true);
    expect(isTerminalOrder({ status: "paid", delivered_at: "2026-06-24T13:00:00Z" })).toBe(true);
    expect(isTerminalOrder({ status: "paid", fulfilled_at: "2026-06-24T13:00:00Z" })).toBe(true);
  });

  it("is false while the order is still in progress", () => {
    expect(isTerminalOrder({ status: "confirmed" })).toBe(false);
    expect(isTerminalOrder({ status: "paid", delivered_at: null })).toBe(false);
    expect(isTerminalOrder({ status: "out_for_delivery" })).toBe(false);
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-06-24T12:00:00Z");
  it("is stale when placedAt is older than the 48h window", () => {
    const entry: OngoingEntry = {
      orderNumber: "SO-1",
      phone: "0801",
      placedAt: new Date(now - STALE_MS - 1000).toISOString(),
    };
    expect(isStale(entry, now)).toBe(true);
  });
  it("is not stale when recent, or when placedAt is missing/invalid", () => {
    expect(
      isStale(
        { orderNumber: "a", phone: "0801", placedAt: new Date(now - 1000).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(isStale({ orderNumber: "a", phone: "0801", placedAt: null }, now)).toBe(false);
    expect(isStale({ orderNumber: "a", phone: "0801", placedAt: "garbage" }, now)).toBe(false);
  });
});

describe("isAwaitingPayment", () => {
  it("flags an unpaid, non-cancelled order so the pill can offer Resume payment", () => {
    expect(isAwaitingPayment({ status: "confirmed", payment_status: "unpaid" })).toBe(true);
    expect(isAwaitingPayment({ status: "paid", payment_status: "paid" })).toBe(false);
    expect(isAwaitingPayment({ status: "cancelled", payment_status: "unpaid" })).toBe(false);
  });
});

describe("reconcileEntries", () => {
  const now = Date.parse("2026-06-24T12:00:00Z");
  const isNotFound = (e: unknown) => e instanceof Error && e.message === "NOT_FOUND";
  const e = (
    orderNumber: string,
    placedAt: string | null = "2026-06-24T11:00:00Z",
  ): OngoingEntry => ({
    orderNumber,
    phone: "0801",
    placedAt,
  });

  it("keeps an in-progress order as an active pill and does not prune it", async () => {
    const { active, prune } = await reconcileEntries(
      [e("SO-1")],
      async () =>
        mkOrder({
          order_number: "SO-1",
          status: "paid",
          payment_status: "paid",
          out_for_delivery_at: "2026-06-24T11:30:00Z",
        }),
      { now, isNotFound },
    );
    expect(prune).toEqual([]);
    expect(active).toHaveLength(1);
    expect(active[0].orderNumber).toBe("SO-1");
    expect(active[0].awaitingPayment).toBe(false);
    expect(active[0].label).toBeTruthy();
  });

  it("prunes a terminal (delivered) order and shows no pill", async () => {
    const { active, prune } = await reconcileEntries(
      [e("SO-2")],
      async () =>
        mkOrder({
          order_number: "SO-2",
          status: "delivered",
          delivered_at: "2026-06-24T11:45:00Z",
        }),
      { now, isNotFound },
    );
    expect(prune).toEqual(["SO-2"]);
    expect(active).toEqual([]);
  });

  it("prunes a stale entry WITHOUT fetching it", async () => {
    let fetched = false;
    const { active, prune } = await reconcileEntries(
      [e("SO-3", new Date(now - STALE_MS - 1000).toISOString())],
      async () => {
        fetched = true;
        return mkOrder({ order_number: "SO-3" });
      },
      { now, isNotFound },
    );
    expect(fetched).toBe(false);
    expect(prune).toEqual(["SO-3"]);
    expect(active).toEqual([]);
  });

  it("prunes an order the server no longer knows (not found)", async () => {
    const { active, prune } = await reconcileEntries(
      [e("SO-4")],
      async () => {
        throw new Error("NOT_FOUND");
      },
      { now, isNotFound },
    );
    expect(prune).toEqual(["SO-4"]);
    expect(active).toEqual([]);
  });

  it("keeps an entry on a transient error — neither pill nor prune", async () => {
    const { active, prune } = await reconcileEntries(
      [e("SO-5")],
      async () => {
        throw new Error("network down");
      },
      { now, isNotFound },
    );
    expect(prune).toEqual([]);
    expect(active).toEqual([]);
  });

  it("flags an unpaid order's pill as awaiting payment", async () => {
    const { active } = await reconcileEntries(
      [e("SO-6")],
      async () => mkOrder({ order_number: "SO-6", status: "confirmed", payment_status: "unpaid" }),
      { now, isNotFound },
    );
    expect(active[0].awaitingPayment).toBe(true);
  });
});
