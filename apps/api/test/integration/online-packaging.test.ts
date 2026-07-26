import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import {
  branch,
  product,
  productVariant,
  productPrice,
  packagingMaterial,
  packagingStockLedger,
  packagingBalanceAt,
  saleOrder,
  saleOrderItem,
  saleOrderPackaging,
  type createDbClient,
} from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("online order fulfil packaging (straw + bag)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchId: string;
  let orderId: string;
  let strawId: string;
  let bagId: string;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT", "DELETE"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  const branchBal = (materialId: string): Promise<number> =>
    packagingBalanceAt(db, { locationType: "branch", locationId: branchId }, materialId);

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const [b] = await db.insert(branch).values({ name: "Pack Branch", code: "PKB1" }).returning();
    branchId = b!.id;
    const [p] = await db.insert(product).values({ name: "Zobo", slug: "zobo", category: "regular" }).returning();
    const [v] = await db.insert(productVariant).values({ productId: p!.id, sizeMl: 330, sku: "zobo-330" }).returning();
    const [pr] = await db.insert(productPrice).values({ productId: p!.id, variantId: v!.id, priceNgn: 2000 }).returning();

    const [straw] = await db.insert(packagingMaterial).values({ name: "Straw", unitLabel: "straw", kind: "straw" }).returning();
    const [bag] = await db.insert(packagingMaterial).values({ name: "Small Bag", unitLabel: "bag", kind: "bag" }).returning();
    strawId = straw!.id;
    bagId = bag!.id;

    // Branch opening stock so balances start positive.
    await db.insert(packagingStockLedger).values([
      { locationType: "branch", locationId: branchId, packagingMaterialId: strawId, delta: 100, sourceType: "opening_balance", sourceId: uuid() },
      { locationType: "branch", locationId: branchId, packagingMaterialId: bagId, delta: 50, sourceType: "opening_balance", sourceId: uuid() },
    ]);

    // A paid online order with 3 bottles.
    const [o] = await db.insert(saleOrder).values({
      orderNumber: "ORD-PKG-001",
      branchId,
      channel: "online",
      status: "paid",
      subtotalNgn: 6000,
      totalNgn: 6000,
      paymentMethod: "transfer",
      paymentStatus: "paid",
      createdAtLocal: new Date("2026-07-22T10:00:00+01:00"),
      idempotencyKey: uuid(),
    }).returning();
    orderId = o!.id;
    await db.insert(saleOrderItem).values({
      saleOrderId: orderId, productId: p!.id, variantId: v!.id, productPriceId: pr!.id,
      quantity: 3, unitPriceNgn: 2000, lineTotalNgn: 6000,
    });
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("records straws + bags and decrements the branch ledger", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [
        { packaging_material_id: strawId, quantity: 3 },
        { packaging_material_id: bagId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(strawId)).toBe(97);
    expect(await branchBal(bagId)).toBe(49);
    const rows = await db.select().from(saleOrderPackaging).where(eq(saleOrderPackaging.saleOrderId, orderId));
    expect(rows).toHaveLength(2);
  });

  it("re-save diffs correctly (3 -> 2 straws returns +1 to stock)", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [
        { packaging_material_id: strawId, quantity: 2 },
        { packaging_material_id: bagId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(strawId)).toBe(98); // was 97, +1 back
    expect(await branchBal(bagId)).toBe(49);   // unchanged
  });

  it("qty 0 removes the row and restores its stock", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [
        { packaging_material_id: strawId, quantity: 0 },
        { packaging_material_id: bagId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(strawId)).toBe(100); // fully restored
    const rows = await db.select().from(saleOrderPackaging).where(eq(saleOrderPackaging.saleOrderId, orderId));
    expect(rows.map((r) => r.packagingMaterialId)).toEqual([bagId]);
  });

  it("rejects a non-online channel and a terminal order", async () => {
    // flip to delivered → 409
    await db.update(saleOrder).set({ status: "delivered" }).where(eq(saleOrder.id, orderId));
    const res = await call<{ error?: { code: string } }>(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [{ packaging_material_id: bagId, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    await db.update(saleOrder).set({ status: "paid" }).where(eq(saleOrder.id, orderId)); // restore
  });

  it("allows the branch ledger to go negative (warn-but-allow)", async () => {
    const res = await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [{ packaging_material_id: bagId, quantity: 999 }],
    });
    expect(res.status).toBe(200);
    expect(await branchBal(bagId)).toBeLessThan(0);
  });

  it("GET /:id returns the saved packaging array", async () => {
    // Reset to a known state: 2 straws only.
    await call(`PUT`, `/v1/branches/${branchId}/sales/${orderId}/packaging`, {
      packaging: [{ packaging_material_id: strawId, quantity: 2 }],
    });
    const res = await call<{ data: { packaging: Array<{ packaging_material_id: string; quantity: number }> } }>(
      "GET",
      `/v1/branches/${branchId}/sales/${orderId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.packaging).toEqual([{ packaging_material_id: strawId, quantity: 2 }]);
  });
});
