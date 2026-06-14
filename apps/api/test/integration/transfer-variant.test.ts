import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface Factory { id: string; name: string }
interface Variant { id: string; size_ml: number; price_ngn: number }
interface Product { id: string; slug: string; variants: Variant[] }
interface Transfer { id: string; transfer_number: string; status: string }
interface TransferItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  size_ml: number | null;
  quantity_sent: number;
  quantity_received: number | null;
}
interface TransferDetail extends Transfer {
  items: TransferItem[];
}
interface StockRow { product_id: string; variant_id: string | null; balance: number }

/**
 * Phase 2: size-aware transfers. Proves that size (variant_id) flows through
 * the entire dispatch → arrive → receive lifecycle, that per-variant stock
 * ledgers move independently per can size, and that dispatch availability
 * checks are enforced per (product, variant) rather than per product.
 */
describe("Size-aware transfers — per-variant dispatch + receive", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let branch: Branch;

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

  function findRow(rows: StockRow[], productId: string, variantId: string): StockRow | undefined {
    return rows.find((r) => r.product_id === productId && r.variant_id === variantId);
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
      name: "Variant Test Branch",
      code: "VTEST",
      delivery_zones: [{ name: "Test zone", fee_ngn: 1000 }],
    });
    branch = bRes.body.data;

    // Factory rows aren't exposed via a CRUD endpoint yet; insert directly
    // through the test container's db connection.
    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Variant Test Factory" }).returning();
    factory = fac as Factory;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("size flows dispatch → receive: per-variant stock moves independently", async () => {
    // Create a flavour with two can sizes.
    const create = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Test Mango",
      slug: "test-mango",
      category: "regular",
      ingredients: ["Mango"],
      variants: [
        { size_ml: 330, price_ngn: 1500 },
        { size_ml: 1000, price_ngn: 3500 },
      ],
    });
    expect(create.status).toBe(201);
    const product = create.body.data;
    const v330 = product.variants.find((v) => v.size_ml === 330);
    const v1000 = product.variants.find((v) => v.size_ml === 1000);
    expect(v330).toBeDefined();
    expect(v1000).toBeDefined();
    const v330Id = v330!.id;
    const v1000Id = v1000!.id;

    // Give the factory per-size stock: 8x 330ml, 5x 1000ml.
    const adjust = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "opening_balance",
      items: [
        { product_id: product.id, variant_id: v330Id, new_quantity: 8 },
        { product_id: product.id, variant_id: v1000Id, new_quantity: 5 },
      ],
    });
    expect(adjust.status).toBe(201);

    // Dispatch 5x 330ml and 3x 1000ml.
    const dispatch = await call<{ data: Transfer }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [
        { product_id: product.id, variant_id: v330Id, quantity_sent: 5 },
        { product_id: product.id, variant_id: v1000Id, quantity_sent: 3 },
      ],
    });
    expect(dispatch.status).toBe(201);
    expect(dispatch.body.data.status).toBe("dispatched");
    const transferId = dispatch.body.data.id;

    // Arrive.
    const arrive = await call("PATCH", `/v1/transfers/${transferId}/arrive`);
    expect(arrive.status).toBe(200);

    // Fetch detail to get item ids + assert size_ml / variant_id on each line.
    const detail = await call<{ data: TransferDetail }>("GET", `/v1/transfers/${transferId}`);
    expect(detail.status).toBe(200);
    const items = detail.body.data.items;
    expect(items).toHaveLength(2);

    const item330 = items.find((i) => i.variant_id === v330Id);
    const item1000 = items.find((i) => i.variant_id === v1000Id);
    expect(item330).toBeDefined();
    expect(item1000).toBeDefined();
    expect(item330!.size_ml).toBe(330);
    expect(item1000!.size_ml).toBe(1000);
    expect(item330!.quantity_sent).toBe(5);
    expect(item1000!.quantity_sent).toBe(3);

    // Receive clean: quantity_received === quantity_sent for both lines.
    const receive = await call<{ data: Transfer }>("PATCH", `/v1/transfers/${transferId}/receive`, {
      items: [
        { item_id: item330!.id, quantity_received: 5 },
        { item_id: item1000!.id, quantity_received: 3 },
      ],
    });
    expect(receive.status).toBe(200);
    expect(receive.body.data.status).toBe("completed");

    // Factory stock: 8 - 5 = 3 for 330ml, 5 - 3 = 2 for 1000ml.
    const factoryStock = await call<{ data: StockRow[] }>("GET", `/v1/stock/factory/${factory.id}`);
    expect(factoryStock.status).toBe(200);
    expect(findRow(factoryStock.body.data, product.id, v330Id)?.balance).toBe(3);
    expect(findRow(factoryStock.body.data, product.id, v1000Id)?.balance).toBe(2);

    // Branch stock: 5 for 330ml, 3 for 1000ml.
    const branchStock = await call<{ data: StockRow[] }>("GET", `/v1/stock/branch/${branch.id}`);
    expect(branchStock.status).toBe(200);
    expect(findRow(branchStock.body.data, product.id, v330Id)?.balance).toBe(5);
    expect(findRow(branchStock.body.data, product.id, v1000Id)?.balance).toBe(3);
  });

  it("dispatch rejected when one variant's factory stock is insufficient", async () => {
    // Fresh flavour so this test doesn't depend on the stock state left by
    // the previous test.
    const create = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Test Pineapple",
      slug: "test-pineapple",
      category: "regular",
      ingredients: ["Pineapple"],
      variants: [
        { size_ml: 330, price_ngn: 1500 },
        { size_ml: 1000, price_ngn: 3500 },
      ],
    });
    expect(create.status).toBe(201);
    const product = create.body.data;
    const v330 = product.variants.find((v) => v.size_ml === 330)!;
    const v1000 = product.variants.find((v) => v.size_ml === 1000)!;

    // Give the factory a small amount of 330ml stock and plenty of 1000ml.
    const adjust = await call("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "opening_balance",
      items: [
        { product_id: product.id, variant_id: v330.id, new_quantity: 4 },
        { product_id: product.id, variant_id: v1000.id, new_quantity: 10 },
      ],
    });
    expect(adjust.status).toBe(201);

    // Attempt to dispatch far more 330ml than the factory holds.
    const dispatch = await call<{
      error?: { code: string; details?: { insufficient: Array<{ productId: string; variantId: string | null }> } };
    }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [
        { product_id: product.id, variant_id: v330.id, quantity_sent: 999 },
        { product_id: product.id, variant_id: v1000.id, quantity_sent: 2 },
      ],
    });

    expect(dispatch.status).toBe(422);
    expect(dispatch.body.error?.code).toBe("conflict");
    const insufficient = dispatch.body.error?.details?.insufficient ?? [];
    expect(insufficient.length).toBeGreaterThan(0);
    expect(
      insufficient.some((i) => i.productId === product.id && i.variantId === v330.id),
    ).toBe(true);
    // The 1000ml line had enough stock, so it should NOT be reported.
    expect(
      insufficient.some((i) => i.productId === product.id && i.variantId === v1000.id),
    ).toBe(false);
  });
});
