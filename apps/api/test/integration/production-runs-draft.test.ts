import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Product { id: string; slug: string; variants: Array<{ id: string; size_ml: number }> }
interface Factory { id: string; name: string }
interface RunItem {
  id: string;
  productId: string;
  quantityProduced: number;
  batchCode: string | null;
}
interface Run {
  id: string;
  factoryId: string;
  runDate: string;
  status: "draft" | "completed";
  items: RunItem[];
}

/**
 * Exercises the draft-resume flow added to production runs:
 *  - POST /production-runs accepts a body with no items (draft).
 *  - GET /production-runs/open returns today's draft for a factory.
 *  - POST /:id/items appends flavours one at a time.
 *  - PATCH /:id/items/:itemId edits a draft line.
 *  - DELETE /:id/items/:itemId removes a draft line.
 *  - PATCH /:id/complete refuses an empty draft (422).
 *  - All write endpoints reject edits once the run is completed.
 */
describe("production runs — draft + append flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let prodA: Product;
  let prodB: Product;
  let variantAId: string;
  let variantBId: string;

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
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Test Factory" }).returning();
    factory = fac as Factory;

    // A 330ml bottle material must exist BEFORE the products are created so
    // their (legacy, defaulted-to-330ml) variants auto-link to it (Task 3).
    // Completion now hard-guards on bottle stock, so give the factory plenty.
    const material = await call<{ data: { id: string } }>("POST", "/v1/packaging/materials", {
      name: "Draft-flow 330ml glass bottle",
      unit_label: "bottle",
      size_ml: 330,
    });
    const materialId = material.body.data.id;
    await call("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: materialId,
      quantity: 1000,
      unit_cost_ngn: 40,
      total_cost_ngn: 40000,
      purchase_date: "2026-06-01",
      feed_bookkeeping: false,
    });

    const a = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Sunrise A",
      slug: "sunrise-a",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    });
    prodA = a.body.data;
    variantAId = prodA.variants.find((v) => v.size_ml === 330)!.id;
    const b = await call<{ data: Product }>("POST", "/v1/products", {
      name: "Sunrise B",
      slug: "sunrise-b",
      category: "regular",
      ingredients: ["Orange"],
      initial_price_ngn: 2500,
    });
    prodB = b.body.data;
    variantBId = prodB.variants.find((v) => v.size_ml === 330)!.id;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("creates an empty draft, finds it via /open, appends, edits, deletes, and completes", async () => {
    const runDate = "2026-06-02";

    // 1. Create draft with no items
    const created = await call<{ data: Run }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: runDate,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("draft");
    expect(created.body.data.items).toEqual([]);
    const runId = created.body.data.id;

    // 2. GET /open returns it
    const open = await call<{ data: Run | null }>(
      "GET",
      `/v1/production-runs/open?factory_id=${factory.id}&run_date=${runDate}`,
    );
    expect(open.status).toBe(200);
    expect(open.body.data?.id).toBe(runId);

    // 3. Cannot complete an empty draft
    const tooEarly = await call("PATCH", `/v1/production-runs/${runId}/complete`);
    expect(tooEarly.status).toBe(422);

    // 4. Append flavour A
    const appendA = await call<{ data: Run }>("POST", `/v1/production-runs/${runId}/items`, {
      items: [{ product_id: prodA.id, variant_id: variantAId, quantity_produced: 50, batch_code: "A1" }],
    });
    expect(appendA.status).toBe(200);
    expect(appendA.body.data.items).toHaveLength(1);
    const itemAId = appendA.body.data.items[0]!.id;

    // 5. Append flavour B
    const appendB = await call<{ data: Run }>("POST", `/v1/production-runs/${runId}/items`, {
      items: [{ product_id: prodB.id, variant_id: variantBId, quantity_produced: 30 }],
    });
    expect(appendB.status).toBe(200);
    expect(appendB.body.data.items).toHaveLength(2);
    const itemBId = appendB.body.data.items.find((i) => i.productId === prodB.id)!.id;

    // 6. Edit flavour A quantity
    const edit = await call<{ data: { quantityProduced: number } }>(
      "PATCH",
      `/v1/production-runs/${runId}/items/${itemAId}`,
      { quantity_produced: 60 },
    );
    expect(edit.status).toBe(200);
    expect(edit.body.data.quantityProduced).toBe(60);

    // 7. Delete flavour B
    const del = await call("DELETE", `/v1/production-runs/${runId}/items/${itemBId}`);
    expect(del.status).toBe(200);

    // 8. Complete the run — now has 1 item, should succeed
    const done = await call<{ data: Run }>("PATCH", `/v1/production-runs/${runId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("completed");
    // The /complete response MUST carry items — the admin UI renders
    // `run.items` immediately after and crashes if it is undefined.
    expect(done.body.data.items).toHaveLength(1);

    // 9. Editing items on a completed run is blocked
    const blocked = await call("PATCH", `/v1/production-runs/${runId}/items/${itemAId}`, {
      quantity_produced: 999,
    });
    expect(blocked.status).toBe(409);
  });

  it("GET /open returns null when no draft exists for that date", async () => {
    const res = await call<{ data: Run | null }>(
      "GET",
      `/v1/production-runs/open?factory_id=${factory.id}&run_date=2020-01-01`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("GET /open returns 400 when factory_id or run_date missing", async () => {
    const res = await call("GET", "/v1/production-runs/open");
    expect(res.status).toBe(400);
  });
});
