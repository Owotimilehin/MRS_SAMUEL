import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import {
  packagingStockLedger,
  packagingBalanceAt,
  outboxEvent,
  factory as factoryTable,
  type createDbClient,
} from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Owner-initiated manual packaging stock adjustment. The owner enters the
 * actual on-hand count ("set new count"); the server computes the delta vs
 * the current balance and writes a single `adjustment` ledger row with a
 * required reason. No bookkeeping/expense side-effect.
 */
describe("packaging stock adjustment", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let factory: { id: string };
  let materialId: string;

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

  const balance = (): Promise<number> =>
    packagingBalanceAt(db, { locationType: "factory", locationId: factory.id }, materialId);

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Adjust Factory" }).returning();
    factory = fac as { id: string };

    const matRes = await call<{ data: { id: string } }>("POST", "/v1/packaging/materials", {
      name: "Test 330ml bottle",
      unit_label: "bottle",
      size_ml: 330,
      kind: "bottle",
    });
    materialId = matRes.body.data.id;

    // Opening balance of 100.
    await tdb.db.insert(packagingStockLedger).values({
      locationType: "factory",
      locationId: factory.id,
      factoryId: factory.id,
      packagingMaterialId: materialId,
      delta: 100,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("adjusts the count down and records a negative delta", async () => {
    expect(await balance()).toBe(100);
    const res = await call("POST", "/v1/packaging/adjust", {
      location_type: "factory",
      location_id: factory.id,
      packaging_material_id: materialId,
      new_count: 85,
      reason: "breakage",
      note: "carton dropped",
    });
    expect(res.status).toBe(201);
    expect(await balance()).toBe(85);
  });

  it("adjusts the count up and records a positive delta", async () => {
    const res = await call("POST", "/v1/packaging/adjust", {
      location_type: "factory",
      location_id: factory.id,
      packaging_material_id: materialId,
      new_count: 120,
      reason: "count_correction",
    });
    expect(res.status).toBe(201);
    expect(await balance()).toBe(120);
  });

  it("rejects a no-op (new_count equals current balance)", async () => {
    const res = await call<{ error?: { code: string } }>("POST", "/v1/packaging/adjust", {
      location_type: "factory",
      location_id: factory.id,
      packaging_material_id: materialId,
      new_count: 120,
      reason: "count_correction",
    });
    expect(res.status).toBe(400);
    expect(await balance()).toBe(120);
  });

  it("rejects a negative new_count", async () => {
    const res = await call("POST", "/v1/packaging/adjust", {
      location_type: "factory",
      location_id: factory.id,
      packaging_material_id: materialId,
      new_count: -5,
      reason: "count_correction",
    });
    expect([400, 422]).toContain(res.status);
    expect(await balance()).toBe(120);
  });

  it("rejects a missing reason", async () => {
    const res = await call("POST", "/v1/packaging/adjust", {
      location_type: "factory",
      location_id: factory.id,
      packaging_material_id: materialId,
      new_count: 50,
    });
    expect([400, 422]).toContain(res.status);
    expect(await balance()).toBe(120);
  });

  it("emits a packaging.stock_adjusted outbox event", async () => {
    const rows = await db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, "packaging.stock_adjusted"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload["material_name"]).toBe("Test 330ml bottle");
    expect(payload["location_type"]).toBe("factory");
    expect(typeof payload["delta"]).toBe("number");
  });
});
