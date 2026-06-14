import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Factory { id: string; name: string }
interface Product { id: string; slug: string }

describe("inventory adjust", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let product: Product;
  let secondFactory: Factory;

  const idem = () => ({ "idempotency-key": uuid() });

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
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

    const { factory: factoryTable } = await import("@ms/db");
    const [f1] = await tdb.db.insert(factoryTable).values({ name: "Adj Factory" }).returning();
    factory = f1 as Factory;
    const [f2] = await tdb.db.insert(factoryTable).values({ name: "Other Factory" }).returning();
    secondFactory = f2 as Factory;

    const p = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Adj Sunrise",
      slug: "adj-sunrise",
      category: "regular",
      ingredients: ["x"],
      initial_price_ngn: 2500,
    });
    product = p.body.data;

    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-01",
      items: [{ product_id: product.id, quantity_produced: 100 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("owner sets a new on-hand; stock reflects the new total", async () => {
    const res = await call<{ data: { id: string; items_recorded: number } }>(
      "POST",
      "/v1/inventory/adjust",
      {
        location_type: "factory",
        location_id: factory.id,
        reason_code: "physical_recount",
        items: [{ product_id: product.id, new_quantity: 95 }],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.items_recorded).toBe(1);

    const after = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(after.body.data, product.id)).toBe(95);
  });

  it("adjusts two sizes of one flavour independently", async () => {
    const created = await call<{ data: { id: string; variants: Array<{ id: string; size_ml: number }> } }>(
      "POST",
      "/v1/products",
      {
        name: "Adj Dual",
        slug: "adj-dual",
        category: "regular",
        ingredients: ["x"],
        variants: [
          { size_ml: 330, price_ngn: 2500 },
          { size_ml: 650, price_ngn: 3500 },
        ],
      },
    );
    const dual = created.body.data;
    const v330 = dual.variants.find((v) => v.size_ml === 330)!.id;
    const v650 = dual.variants.find((v) => v.size_ml === 650)!.id;

    await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "opening_balance",
      items: [
        { product_id: dual.id, variant_id: v330, new_quantity: 10 },
        { product_id: dual.id, variant_id: v650, new_quantity: 4 },
      ],
    });

    const s = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    const rows = s.body.data.filter((r) => r.product_id === dual.id);
    expect(rows.find((r) => r.variant_id === v330)!.balance).toBe(10);
    expect(rows.find((r) => r.variant_id === v650)!.balance).toBe(4);
  });

  it("reason other_with_note rejects an empty note", async () => {
    const missing = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "other_with_note",
      items: [{ product_id: product.id, new_quantity: 95 }],
    });
    expect(missing.status).toBe(400);

    const blank = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "other_with_note",
      reason_note: "   ",
      items: [{ product_id: product.id, new_quantity: 95 }],
    });
    expect(blank.status).toBe(400);
  });

  it("reason other_with_note with a real note succeeds", async () => {
    const ok = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "other_with_note",
      reason_note: "Mouse damage in storage",
      items: [{ product_id: product.id, new_quantity: 92 }],
    });
    expect(ok.status).toBe(201);
  });

  it("empty items array is rejected", async () => {
    const res = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "damaged",
      items: [],
    });
    expect(res.status).toBe(400);
  });

  it("Zod nonnegative rejects new_quantity = -1", async () => {
    const res = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "physical_recount",
      items: [{ product_id: product.id, new_quantity: -1 }],
    });
    expect(res.status).toBe(400);
  });

  it("delta == 0 records the header but no ledger lines", async () => {
    const beforeBal = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    const before = stockBalance(beforeBal.body.data, product.id);

    const res = await call<{ data: { items_recorded: number } }>(
      "POST",
      "/v1/inventory/adjust",
      {
        location_type: "factory",
        location_id: factory.id,
        reason_code: "physical_recount",
        items: [{ product_id: product.id, new_quantity: before }],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.items_recorded).toBe(0);

    const afterBal = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/factory/${factory.id}`,
    );
    expect(stockBalance(afterBal.body.data, product.id)).toBe(before);
  });

  it("unauthenticated caller cannot adjust", async () => {
    const res = await fetch(`${baseUrl}/v1/inventory/adjust`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      body: JSON.stringify({
        location_type: "factory",
        location_id: factory.id,
        reason_code: "damaged",
        items: [{ product_id: product.id, new_quantity: 50 }],
      }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("owner can read any factory's stock", async () => {
    const a = await call("GET", `/v1/stock/factory/${factory.id}`);
    expect(a.status).toBe(200);
    const b = await call("GET", `/v1/stock/factory/${secondFactory.id}`);
    expect(b.status).toBe(200);
  });

  it("unauthenticated caller cannot read factory stock", async () => {
    const res = await fetch(`${baseUrl}/v1/stock/factory/${factory.id}`);
    expect([401, 403]).toContain(res.status);
  });
});
