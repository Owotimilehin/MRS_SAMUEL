import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import {
  idempotencyKey,
  saleOrder,
  stockLedger,
  productVariant,
  type DbClient,
} from "@ms/db";
import { makeTestApp, authOwner } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * A till sale whose request was cut off after the sale was saved (deploy,
 * crash). The till re-sends it under the same Idempotency-Key. It must get the
 * sale it already lodged, not a second sale and not an endless 500 from the
 * unique sale_order.idempotency_key.
 */
describe("POST sales: re-send of a sale that was saved by a request that never finished", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;
  let auth: Record<string, string>;
  let branchId: string;
  let saleBody: Record<string, unknown>;

  async function post(path: string, body: unknown, key: string): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, ...auth },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    ({ app, db, container } = await makeTestApp());
    auth = await authOwner(app);

    const b = await post("/v1/branches", { name: "Resend Branch", code: "RSND", delivery_zones: [] }, uuid());
    branchId = ((await b.json()) as { data: { id: string } }).data.id;
    const p = await post(
      "/v1/products",
      { name: "Resend Juice", slug: "resend-juice", category: "regular", initial_price_ngn: 2500 },
      uuid(),
    );
    const productId = ((await p.json()) as { data: { id: string } }).data.id;
    const [v] = await db.select().from(productVariant).where(eq(productVariant.productId, productId));
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branchId,
      productId,
      variantId: v!.id,
      delta: 50,
      sourceType: "adjustment",
      sourceId: uuid(),
    });
    saleBody = {
      channel: "walkup",
      items: [{ variant_id: v!.id, product_id: productId, quantity: 1 }],
      payment_method: "transfer",
      created_at_local: new Date().toISOString(),
    };
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  const salesForKey = (key: string) =>
    db.select().from(saleOrder).where(eq(saleOrder.idempotencyKey, key));

  it("returns the sale already lodged, once the abandoned claim can be taken over", async () => {
    const key = uuid();
    const first = await post(`/v1/branches/${branchId}/sales`, saleBody, key);
    expect(first.status).toBe(201);
    const lodged = ((await first.json()) as { data: { id: string; orderNumber: string } }).data;

    // As the cut-off request left it: sale committed, key still "in progress".
    await db
      .update(idempotencyKey)
      .set({ status: "in_progress", responseStatus: null, responseBody: null })
      .where(eq(idempotencyKey.key, key));

    // Straight away the till is told to wait (and, per the sync engine, retries later).
    const early = await post(`/v1/branches/${branchId}/sales`, saleBody, key);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_in_flight",
    );

    // Past the stale window the retry takes the key over and gets the same sale.
    await db
      .update(idempotencyKey)
      .set({ firstSeenAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(idempotencyKey.key, key));
    const retry = await post(`/v1/branches/${branchId}/sales`, saleBody, key);
    expect(retry.status).toBe(201);
    const again = ((await retry.json()) as { data: { id: string; orderNumber: string } }).data;
    expect(again.id).toBe(lodged.id);
    expect(again.orderNumber).toBe(lodged.orderNumber);

    expect(await salesForKey(key)).toHaveLength(1);
  });
});
