import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, seedCatalog, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch, factory, product, productVariant, productPrice, stockLedger } from "@ms/db";

/**
 * /reports/overview low-stock counts are per (location, size), use each size's
 * low_stock_level (default 10), include sizes at 0, and skip retired sizes.
 * Also: PATCH /products/:id/variants/:variantId sets and clears the level.
 */
describe("low stock per location with per-size alert levels", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let cookie: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let productId: string;
  let v330: string;
  let v650: string;
  let branchA: string;
  let branchB: string;
  let factoryId: string;

  const stock = (locationType: "branch" | "factory", locationId: string, variantId: string, delta: number) =>
    db.insert(stockLedger).values({
      locationType,
      locationId,
      productId,
      variantId,
      delta,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
    const cat = await seedCatalog(db);
    productId = cat.productId;
    v330 = cat.variantId;
    branchA = cat.branchId;
    const [v] = await db.insert(productVariant).values({ productId, sizeMl: 650, sku: `TJ650-${Date.now()}` }).returning();
    v650 = v!.id;
    await db.insert(productPrice).values({ productId, variantId: v650, priceNgn: 4000 });
    const [b2] = await db.insert(branch).values({ name: "Branch B", code: `BB-${Date.now()}` }).returning();
    branchB = b2!.id;
    const [f] = await db.insert(factory).values({ name: "Main Factory" }).returning();
    factoryId = f!.id;

    // A retired flavour's stock must never count.
    const [retired] = await db
      .insert(product)
      .values({ name: "Old Juice", slug: `old-${Date.now()}`, category: "regular", isActive: false })
      .returning();
    const [rv] = await db.insert(productVariant).values({ productId: retired!.id, sizeMl: 330, sku: `OJ-${Date.now()}` }).returning();
    await db.insert(stockLedger).values({
      locationType: "branch", locationId: branchA, productId: retired!.id, variantId: rv!.id,
      delta: 1, sourceType: "opening_balance", sourceId: uuid(),
    });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  const overview = async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as {
      data: {
        stock: {
          low_stock_factory: number;
          low_stock_branch: number;
          low_stock_items: Array<{ location_id: string; variant_id: string; balance: number; level: number; location_name: string }>;
        };
      };
    }).data.stock;
  };

  const setLevel = (variantId: string, level: number | null) =>
    fetch(`${baseUrl}/v1/products/${productId}/variants/${variantId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ low_stock_level: level }),
    });

  it("counts each location separately, includes zero stock, and honours a custom level", async () => {
    // Branch A 330ml: 8 (low at default 10). Branch B 330ml: sold out (5 in, 5 out = 0).
    await stock("branch", branchA, v330, 8);
    await stock("branch", branchB, v330, 5);
    await stock("branch", branchB, v330, -5);
    // Branch A 650ml: 20 (fine at default). Factory 650ml: 30 (fine at default).
    await stock("branch", branchA, v650, 20);
    await stock("factory", factoryId, v650, 30);

    let s = await overview();
    expect(s.low_stock_branch).toBe(2); // A/330 at 8 and B/330 at 0
    expect(s.low_stock_factory).toBe(0);
    expect(s.low_stock_items[0]).toMatchObject({ location_id: branchB, variant_id: v330, balance: 0, level: 10 });

    // Raise the 650ml level to 25: branch A (20) becomes low; factory (30) does not.
    const res = await setLevel(v650, 25);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { low_stock_level: number } }).data.low_stock_level).toBe(25);
    s = await overview();
    expect(s.low_stock_branch).toBe(3);
    expect(s.low_stock_factory).toBe(0);
    expect(s.low_stock_items.find((i) => i.variant_id === v650)).toMatchObject({ balance: 20, level: 25 });

    // Level 0 on 330ml: only the empty shelf (branch B) stays low.
    expect((await setLevel(v330, 0)).status).toBe(200);
    s = await overview();
    expect(s.low_stock_branch).toBe(2);

    // Clear it (null = default 10 again).
    expect((await setLevel(v330, null)).status).toBe(200);
    s = await overview();
    expect(s.low_stock_branch).toBe(3);
  });

  it("rejects a negative or fractional level and shows the level on the product", async () => {
    expect((await setLevel(v330, -1)).status).toBe(400);
    expect((await setLevel(v330, 2.5)).status).toBe(400);
    const res = await fetch(`${baseUrl}/v1/products/${productId}`, { headers: { cookie } });
    const body = (await res.json()) as { data: { variants: Array<{ id: string; low_stock_level: number | null }> } };
    expect(body.data.variants.find((v) => v.id === v650)?.low_stock_level).toBe(25);
    expect(body.data.variants.find((v) => v.id === v330)?.low_stock_level).toBeNull();
  });
});
