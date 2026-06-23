// fake-indexeddb MUST be imported before anything that constructs the Dexie
// database (db/local.ts builds `new BranchDB()` at module load).
import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  local,
  localAvailableForProduct,
  localAvailableForVariant,
  type OutboxRow,
} from "../db/local.js";
import { dedupeSaleLedger, flushOutbox, pullDeltas, reclaimInFlight, resyncStock } from "./engine.js";
import { createLocalSale } from "./local-sale.js";

/**
 * Bad-network resilience suite for the offline-first POS sync engine.
 *
 * These tests simulate a branch till on a flaky connection and assert the
 * engine does the right thing in every failure mode it can hit:
 *   - fully offline                → nothing is sent, nothing is lost
 *   - server 5xx (transient)       → row stays queued, backed off, never dropped
 *   - dropped connection (throw)   → row stays queued, attempt bumped
 *   - business rejection 4xx       → row dead-lettered, NOT retried forever
 *   - dependency ordering          → Pay never reaches the server before Confirm
 *   - recovery                     → a queued sale flushes once the network heals
 *   - backoff window               → a not-yet-due row is left alone
 */

function setOnline(online: boolean): void {
  vi.stubGlobal("navigator", { onLine: online });
}

/** Build a POST-sale outbox row that is due to send right now. */
function saleRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    endpoint: `/v1/branches/B1/sales`,
    method: "POST",
    payload: { id, channel: "walkup", items: [], payment_method: "cash" },
    attempt_count: 0,
    next_attempt_at: Date.now() - 1, // due now
    status: "pending",
    created_at_local: Date.now(),
    ...overrides,
  };
}

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => Promise.resolve(impl(url, init))),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  await local.outbox.clear();
  await local.ledger.clear();
  await local.stock.clear();
  await local.meta.clear();
  setOnline(true);
});

