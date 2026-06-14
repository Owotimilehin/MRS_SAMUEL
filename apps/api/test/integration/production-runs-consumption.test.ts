import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Factory { id: string; name: string }
interface Product { id: string; slug: string }

/**
 * Task 4+6: hard-guard production run completion on bottle stock and
 * actually consume packaging stock per material (no more silent skips).
 */
describe("production run completion — bottle consumption hard guard", () => {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

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
    dbUrl = tdb.url;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  /** Create a 330ml packaging material, a product with a 330ml variant that
   *  auto-links to it (Task 3), and a fresh factory. Returns the ids needed
   *  to drive a production run. */
  async function setupFlavourAndFactory(label: string) {
    const material = await call<{ data: { id: string } }>("POST", "/v1/packaging/materials", {
      name: `${label} 330ml glass bottle`,
      unit_label: "bottle",
      size_ml: 330,
    });
    expect(material.status).toBe(201);
    const materialId = material.body.data.id;

    const product = await call<{ data: Product & { variants: Array<{ id: string; size_ml: number }> } }>(
      "POST",
      "/v1/products",
      {
        name: `${label} Sunrise`,
        slug: `${label}-sunrise`,
        category: "regular",
        ingredients: ["Carrot"],
        variants: [{ size_ml: 330, price_ngn: 2500 }],
      },
    );
    expect(product.status).toBe(201);
    const productId = product.body.data.id;
    const variantId = product.body.data.variants.find((v) => v.size_ml === 330)!.id;

    const { factory: factoryTable, createDbClient } = await import("@ms/db");
    const db = createDbClient(dbUrl);
    const [f] = await db.insert(factoryTable).values({ name: `${label} Factory` }).returning();
    const factory = f as Factory;

    return { materialId, productId, variantId, factory };
  }

  async function purchaseBottles(factoryId: string, materialId: string, quantity: number) {
    const purchase = await call("POST", "/v1/packaging/purchases", {
      factory_id: factoryId,
      packaging_material_id: materialId,
      quantity,
      unit_cost_ngn: 40,
      total_cost_ngn: 40 * quantity,
      purchase_date: "2026-06-01",
      feed_bookkeeping: false,
    });
    expect(purchase.status).toBe(201);
  }

  it("reduces bottle stock when a run with enough bottles completes", async () => {
    const { materialId, productId, variantId, factory } = await setupFlavourAndFactory("enough");
    await purchaseBottles(factory.id, materialId, 100);

    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-05",
    });
    expect(create.status).toBe(201);
    const runId = create.body.data.id;

    const append = await call("POST", `/v1/production-runs/${runId}/items`, {
      items: [{ product_id: productId, variant_id: variantId, quantity_produced: 30 }],
    });
    expect(append.status).toBe(200);

    const complete = await call("PATCH", `/v1/production-runs/${runId}/complete`);
    expect(complete.status).toBe(200);

    const stock = await call<{ data: Array<{ material_id: string; balance: number }> }>(
      "GET",
      `/v1/packaging/stock?factory_id=${factory.id}`,
    );
    const row = stock.body.data.find((r) => r.material_id === materialId);
    expect(row?.balance).toBe(70);
  });

  it("blocks completion and posts nothing when bottles are short", async () => {
    const { materialId, productId, variantId, factory } = await setupFlavourAndFactory("short");
    await purchaseBottles(factory.id, materialId, 10);

    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-06",
    });
    expect(create.status).toBe(201);
    const runId = create.body.data.id;

    const append = await call("POST", `/v1/production-runs/${runId}/items`, {
      items: [{ product_id: productId, variant_id: variantId, quantity_produced: 30 }],
    });
    expect(append.status).toBe(200);

    const complete = await call<{ error?: { code: string; details?: { reason?: string } } }>(
      "PATCH",
      `/v1/production-runs/${runId}/complete`,
    );
    expect(complete.status).toBe(422);
    const reason = complete.body.error?.details?.reason ?? "";
    expect(reason).toBe("packaging_insufficient");

    // Nothing posted: packaging balance unchanged at 10.
    const stock = await call<{ data: Array<{ material_id: string; balance: number }> }>(
      "GET",
      `/v1/packaging/stock?factory_id=${factory.id}`,
    );
    const row = stock.body.data.find((r) => r.material_id === materialId);
    expect(row?.balance).toBe(10);

    // Run is still draft.
    const detail = await call<{ data: { status: string } }>("GET", `/v1/production-runs/${runId}`);
    expect(detail.body.data.status).toBe("draft");

    // No finished-goods stock_ledger row posted for this run.
    const { stockLedger, createDbClient } = await import("@ms/db");
    const { eq, and, sql } = await import("drizzle-orm");
    const db = createDbClient(dbUrl);
    const [bal] = await db
      .select({ total: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)::int` })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.locationType, "factory"),
          eq(stockLedger.locationId, factory.id),
          eq(stockLedger.productId, productId),
        ),
      );
    expect(Number(bal?.total ?? 0)).toBe(0);
  });

  it("blocks completion when a line has no size", async () => {
    const { productId, factory } = await setupFlavourAndFactory("nosize");

    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-07",
    });
    expect(create.status).toBe(201);
    const runId = create.body.data.id;

    const append = await call("POST", `/v1/production-runs/${runId}/items`, {
      items: [{ product_id: productId, quantity_produced: 10 }],
    });
    expect(append.status).toBe(200);

    const complete = await call<{ error?: { code: string; details?: { reason?: string } } }>(
      "PATCH",
      `/v1/production-runs/${runId}/complete`,
    );
    expect(complete.status).toBe(422);
    const reason = complete.body.error?.details?.reason ?? "";
    expect(reason).toBe("missing_variant");
  });
});
