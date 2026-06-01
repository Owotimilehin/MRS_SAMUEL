import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface Product { id: string; name: string; slug: string }
interface SaleOrder {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
  paymentStatus: string;
}

describe("Phase 2 walk-up sale flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: Branch;
  let factory: { id: string };
  let product: Product;

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
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
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

    // Seed test data
    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Sales Test Branch",
      code: "STB",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Sales Test Factory" }).returning();
    factory = fac as { id: string };

    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Sales Test Sunrise",
      slug: "sales-test-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;

    // Pre-stock the branch via factory production + transfer.
    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-05-11",
      items: [{ product_id: product.id, quantity_produced: 10 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
    const xfer = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: 10 }],
    });
    // POST /v1/transfers creates the row already in `dispatched` status —
    // no separate /dispatch call is needed (or exists on the route table).
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/arrive`);
    const detail = await call<{
      data: { items: Array<{ id: string }> };
    }>("GET", `/v1/transfers/${xfer.body.data.id}`);
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/receive`, {
      items: [
        {
          item_id: detail.body.data.items[0]!.id,
          quantity_received: 10,
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("walk-up: confirm 2 bottles → pay cash → hand over; ledger decrements", async () => {
    const stockBefore = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBefore.body.data[product.id]).toBe(10);

    const confirm = await call<{ data: SaleOrder }>(
      "POST",
      `/v1/branches/${branch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: 2 }],
        payment_method: "cash",
        created_at_local: new Date().toISOString(),
      },
    );
    expect(confirm.status).toBe(201);
    expect(confirm.body.data.status).toBe("confirmed");
    expect(confirm.body.data.totalNgn).toBe(5000);

    // Reservation should hold the stock — available should be 8 now.
    const stockReserved = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    // /v1/stock returns LEDGER sum, which is still 10 (no ledger row yet).
    // The reservation effect is invisible to /stock but real to availableAtBranch.
    expect(stockReserved.body.data[product.id]).toBe(10);

    const pay = await call<{ data: SaleOrder }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`,
    );
    expect(pay.body.data.status).toBe("paid");
    expect(pay.body.data.paymentStatus).toBe("paid");

    const handOver = await call<{ data: SaleOrder }>(
      "PATCH",
      `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/hand-over`,
    );
    expect(handOver.body.data.status).toBe("handed_over");

    // After payment the ledger has decremented.
    const stockAfter = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockAfter.body.data[product.id]).toBe(8);
  });

  it("reservation prevents over-selling: 2nd confirm rejected when stock reserved", async () => {
    // Branch now has 8 bottles. Reserve 7 in a pending sale (don't pay).
    const big = await call<{ data: SaleOrder }>(
      "POST",
      `/v1/branches/${branch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: 7 }],
        payment_method: "cash",
        created_at_local: new Date().toISOString(),
      },
    );
    expect(big.status).toBe(201);

    // Try to sell 2 more. 8 - 7 reserved = 1 available → 2 should be rejected.
    const oversell = await call<{ error: { code: string } }>(
      "POST",
      `/v1/branches/${branch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: 2 }],
        payment_method: "cash",
        created_at_local: new Date().toISOString(),
      },
    );
    expect(oversell.status).toBe(422);
    expect(oversell.body.error.code).toBe("conflict");

    // Cancel the big reservation so future tests can run.
    await call("PATCH", `/v1/branches/${branch.id}/sales/${big.body.data.id}/cancel`, {
      reason: "customer_changed_mind",
    });
  });

  it("cancel after pay reverses the ledger", async () => {
    const confirm = await call<{ data: SaleOrder }>(
      "POST",
      `/v1/branches/${branch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method: "cash",
        created_at_local: new Date().toISOString(),
      },
    );
    await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);

    const before = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    // Branch had 10, sold 2, sold 1 → 7
    expect(before.body.data[product.id]).toBe(7);

    await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/cancel`, {
      reason: "duplicate_order",
    });

    const after = await call<{ data: Record<string, number> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(after.body.data[product.id]).toBe(8);
  });

  it("idempotency: same key + same payload returns the same sale row", async () => {
    const key = uuid();
    const body = {
      channel: "walkup" as const,
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash" as const,
      created_at_local: new Date().toISOString(),
    };
    const first = await fetch(`${baseUrl}/v1/branches/${branch.id}/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": key },
      body: JSON.stringify(body),
    });
    const firstJson = (await first.json()) as { data: SaleOrder };

    const second = await fetch(`${baseUrl}/v1/branches/${branch.id}/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": key },
      body: JSON.stringify(body),
    });
    const secondJson = (await second.json()) as { data: SaleOrder };

    expect(secondJson.data.id).toBe(firstJson.data.id);
  });

  it("sync pull returns this branch's data", async () => {
    const res = await call<{
      data: {
        products: unknown[];
        ledger: unknown[];
        sales: unknown[];
      };
      next_cursor: string;
    }>("GET", `/v1/sync/pull?branch_id=${branch.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.products.length).toBeGreaterThan(0);
    expect(res.body.data.ledger.length).toBeGreaterThan(0);
    expect(res.body.data.sales.length).toBeGreaterThan(0);
    expect(res.body.next_cursor).toBeTruthy();
  });
});
