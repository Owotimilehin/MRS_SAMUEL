import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, seedUser, loginAs, setOnlineDefaultBranch } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch, product, productVariant, productPrice } from "@ms/db";
import { eq, and, isNull } from "drizzle-orm";

/**
 * Integration test: adding a new size (variant) to a flavour that already
 * exists. The size + price are created, appear in the public catalog, and are
 * gated on products.manage. Adding a size the flavour already has is rejected.
 */
describe("add a size to an existing flavour", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerCookie: string;
  let productId: string;
  let slug: string;

  async function catalogVariantSizes(pid: string): Promise<number[]> {
    const res = await fetch(`${baseUrl}/v1/public/catalog/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; variants: Array<{ size_ml: number }> }>;
    };
    const p = body.data.find((x) => x.id === pid);
    return (p?.variants ?? []).map((v) => v.size_ml).sort((a, b) => a - b);
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);

    slug = `add-size-juice-${Date.now()}`;
    const [prod] = await db
      .insert(product)
      .values({ name: "Add Size Juice", slug, category: "regular" })
      .returning();
    if (!prod) throw new Error("product insert failed");
    productId = prod.id;

    // Flavour starts with only a 330ml.
    const [a] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 330, sku: `ASJ330-${Date.now()}` })
      .returning();
    if (!a) throw new Error("variant insert failed");
    await db.insert(productPrice).values({ productId, variantId: a.id, priceNgn: 2500 });

    const [br] = await db
      .insert(branch)
      .values({ name: "Add Size Branch", code: `ASB-${Date.now()}` })
      .returning();
    if (!br) throw new Error("branch insert failed");
    await setOnlineDefaultBranch(db, br.id);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  function addVariant(pid: string, body: unknown, cookie = ownerCookie) {
    return fetch(`${baseUrl}/v1/products/${pid}/variants`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  }

  it("adds a new 650ml size with its price and lists it in the catalog", async () => {
    expect(await catalogVariantSizes(productId)).toEqual([330]);

    const res = await addVariant(productId, { size_ml: 650, price_ngn: 4500 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; size_ml: number; price_ngn: number; is_active: boolean };
    };
    expect(body.data.size_ml).toBe(650);
    expect(body.data.price_ngn).toBe(4500);
    expect(body.data.is_active).toBe(true);

    // The new size has a live price row and (when a bottle material exists) a
    // bottle_material_id — mirrors how POST /products creates variants.
    const [priceRow] = await db
      .select()
      .from(productPrice)
      .where(and(eq(productPrice.variantId, body.data.id), isNull(productPrice.validTo)));
    expect(priceRow?.priceNgn).toBe(4500);

    expect(await catalogVariantSizes(productId)).toEqual([330, 650]);
  });

  it("rejects a size the flavour already has (422)", async () => {
    const res = await addVariant(productId, { size_ml: 330, price_ngn: 3000 });
    expect(res.status).toBe(422);
    expect(await catalogVariantSizes(productId)).toEqual([330, 650]);
  });

  it("resurrects a soft-deleted size (deleted_at set) instead of dead-ending on Restore", async () => {
    // Simulate the state left by a direct-DB catalog cleanup: a size whose
    // deleted_at is set. Such a row is hidden from the admin list AND rejected
    // by the Restore endpoint, so "Add a size" must bring it back rather than
    // sending the owner to an impossible Restore.
    const [gone] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 1000, sku: `ASJ1000-${Date.now()}`, isActive: false, deletedAt: new Date() })
      .returning();
    if (!gone) throw new Error("variant insert failed");
    // A stale price row survives the soft-delete, as it does in production.
    await db.insert(productPrice).values({ productId, variantId: gone.id, priceNgn: 4500 });

    const res = await addVariant(productId, { size_ml: 1000, price_ngn: 5000 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; size_ml: number; price_ngn: number; is_active: boolean };
    };
    expect(body.data.size_ml).toBe(1000);
    expect(body.data.price_ngn).toBe(5000);
    expect(body.data.is_active).toBe(true);
    // The resurrected row is the same variant, not a duplicate.
    expect(body.data.id).toBe(gone.id);

    // Exactly one live price row, at the newly-entered price.
    const openPrices = await db
      .select()
      .from(productPrice)
      .where(and(eq(productPrice.variantId, gone.id), isNull(productPrice.validTo)));
    expect(openPrices).toHaveLength(1);
    expect(openPrices[0]?.priceNgn).toBe(5000);

    // It comes back in the public catalog.
    expect(await catalogVariantSizes(productId)).toContain(1000);
  });

  it("rejects an unknown product (404)", async () => {
    const res = await addVariant("00000000-0000-0000-0000-000000000000", {
      size_ml: 500,
      price_ngn: 3000,
    });
    expect(res.status).toBe(404);
  });

  it("requires authentication (401) and the products.manage capability (403)", async () => {
    const anon = await fetch(`${baseUrl}/v1/products/${productId}/variants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size_ml: 500, price_ngn: 3000 }),
    });
    expect(anon.status).toBe(401);

    await seedUser(db, {
      email: "staff-addsize@example.com",
      role: "branch_staff",
      password: "staffpassword123",
    });
    const staffCookie = await loginAs(baseUrl, "staff-addsize@example.com", "staffpassword123");
    const forbidden = await addVariant(productId, { size_ml: 500, price_ngn: 3000 }, staffCookie);
    expect(forbidden.status).toBe(403);
  });
});
