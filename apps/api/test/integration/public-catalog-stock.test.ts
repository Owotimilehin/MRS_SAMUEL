import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import {
  setupTestDb,
  seedOwner,
  setOnlineDefaultBranch,
} from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch, product, productVariant, productPrice, stockLedger } from "@ms/db";

/**
 * Integration test: public catalog exposes per-variant `available` count.
 *
 * Seeds one product with two variants (330 ml and 650 ml) against an
 * online-default branch, inserts stock_ledger rows so:
 *   - 650 ml variant has balance 5
 *   - 330 ml variant has balance 0
 *
 * Asserts that GET /v1/public/catalog/products returns those exact values
 * on each variant's `available` field.
 */
describe("public catalog – per-variant available count", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let productId: string;
  let variant330Id: string;
  let variant650Id: string;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);

    // Seed one product with a 330 ml and a 650 ml variant.
    const [prod] = await db
      .insert(product)
      .values({ name: "Stock Juice", slug: `stock-juice-${Date.now()}`, category: "regular" })
      .returning();
    if (!prod) throw new Error("product insert failed");
    productId = prod.id;

    const [v330] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 330, sku: `SJ330-${Date.now()}` })
      .returning();
    if (!v330) throw new Error("330 variant insert failed");
    variant330Id = v330.id;

    const [v650] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 650, sku: `SJ650-${Date.now()}` })
      .returning();
    if (!v650) throw new Error("650 variant insert failed");
    variant650Id = v650.id;

    // Price both variants (required so they appear in the catalog).
    await db.insert(productPrice).values({ productId, variantId: variant330Id, priceNgn: 2500 });
    await db.insert(productPrice).values({ productId, variantId: variant650Id, priceNgn: 4000 });

    // Create a branch and mark it as the online-default.
    const [br] = await db
      .insert(branch)
      .values({ name: "Stock Test Branch", code: `STB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("branch insert failed");
    await setOnlineDefaultBranch(db, br.id);

    // Seed per-variant stock: 650 ml gets 5 units; 330 ml gets 0 (no ledger row needed).
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: br.id,
      productId,
      variantId: variant650Id,
      delta: 5,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });

    // Build and serve the app.
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  it("returns available=5 for the 650 ml variant", async () => {
    const res = await fetch(`${baseUrl}/v1/public/catalog/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        variants: Array<{ id: string; size_ml: number; available: number }>;
      }>;
    };
    const prod = body.data.find((p) => p.id === productId);
    expect(prod).toBeDefined();
    const v650 = prod!.variants.find((v) => v.size_ml === 650);
    expect(v650).toBeDefined();
    expect(v650!.available).toBe(5);
  });

  it("returns available=0 for the 330 ml variant (no stock)", async () => {
    const res = await fetch(`${baseUrl}/v1/public/catalog/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        variants: Array<{ id: string; size_ml: number; available: number }>;
      }>;
    };
    const prod = body.data.find((p) => p.id === productId);
    expect(prod).toBeDefined();
    const v330 = prod!.variants.find((v) => v.size_ml === 330);
    expect(v330).toBeDefined();
    expect(v330!.available).toBe(0);
  });

  it("also returns per-variant available on the single-product slug endpoint", async () => {
    const res = await fetch(`${baseUrl}/v1/public/catalog/products/stock-juice-${productId.slice(0, 8)}`);
    // The slug might not match exactly since we used Date.now(); fetch the list and get the slug.
    // Instead, let's re-fetch via the list and confirm the shape is correct for both endpoints.
    // This test ensures the /products/:slug endpoint also returns per-variant available.
    const listRes = await fetch(`${baseUrl}/v1/public/catalog/products`);
    const listBody = (await listRes.json()) as {
      data: Array<{ id: string; slug: string; variants: Array<{ id: string; size_ml: number; available: number }> }>;
    };
    const prod = listBody.data.find((p) => p.id === productId);
    expect(prod).toBeDefined();
    const slugRes = await fetch(`${baseUrl}/v1/public/catalog/products/${prod!.slug}`);
    expect(slugRes.status).toBe(200);
    const slugBody = (await slugRes.json()) as {
      data: { id: string; variants: Array<{ id: string; size_ml: number; available: number }> };
    };
    expect(slugBody.data.id).toBe(productId);
    const v650 = slugBody.data.variants.find((v) => v.size_ml === 650);
    expect(v650).toBeDefined();
    expect(v650!.available).toBe(5);
    const v330 = slugBody.data.variants.find((v) => v.size_ml === 330);
    expect(v330).toBeDefined();
    expect(v330!.available).toBe(0);
  });
});
