import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Factory { id: string; name: string }

describe("packaging consumption on production run completion", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let productId: string;
  let variantId: string;
  let materialId: string;

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

    const { factory: factoryTable, productVariant: pv, product: prod } = await import("@ms/db");
    const [f] = await tdb.db.insert(factoryTable).values({ name: "Cons Factory" }).returning();
    factory = f as Factory;

    const [p] = await tdb.db
      .insert(prod)
      .values({
        name: "Cons Sunrise",
        slug: "cons-sunrise",
        category: "regular",
        ingredients: ["x"],
      })
      .returning();
    productId = p!.id;
    const [v] = await tdb.db
      .insert(pv)
      .values({ productId, sizeMl: 330, sku: "cons-sunrise-330", isActive: true })
      .returning();
    variantId = v!.id;

    // Material + initial purchase of 1000 bottles so consumption has room.
    const mat = await call<{ data: { id: string } }>("POST", "/v1/packaging/materials", {
      name: "330ml glass bottle",
      unit_label: "bottle",
      size_ml: 330,
    });
    materialId = mat.body.data.id;
    await call("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: materialId,
      quantity: 1000,
      unit_cost_ngn: 40,
      total_cost_ngn: 40000,
      purchase_date: "2026-06-01",
      feed_bookkeeping: false,
    });

    // Link variant → material directly. The owner-facing endpoint for this
    // is deferred to a follow-up; manual link is fine for the test.
    const { eq } = await import("drizzle-orm");
    await tdb.db
      .update(pv)
      .set({ bottleMaterialId: materialId })
      .where(eq(pv.id, variantId));
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("completion with linked variant decrements packaging stock by quantity_produced", async () => {
    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-05",
      items: [{ product_id: productId, variant_id: variantId, quantity_produced: 200 }],
    });
    expect(create.status).toBe(201);
    const complete = await call("PATCH", `/v1/production-runs/${create.body.data.id}/complete`);
    expect(complete.status).toBe(200);

    const stock = await call<{ data: Array<{ material_id: string; balance: number }> }>(
      "GET",
      `/v1/packaging/stock?factory_id=${factory.id}`,
    );
    const row = stock.body.data.find((r) => r.material_id === materialId);
    expect(row?.balance).toBe(1000 - 200);
  });

  it("completion with variant_id but NO bottle_material_id link → 422 bottle_not_linked, no consumption", async () => {
    const { productVariant: pv, createDbClient } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const db = createDbClient(process.env.DATABASE_URL!);
    await db.update(pv).set({ bottleMaterialId: null }).where(eq(pv.id, variantId));

    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-06",
      items: [{ product_id: productId, variant_id: variantId, quantity_produced: 50 }],
    });
    const complete = await call<{ error?: { code: string; details?: { reason?: string } } }>(
      "PATCH",
      `/v1/production-runs/${create.body.data.id}/complete`,
    );
    expect(complete.status).toBe(422);
    expect(complete.body.error?.details?.reason ?? "").toBe("bottle_not_linked");

    // Balance unchanged from previous test (800) — nothing posted.
    const stock = await call<{ data: Array<{ material_id: string; balance: number }> }>(
      "GET",
      `/v1/packaging/stock?factory_id=${factory.id}`,
    );
    const row = stock.body.data.find((r) => r.material_id === materialId);
    expect(row?.balance).toBe(800);

    const detail = await call<{ data: { status: string } }>("GET", `/v1/production-runs/${create.body.data.id}`);
    expect(detail.body.data.status).toBe("draft");

    // Re-link for subsequent tests.
    await db.update(pv).set({ bottleMaterialId: materialId }).where(eq(pv.id, variantId));
  });

  it("completion with NULL variant_id → 422 missing_variant, no consumption", async () => {
    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-07",
      items: [{ product_id: productId, quantity_produced: 30 }],
    });
    const complete = await call<{ error?: { code: string; details?: { reason?: string } } }>(
      "PATCH",
      `/v1/production-runs/${create.body.data.id}/complete`,
    );
    expect(complete.status).toBe(422);
    expect(complete.body.error?.details?.reason ?? "").toBe("missing_variant");

    const stock = await call<{ data: Array<{ material_id: string; balance: number }> }>(
      "GET",
      `/v1/packaging/stock?factory_id=${factory.id}`,
    );
    const row = stock.body.data.find((r) => r.material_id === materialId);
    expect(row?.balance).toBe(800);

    const detail = await call<{ data: { status: string } }>("GET", `/v1/production-runs/${create.body.data.id}`);
    expect(detail.body.data.status).toBe("draft");
  });

  it("completion that would push packaging stock negative → 422 packaging_insufficient", async () => {
    const create = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-08",
      items: [{ product_id: productId, variant_id: variantId, quantity_produced: 10_000 }],
    });
    const complete = await call<{ error?: { code: string; details?: { reason?: string } } }>(
      "PATCH",
      `/v1/production-runs/${create.body.data.id}/complete`,
    );
    expect(complete.status).toBe(422);
    expect(complete.body.error?.details?.reason ?? "").toBe("packaging_insufficient");

    const detail = await call<{ data: { status: string } }>("GET", `/v1/production-runs/${create.body.data.id}`);
    expect(detail.body.data.status).toBe("draft");
  });
});
