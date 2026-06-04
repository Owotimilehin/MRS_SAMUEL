import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Factory { id: string; name: string }
interface Product { id: string; slug: string }

describe("inventory adjustments history", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: Factory;
  let product: Product;
  let firstAdjustmentId: string;

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

    const { factory: factoryTable } = await import("@ms/db");
    const [f] = await tdb.db.insert(factoryTable).values({ name: "History Factory" }).returning();
    factory = f as Factory;

    const p = await call<{ data: Product }>("POST", "/v1/products", {
      name: "History Sunrise",
      slug: "history-sunrise",
      category: "regular",
      ingredients: ["x"],
      initial_price_ngn: 2500,
    });
    product = p.body.data;

    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-06-01",
      items: [{ product_id: product.id, quantity_produced: 100 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);

    const adj = await call<{ data: { id: string } }>("POST", "/v1/inventory/adjust", {
      location_type: "factory",
      location_id: factory.id,
      reason_code: "physical_recount",
      items: [{ product_id: product.id, new_quantity: 95 }],
    });
    firstAdjustmentId = adj.body.data.id;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("returns the recent adjustment with its line", async () => {
    const res = await call<{
      data: Array<{
        id: string;
        location_type: string;
        reason_code: string;
        lines: Array<{ product_id: string; product_name: string; delta: number }>;
      }>;
      pagination: { total: number };
    }>("GET", `/v1/inventory/adjustments?from=2026-06-01&to=2026-06-30`);
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    const adj = res.body.data.find((a) => a.id === firstAdjustmentId);
    expect(adj).toBeDefined();
    expect(adj!.location_type).toBe("factory");
    expect(adj!.reason_code).toBe("physical_recount");
    expect(adj!.lines.length).toBe(1);
    expect(adj!.lines[0]!.product_id).toBe(product.id);
    expect(adj!.lines[0]!.product_name).toBe("History Sunrise");
    expect(adj!.lines[0]!.delta).toBe(-5);
  });

  it("filters by location_type", async () => {
    const factories = await call<{ data: Array<{ id: string }> }>(
      "GET",
      `/v1/inventory/adjustments?from=2026-06-01&to=2026-06-30&location_type=factory`,
    );
    expect(factories.body.data.some((a) => a.id === firstAdjustmentId)).toBe(true);

    const branches = await call<{ data: Array<{ id: string }> }>(
      "GET",
      `/v1/inventory/adjustments?from=2026-06-01&to=2026-06-30&location_type=branch`,
    );
    expect(branches.body.data.some((a) => a.id === firstAdjustmentId)).toBe(false);
  });

  it("unauthenticated caller cannot list adjustments", async () => {
    const res = await fetch(`${baseUrl}/v1/inventory/adjustments`);
    expect([401, 403]).toContain(res.status);
  });
});
