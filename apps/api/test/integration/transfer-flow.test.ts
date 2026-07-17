import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface Factory { id: string; name: string }
interface Product { id: string; slug: string }
interface Transfer { id: string; transfer_number: string; status: string }
interface TransferDetail extends Transfer {
  items: Array<{ id: string; productId: string; quantitySent: number }>;
}

/**
 * End-to-end Phase 1 happy path. Drives the entire transfer state machine
 * via real HTTP calls, verifying ledger balances along the way.
 */
describe("Phase 1 transfer flow — happy path + variance", () => {
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
        ...(["POST", "PATCH", "PUT"].includes(method) ? idem() : {}),
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

    // Seed a factory and branch directly via the (just-built) HTTP API.
    const fRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Test Branch",
      code: "TEST",
      delivery_zones: [{ name: "Test zone", fee_ngn: 1000 }],
    });
    branch = fRes.body.data;

    // Factory rows aren't exposed via a CRUD endpoint yet; insert directly
    // through the test container's db connection.
    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Test Factory" }).returning();
    factory = fac as Factory;

    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Test Sunrise",
      slug: "test-sunrise",
      category: "regular",
      ingredients: ["Carrot", "Orange"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("factory opening stock seeded to 50", async () => {
    // Stock at factory should start at 0
    const before = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(before.body.data, product.id)).toBe(0);

    // Seed factory stock via an opening-balance adjustment. (Production-run
    // completion is covered separately in production-runs-consumption.test.ts;
    // it now requires linked bottle materials + packaging stock, which is out
    // of scope for the transfer flow — so we seed stock directly here.)
    const adjust = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "opening_balance",
      items: [{ product_id: product.id, new_quantity: 50 }],
    });
    expect(adjust.status).toBe(201);

    const after = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(after.body.data, product.id)).toBe(50);
  });

  it("clean receive: send 20, branch counts 20, transfer auto-completes", async () => {
    const create = await call<{ data: Transfer }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: 20 }],
    });
    expect(create.status).toBe(201);
    expect(create.body.data.status).toBe("dispatched");
    const id = create.body.data.id;

    // Factory stock should be 30 (50 produced - 20 dispatched)
    const factoryStock = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(factoryStock.body.data, product.id)).toBe(30);

    await call("PATCH", `/v1/transfers/${id}/arrive`);

    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${id}`);
    const lineId = detail.body.data.items[0]!.id;

    const receive = await call<{ data: Transfer }>("PATCH", `/v1/transfers/${id}/receive`, {
      items: [{ item_id: lineId, quantity_received: 20 }],
    });
    // Clean receipt auto-completes
    expect(receive.body.data.status).toBe("completed");

    // Branch stock should now be 20
    const branchStock = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBalance(branchStock.body.data, product.id)).toBe(20);
  });

  it("variance receive: 10 sent, 8 received → received_with_variance + needs review", async () => {
    const create = await call<{ data: Transfer }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: 10 }],
    });
    const id = create.body.data.id;
    await call("PATCH", `/v1/transfers/${id}/arrive`);

    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${id}`);
    const lineId = detail.body.data.items[0]!.id;

    const receive = await call<{ data: Transfer }>("PATCH", `/v1/transfers/${id}/receive`, {
      items: [
        {
          item_id: lineId,
          quantity_received: 8,
          variance_reason: "damaged_in_transit",
        },
      ],
    });
    expect(receive.body.data.status).toBe("received_with_variance");

    // Needs review inbox should pick this up
    const review = await call<{ data: { transfer_variances: Array<{ id: string }> } }>(
      "GET",
      "/v1/review",
    );
    expect(review.body.data.transfer_variances.some((t) => t.id === id)).toBe(true);

    // Owner settles the variance and approves. Damaged-in-transit → write the
    // 2-bottle gap off as loss; the branch keeps the 8 it physically received.
    const approve = await call<{ data: Transfer }>("PATCH", `/v1/transfers/${id}/approve`, {
      settlements: [{ item_id: lineId, settle: "loss" }],
    });
    expect(approve.body.data.status).toBe("completed");

    // Branch stock is 20 (clean) + 8 (variance) = 28
    const branchStock = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBalance(branchStock.body.data, product.id)).toBe(28);
  });

  it("reject path reverses the factory ledger", async () => {
    // Factory stock is currently 30 - 10 = 20 after the previous variance dispatch.
    const before = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    const beforeBalance = stockBalance(before.body.data, product.id);

    const create = await call<{ data: Transfer }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: 5 }],
    });
    const id = create.body.data.id;
    await call("PATCH", `/v1/transfers/${id}/arrive`);

    const after = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(after.body.data, product.id)).toBe(beforeBalance - 5);

    const reject = await call<{ data: Transfer }>("PATCH", `/v1/transfers/${id}/reject`, {
      reason: "wrong delivery address",
    });
    expect(reject.body.data.status).toBe("rejected");

    const final = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(final.body.data, product.id)).toBe(beforeBalance);
  });

  it("send blocked when factory stock insufficient", async () => {
    const create = await call<{ error?: { code: string; details?: { insufficient: unknown[] } } }>(
      "POST",
      "/v1/transfers",
      {
        factory_id: factory.id,
        branch_id: branch.id,
        items: [{ product_id: product.id, quantity_sent: 999_999 }],
      },
    );
    expect(create.status).toBe(422);
    expect(create.body.error?.code).toBe("conflict");
    expect(create.body.error?.details?.insufficient?.length).toBeGreaterThan(0);
  });
});
