import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import {
  setupTestDb,
  seedOwner,
  seedUser,
  loginAs,
  setOnlineDefaultBranch,
} from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { branch, product, productVariant, productPrice } from "@ms/db";

/**
 * Integration test: retiring a single size (variant) hides it from the public
 * catalog; restoring brings it back. Guards: cannot retire the only active
 * size; a variant that belongs to a different product is rejected; the
 * endpoint requires products.manage.
 */
describe("product variant retire / restore", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerCookie: string;
  let productId: string;
  let v330: string;
  let v650: string;
  let otherProductId: string;
  let otherVariantId: string;

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

    const [prod] = await db
      .insert(product)
      .values({ name: "Retire Juice", slug: `retire-juice-${Date.now()}`, category: "regular" })
      .returning();
    if (!prod) throw new Error("product insert failed");
    productId = prod.id;

    const [a] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 330, sku: `RJ330-${Date.now()}` })
      .returning();
    const [b] = await db
      .insert(productVariant)
      .values({ productId, sizeMl: 650, sku: `RJ650-${Date.now()}` })
      .returning();
    if (!a || !b) throw new Error("variant insert failed");
    v330 = a.id;
    v650 = b.id;
    await db.insert(productPrice).values({ productId, variantId: v330, priceNgn: 2500 });
    await db.insert(productPrice).values({ productId, variantId: v650, priceNgn: 4000 });

    // A second single-variant product to test the last-active-size guard and
    // the cross-product rejection.
    const [other] = await db
      .insert(product)
      .values({ name: "Solo Juice", slug: `solo-juice-${Date.now()}`, category: "regular" })
      .returning();
    if (!other) throw new Error("other product insert failed");
    otherProductId = other.id;
    const [ov] = await db
      .insert(productVariant)
      .values({ productId: otherProductId, sizeMl: 330, sku: `SOLO330-${Date.now()}` })
      .returning();
    if (!ov) throw new Error("other variant insert failed");
    otherVariantId = ov.id;
    await db.insert(productPrice).values({ productId: otherProductId, variantId: otherVariantId, priceNgn: 3000 });

    const [br] = await db
      .insert(branch)
      .values({ name: "Retire Branch", code: `RB-${Date.now()}` })
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

  function patchVariant(pid: string, vid: string, isActive: boolean, cookie = ownerCookie) {
    return fetch(`${baseUrl}/v1/products/${pid}/variants/${vid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ is_active: isActive }),
    });
  }

  it("retiring the 330ml removes it from the public catalog", async () => {
    expect(await catalogVariantSizes(productId)).toEqual([330, 650]);
    const res = await patchVariant(productId, v330, false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; is_active: boolean; size_ml: number } };
    expect(body.data.is_active).toBe(false);
    expect(body.data.size_ml).toBe(330);
    expect(await catalogVariantSizes(productId)).toEqual([650]);
  });

  it("restoring the 330ml brings it back to the public catalog", async () => {
    const res = await patchVariant(productId, v330, true);
    expect(res.status).toBe(200);
    expect(await catalogVariantSizes(productId)).toEqual([330, 650]);
  });

  it("rejects retiring the only active size (422)", async () => {
    const res = await patchVariant(otherProductId, otherVariantId, false);
    expect(res.status).toBe(422);
    // The flavour is unchanged: its size is still in the catalog.
    expect(await catalogVariantSizes(otherProductId)).toEqual([330]);
  });

  it("rejects a variant that belongs to a different product (422)", async () => {
    const res = await patchVariant(productId, otherVariantId, false);
    expect(res.status).toBe(422);
  });

  it("requires authentication (401) and the products.manage capability (403)", async () => {
    const anon = await fetch(`${baseUrl}/v1/products/${productId}/variants/${v650}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(anon.status).toBe(401);

    await seedUser(db, { email: "staff-retire@example.com", role: "branch_staff", password: "staffpassword123" });
    const staffCookie = await loginAs(baseUrl, "staff-retire@example.com", "staffpassword123");
    const forbidden = await patchVariant(productId, v650, false, staffCookie);
    expect(forbidden.status).toBe(403);
  });
});
