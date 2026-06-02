import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface Factory { id: string; name: string }
interface Product { id: string; slug: string }
interface TransferDetail {
  id: string;
  items: Array<{ id: string; productId: string; quantitySent: number; quantityReceived: number | null }>;
}

/**
 * Exercises two pieces of the in-flight transfer changes:
 *  - The receive Zod refine that requires `variance_note` whenever the
 *    branch chose `other_with_note` as the reason.
 *  - The owner-only `PATCH /transfers/:id/items/:itemId/adjust` endpoint
 *    that corrects sent or received counts after the fact and writes a
 *    `count_correction` ledger entry to keep balances honest.
 */
describe("transfer adjust + variance_note", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let branch: Branch;
  let product: Product;

  const idem = () => ({ "idempotency-key": uuid() });

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? idem() : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Adjust Branch",
      code: "ADJ",
      delivery_zones: [{ name: "z", fee_ngn: 100 }],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Adjust Factory" }).returning();
    factory = fac as Factory;

    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Adjust Sunrise",
      slug: "adjust-sunrise",
      category: "regular",
      ingredients: ["x"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;

    // Stock the factory with 100 bottles via a completed production run
    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-01",
      items: [{ product_id: product.id, quantity_produced: 100 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  async function newDispatchedTransfer(qty: number): Promise<{ id: string; itemId: string }> {
    const created = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: qty }],
    });
    const id = created.body.data.id;
    // POST returns the transfer summary without items; fetch the detail.
    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${id}`);
    const itemId = detail.body.data.items[0]!.id;
    return { id, itemId };
  }

  it("variance_reason=other_with_note requires a non-empty variance_note", async () => {
    const { id, itemId } = await newDispatchedTransfer(20);
    await call("PATCH", `/v1/transfers/${id}/arrive`);

    const missing = await call("PATCH", `/v1/transfers/${id}/receive`, {
      items: [
        { item_id: itemId, quantity_received: 18, variance_reason: "other_with_note" },
      ],
    });
    expect(missing.status).toBe(400);

    const ok = await call("PATCH", `/v1/transfers/${id}/receive`, {
      items: [
        {
          item_id: itemId,
          quantity_received: 18,
          variance_reason: "other_with_note",
          variance_note: "Two cans found leaking on arrival",
        },
      ],
    });
    expect(ok.status).toBe(200);
  });

  it("owner adjusts received count up; branch ledger reflects the corrected total", async () => {
    const { id, itemId } = await newDispatchedTransfer(10);
    await call("PATCH", `/v1/transfers/${id}/arrive`);
    await call("PATCH", `/v1/transfers/${id}/receive`, {
      items: [{ item_id: itemId, quantity_received: 10 }],
    });

    // Branch should hold 10 from the clean receive (plus 18 from the previous
    // test's receive — both went to the same branch).
    const before = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    const beforeQty = before.body.data[product.id] ?? 0;

    const adj = await call<{ data: { quantityReceived: number } }>(
      "PATCH",
      `/v1/transfers/${id}/items/${itemId}/adjust`,
      { side: "received", new_quantity: 12, reason: "Re-count after shelving" },
    );
    expect(adj.status).toBe(200);
    expect(adj.body.data.quantityReceived).toBe(12);

    const after = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    // +2 ledger correction
    expect(after.body.data[product.id]).toBe(beforeQty + 2);
  });

  it("owner adjusts sent count; factory ledger reflects the corrected total", async () => {
    const factoryBefore = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    const beforeFactoryQty = factoryBefore.body.data[product.id] ?? 0;

    const { id, itemId } = await newDispatchedTransfer(5);

    // Bump sent from 5 to 7 — factory should drop by an extra 2
    await call("PATCH", `/v1/transfers/${id}/items/${itemId}/adjust`, {
      side: "sent",
      new_quantity: 7,
      reason: "Manifest understated dispatched count by 2",
    });

    const factoryAfter = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(factoryAfter.body.data[product.id]).toBe(beforeFactoryQty - 5 - 2);
  });

  it("non-authenticated request cannot adjust counts", async () => {
    const { id, itemId } = await newDispatchedTransfer(3);
    const res = await fetch(`${baseUrl}/v1/transfers/${id}/items/${itemId}/adjust`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({ side: "sent", new_quantity: 4, reason: "no auth" }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("each successful adjust enqueues a stock_transfer.count_corrected outbox event", async () => {
    const { id, itemId } = await newDispatchedTransfer(8);
    await call("PATCH", `/v1/transfers/${id}/arrive`);
    await call("PATCH", `/v1/transfers/${id}/receive`, {
      items: [{ item_id: itemId, quantity_received: 8 }],
    });
    await call("PATCH", `/v1/transfers/${id}/items/${itemId}/adjust`, {
      side: "received",
      new_quantity: 9,
      reason: "Found one extra on the back shelf",
    });

    // Reach into the DB directly — there's no public endpoint for the outbox
    // (it's worker-internal), but the test container exposes `db`.
    const { outboxEvent: outboxTable } = await import("@ms/db");
    const { eq, desc } = await import("drizzle-orm");
    const tdb = await import("./helpers.js").then((m) => m);
    void tdb; // suppress unused; we already have db via setupTestDb sharing process.env.DATABASE_URL
    const { createDbClient } = await import("@ms/db");
    const db = createDbClient(process.env.DATABASE_URL!);
    const rows = await db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.eventType, "stock_transfer.count_corrected"))
      .orderBy(desc(outboxTable.createdAt))
      .limit(1);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload["transfer_id"]).toBe(id);
    expect(payload["side"]).toBe("received");
    expect(payload["old_quantity"]).toBe(8);
    expect(payload["new_quantity"]).toBe(9);
    expect(payload["delta"]).toBe(1);
    expect(payload["reason"]).toBe("Found one extra on the back shelf");
  });
});