/** A pull response with every table empty unless overridden. */
function pullBody(
  ledger: Array<{
    id: string;
    locationType: string;
    locationId: string;
    productId: string;
    variantId: string | null;
    delta: number;
    sourceType: string;
    sourceId: string;
    recordedAt: string;
  }> = [],
  stock: Array<{ productId: string; variantId: string | null; qty: number }> = [],
) {
  return {
    data: {
      products: [],
      variants: [],
      prices: [],
      ledger,
      stock,
      transfers: [],
      sales: [],
    },
    next_cursor: new Date().toISOString(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sync engine under bad networks", () => {
  it("offline: sends nothing and keeps the sale safely queued", async () => {
    setOnline(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await local.outbox.put(saleRow({ id: "s1" }));

    await flushOutbox();

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await local.outbox.get("s1");
    expect(row?.status).toBe("pending"); // not lost
  });

  it("server 5xx: keeps the row queued, bumps attempts, backs off — never drops it", async () => {
    mockFetch(() => jsonResponse(500, { error: { message: "boom" } }));
    await local.outbox.put(saleRow({ id: "s2" }));

    await flushOutbox();

    const row = await local.outbox.get("s2");
    expect(row?.status).toBe("pending"); // still retryable
    expect(row?.attempt_count).toBe(1);
    expect(row?.next_attempt_at).toBeGreaterThan(Date.now()); // backed off into the future
  });

  it("dropped connection (fetch throws): row survives and is rescheduled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNRESET"))),
    );
    await local.outbox.put(saleRow({ id: "s3" }));

    await flushOutbox();

    const row = await local.outbox.get("s3");
    expect(row?.status).toBe("pending");
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error).toContain("ECONNRESET");
  });

  it("business rejection (409): dead-letters instead of retrying forever", async () => {
    mockFetch(() => jsonResponse(409, { error: { message: "insufficient stock" } }));
    await local.outbox.put(saleRow({ id: "s4" }));

    await flushOutbox();

    const row = await local.outbox.get("s4");
    expect(row?.status).toBe("dead");
    expect(row?.last_error).toBe("insufficient stock");
  });

  it("session lapsed (401): renews the login and retries so the sale lodges — never dead-lettered", async () => {
    // The access cookie lives 30 minutes; a till left idle/backgrounded past that
    // sends a sale with no cookie and the server answers 401 "missing session".
    // The engine must renew via /auth/refresh (like the app-level api() wrapper)
    // and retry — not mark a perfectly good sale as Failed.
    let saleCalls = 0;
    let refreshCalls = 0;
    mockFetch((url) => {
      if (url.includes("/auth/refresh")) {
        refreshCalls++;
        return jsonResponse(200, { data: { ok: true } });
      }
      saleCalls++;
      return saleCalls === 1
        ? jsonResponse(401, { error: { message: "missing session" } })
        : jsonResponse(201, { data: { id: "ok" } });
    });
    await local.outbox.put(saleRow({ id: "s401" }));

    await flushOutbox();

    const row = await local.outbox.get("s401");
    expect(row?.status).toBe("acknowledged"); // lodged, not Failed
    expect(refreshCalls).toBe(1); // renewed exactly once
    expect(saleCalls).toBe(2); // original 401 + retry after refresh
  });

  it("session truly gone (401 + refresh fails): keeps the sale recoverable (pending), never dead", async () => {
    // Refresh token also expired/revoked. The sale is still valid — it must stay
    // queued (recoverable) so it flushes the moment the cashier signs back in.
    // Dead-lettering it here is exactly the bug that lost real sales.
    mockFetch((url) =>
      url.includes("/auth/refresh")
        ? jsonResponse(401, { error: { message: "invalid refresh" } })
        : jsonResponse(401, { error: { message: "missing session" } }),
    );
    await local.outbox.put(saleRow({ id: "s401b" }));

    await flushOutbox();

    const row = await local.outbox.get("s401b");
    expect(row?.status).toBe("pending"); // recoverable — NOT dead
    expect(row?.status).not.toBe("dead");
    expect(row?.attempt_count).toBe(1);
    expect(row?.next_attempt_at).toBeGreaterThan(Date.now()); // backed off
  });

  it("dependency ordering: Pay is held back until its Confirm is acknowledged", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse(201, { data: { id: "ok" } });
    });

    // Pay depends on a Confirm that has NOT been acknowledged yet.
    await local.outbox.put(saleRow({ id: "confirm1" }));
    await local.outbox.put(
      saleRow({
        id: "pay1",
        endpoint: `/v1/branches/B1/sales/confirm1/pay`,
        method: "PATCH",
        payload: null,
        depends_on: "confirm1",
        created_at_local: Date.now() + 1,
      }),
    );

    // Confirm fails (offline server) so it can't be acknowledged this round.
    setOnline(false);
    await flushOutbox();
    expect(calls).toHaveLength(0);

    // Network heals: Confirm goes first, Pay follows — never the other way around.
    setOnline(true);
    await flushOutbox();

    expect(calls[0]).toContain("/sales"); // confirm
    expect(calls).toContain("/v1/branches/B1/sales/confirm1/pay");
    expect((await local.outbox.get("confirm1"))?.status).toBe("acknowledged");
    expect((await local.outbox.get("pay1"))?.status).toBe("acknowledged");
    // Pay must never precede a successful Confirm.
    expect(calls.indexOf("/v1/branches/B1/sales/confirm1/pay")).toBeGreaterThan(0);
  });

  it("recovery: a sale that failed on a 5xx flushes successfully once the network heals", async () => {
    let fail = true;
    mockFetch(() => (fail ? jsonResponse(500, {}) : jsonResponse(201, { data: { id: "ok" } })));
    await local.outbox.put(saleRow({ id: "s5" }));

    // First attempt while the server is flaky.
    await flushOutbox();
    expect((await local.outbox.get("s5"))?.status).toBe("pending");

    // Server recovers. Make the row due again (clear the backoff) and re-flush.
    fail = false;
    await local.outbox.update("s5", { next_attempt_at: Date.now() - 1 });
    await flushOutbox();

    expect((await local.outbox.get("s5"))?.status).toBe("acknowledged");
  });

  it("backoff window: a row scheduled for the future is left untouched", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse(201, { data: {} })));
    vi.stubGlobal("fetch", fetchSpy);
    await local.outbox.put(saleRow({ id: "s6", next_attempt_at: Date.now() + 60_000 }));

    await flushOutbox();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await local.outbox.get("s6"))?.status).toBe("pending");
  });

  it("crash recovery: a sale stranded in_flight by a previous session is reclaimed and re-sent", async () => {
    // Simulate the till being force-closed mid-send on a bad network: the row
    // was left in_flight. flushOutbox alone would ignore it forever.
    await local.outbox.put(saleRow({ id: "s8", status: "in_flight" }));

    await flushOutbox();
    expect((await local.outbox.get("s8"))?.status).toBe("in_flight"); // flush won't touch it

    // New session reclaims it, then it flushes normally.
    mockFetch(() => jsonResponse(201, { data: { id: "ok" } }));
    await reclaimInFlight();
    expect((await local.outbox.get("s8"))?.status).toBe("pending");

    await flushOutbox();
    expect((await local.outbox.get("s8"))?.status).toBe("acknowledged");
  });

  it("pull reconciles the optimistic sale row against the authoritative snapshot — no double count", async () => {
    // Server snapshot says 10 on hand before the sale syncs.
    await local.stock.put({
      id: "P1::V1", product_id: "P1", variant_id: "V1", qty: 10, synced_at: new Date().toISOString(),
    });
    // The till optimistically decremented stock at sale time: a local ledger row
    // with a CLIENT-generated id, keyed to the order id as its source_id.
    await local.ledger.put({
      id: crypto.randomUUID(),
      location_type: "branch",
      location_id: "B1",
      product_id: "P1",
      variant_id: "V1",
      delta: -3,
      source_type: "sale",
      source_id: "ORDER1",
      recorded_at: new Date().toISOString(),
    });
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(7); // 10 snapshot − 3 optimistic

    // The sale synced: the server's snapshot now reflects it (7) and its ledger
    // row for ORDER1 arrives, acknowledging the optimistic row.
    mockFetch(() =>
      jsonResponse(
        200,
        pullBody(
          [
            {
              id: "srv-ledger-1",
              locationType: "branch",
              locationId: "B1",
              productId: "P1",
              variantId: "V1",
              delta: -3,
              sourceType: "sale",
              sourceId: "ORDER1",
              recordedAt: new Date().toISOString(),
            },
          ],
          [{ productId: "P1", variantId: "V1", qty: 7 }],
        ),
      ),
    );

    await pullDeltas("B1");

    // Counted ONCE: snapshot is now 7 and the optimistic row was dropped (not
    // re-applied on top of the snapshot, which would read 4).
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(7);
    // Server ledger rows are no longer persisted locally — only un-acked
    // optimistic rows live in the ledger, and this one was acknowledged.
    const rows = await local.ledger
      .where("[location_type+location_id+product_id]")
      .equals(["branch", "B1", "P1"])
      .toArray();
    expect(rows).toHaveLength(0);
  });

  it("pull replaces the snapshot wholesale — a server-side wipe heals the phantom-stock bug", async () => {
    // A till that synced before a server-side data wipe still holds stale stock.
    await local.stock.put({
      id: "P1::V1", product_id: "P1", variant_id: "V1", qty: 130, synced_at: new Date().toISOString(),
    });
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(130);

    // The server was wiped: it now reports an empty snapshot for the branch.
    mockFetch(() => jsonResponse(200, pullBody([], [])));
    await pullDeltas("B1");

    // The phantom is gone — the snapshot was overwritten, not merged.
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(0);
    expect(await localAvailableForProduct("B1", "P1")).toBe(0);
  });

  it("an absent stock field (older server) never wipes the local snapshot", async () => {
    await local.stock.put({
      id: "P1::V1", product_id: "P1", variant_id: "V1", qty: 12, synced_at: new Date().toISOString(),
    });
    // Server responds without a `stock` key at all.
    mockFetch(() =>
      jsonResponse(200, {
        data: { products: [], variants: [], prices: [], ledger: [], transfers: [], sales: [] },
        next_cursor: new Date().toISOString(),
      }),
    );
    await pullDeltas("B1");
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(12); // preserved
  });

  it("dedupeSaleLedger heals pre-existing optimistic+server duplicates from before the fix", async () => {
    // A sale rung up before the fix left BOTH an optimistic row (client id) and
    // the server's authoritative row (server id) in the ledger — same sale, same
    // size, doubling the deduction. These were already pulled, so a fresh pull
    // won't re-deliver them; a one-time dedup must collapse them.
    const now = new Date().toISOString();
    await local.ledger.bulkPut([
      { id: "client-uuid", location_type: "branch", location_id: "B1", product_id: "P1", variant_id: "V1", delta: -3, source_type: "sale", source_id: "ORDER1", recorded_at: now },
      { id: "server-uuid", location_type: "branch", location_id: "B1", product_id: "P1", variant_id: "V1", delta: -3, source_type: "sale", source_id: "ORDER1", recorded_at: now },
      // A separate, legitimate sale must survive untouched.
      { id: "server-uuid-2", location_type: "branch", location_id: "B1", product_id: "P1", variant_id: "V1", delta: -1, source_type: "sale", source_id: "ORDER2", recorded_at: now },
    ]);
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(-7); // -3 -3 -1, doubled

    await dedupeSaleLedger();

    // ORDER1 counted once (-3), ORDER2 intact (-1) → -4.
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(-4);
    const order1Rows = await local.ledger.filter((r) => r.source_id === "ORDER1").toArray();
    expect(order1Rows).toHaveLength(1);
  });

  it("dedupeSaleLedger leaves non-sale ledger rows alone", async () => {
    const now = new Date().toISOString();
    // Two production rows that happen to share every field are distinct, real
    // movements (e.g. two batches) — dedup must never touch non-sale sources.
    await local.ledger.bulkPut([
      { id: "prod-a", location_type: "branch", location_id: "B1", product_id: "P1", variant_id: "V1", delta: 5, source_type: "production_run", source_id: "PR1", recorded_at: now },
      { id: "prod-b", location_type: "branch", location_id: "B1", product_id: "P1", variant_id: "V1", delta: 5, source_type: "production_run", source_id: "PR1", recorded_at: now },
    ]);

    await dedupeSaleLedger();

    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(10); // both kept
  });

  it("end-to-end: a sale deducts the count exactly once across optimistic write + server sync", async () => {
    // Branch starts with 10 on hand per the last authoritative snapshot.
    await local.stock.put({
      id: "P1::V1", product_id: "P1", variant_id: "V1", qty: 10, synced_at: new Date().toISOString(),
    });
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(10);

    // Cashier sells 3 at the till — the count drops immediately (optimistic).
    const { saleId } = await createLocalSale({
      branchId: "B1",
      items: [{ product_id: "P1", variant_id: "V1", size_ml: 650, quantity: 3, unit_price_ngn: 1000 }],
      payment_method: "cash",
      channel: "walkup",
    });
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(7); // 10 - 3, once

    // The sale syncs; the server's snapshot now shows 7 and its ledger row for
    // the order (source_id === saleId) acknowledges the optimistic row.
    mockFetch(() =>
      jsonResponse(
        200,
        pullBody(
          [
            {
              id: "srv-sale-row", locationType: "branch", locationId: "B1", productId: "P1",
              variantId: "V1", delta: -3, sourceType: "sale", sourceId: saleId,
              recordedAt: new Date().toISOString(),
            },
          ],
          [{ productId: "P1", variantId: "V1", qty: 7 }],
        ),
      ),
    );
    await pullDeltas("B1");

    // Still 7 — the sale was NOT applied a second time. Graceful single deduction.
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(7);
  });

  it("pull is idempotent — re-pulling the same snapshot never inflates the count", async () => {
    mockFetch(() => jsonResponse(200, pullBody([], [{ productId: "P1", variantId: "V1", qty: 8 }])));

    await pullDeltas("B1");
    await pullDeltas("B1"); // overlapping cursor windows re-deliver the same snapshot

    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(8);
    expect(await local.stock.where("product_id").equals("P1").count()).toBe(1);
  });

  it("resyncStock clears the snapshot and re-pulls a fresh one", async () => {
    await local.stock.put({
      id: "P1::V1", product_id: "P1", variant_id: "V1", qty: 999, synced_at: new Date().toISOString(),
    });
    await local.meta.put({ id: "default", last_pull_at: "2020-01-01T00:00:00.000Z", branch_id: "B1" });

    mockFetch(() => jsonResponse(200, pullBody([], [{ productId: "P1", variantId: "V1", qty: 5 }])));
    const refreshed = await resyncStock("B1");

    expect(refreshed).toBe(true);
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(5);
  });

  it("happy path: a queued sale is acknowledged and carries its id as the Idempotency-Key", async () => {
    let seenKey: string | null = null;
    mockFetch((_url, init) => {
      seenKey = new Headers(init.headers).get("idempotency-key");
      return jsonResponse(201, { data: { id: "ok" } });
    });
    await local.outbox.put(saleRow({ id: "s7" }));

    await flushOutbox();

    const row = await local.outbox.get("s7");
    expect(row?.status).toBe("acknowledged");
    expect(row?.acknowledged_at).toBeGreaterThan(0);
    expect(seenKey).toBe("s7"); // replay-safe: server can dedupe on this
  });
});
