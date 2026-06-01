import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface ProductRow { id: string; name: string }
interface SaleOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
}
interface ClosePreview {
  expected_cash_ngn: number;
  expected_stock: Record<string, number>;
}
interface CloseRow {
  id: string;
  status: string;
  varianceNgn: number;
  cashCountedNgn: number;
  systemCashTotalNgn: number;
}

describe("Phase 5 daily close flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: Branch;
  let product: ProductRow;

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

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Close Test Branch",
      code: "CTB",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Close Test Factory" }).returning();
    const factory = fac as { id: string };

    const pRes = await call<{ data: ProductRow }>("POST", "/v1/products", {
      name: "Close Test Sunrise",
      slug: "close-test-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;

    // Pre-stock 20 bottles.
    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-05-11",
      items: [{ product_id: product.id, quantity_produced: 20 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
    const xfer = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, quantity_sent: 20 }],
    });
    // POST /v1/transfers creates the row already in `dispatched` status —
    // no separate /dispatch call is needed (or exists on the route table).
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/arrive`);
    const detail = await call<{ data: { items: Array<{ id: string }> } }>(
      "GET",
      `/v1/transfers/${xfer.body.data.id}`,
    );
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/receive`, {
      items: [{ item_id: detail.body.data.items[0]!.id, quantity_received: 20 }],
    });

    // Sell 3 bottles cash today.
    for (let i = 0; i < 3; i++) {
      const confirm = await call<{ data: SaleOrderRow }>(
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
    }
  }, 90_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("preview returns expected cash + stock", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ data: ClosePreview }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close/preview?date=${today}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.expected_cash_ngn).toBe(7500); // 3 × ₦2,500
    expect(res.body.data.expected_stock[product.id]).toBe(17); // 20 − 3 sold
  });

  it("submitting a perfect count records zero variance", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ data: CloseRow }>(
      "POST",
      `/v1/branches/${branch.id}/daily-close`,
      {
        business_date: today,
        cash_counted_ngn: 7500,
        transfers_counted_ngn: 0,
        stock_counts: [{ product_id: product.id, counted_quantity: 17 }],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("submitted");
    expect(res.body.data.varianceNgn).toBe(0);
    expect(res.body.data.systemCashTotalNgn).toBe(7500);
  });

  it("owner approves a submitted close", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const list = await call<{ data: CloseRow[] }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close`,
    );
    const target = list.body.data[0]!;
    const approve = await call<{ data: CloseRow }>(
      "PATCH",
      `/v1/branches/${branch.id}/daily-close/${target.id}/approve`,
    );
    expect(approve.body.data.status).toBe("approved");
    // Idempotency for the date: second submit replaces, not duplicates.
    const second = await call<{ data: CloseRow }>(
      "POST",
      `/v1/branches/${branch.id}/daily-close`,
      {
        business_date: today,
        cash_counted_ngn: 7000,
        transfers_counted_ngn: 0,
        stock_counts: [{ product_id: product.id, counted_quantity: 16, variance_reason: "spillage" }],
      },
    );
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(target.id); // upsert returns same row
    expect(second.body.data.varianceNgn).toBe(-500);
  });

  it("revenue report aggregates today's sales", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{
      data: Array<{ branch_id: string; channel: string; gross_ngn: number; orders: number }>;
    }>("GET", `/v1/reports/revenue?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const ours = res.body.data.find((r) => r.branch_id === branch.id);
    expect(ours).toBeDefined();
    expect(ours!.gross_ngn).toBe(7500);
    expect(ours!.orders).toBe(3);
  });

  it("top-products report ranks our product", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{
      data: Array<{ product_id: string; quantity: number; revenue_ngn: number }>;
    }>("GET", `/v1/reports/top-products?from=${today}&to=${today}`);
    const hit = res.body.data.find((p) => p.product_id === product.id);
    expect(hit).toBeDefined();
    expect(hit!.quantity).toBe(3);
    expect(hit!.revenue_ngn).toBe(7500);
  });
});
