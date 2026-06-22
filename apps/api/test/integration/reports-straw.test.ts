import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { productVariant, stockLedger, packagingMaterial, type createDbClient } from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("Daily P&L packaging breakdown — straw labeling", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: { id: string };
  let product: { id: string };
  let straw: string;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

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

    const bRes = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: "Straw Report Branch", code: "STRP", delivery_zones: [],
    });
    branch = bRes.body.data;
    const pRes = await call<{ data: { id: string } }>("POST", "/v1/products", {
      name: "Straw Report Juice", slug: "straw-report-juice", category: "regular", ingredients: ["Mango"], initial_price_ngn: 2500,
    });
    product = pRes.body.data;
    await db.update(productVariant).set({ preorderOnly: false }).where(eq(productVariant.productId, product.id));
    await db.insert(stockLedger).values({
      locationType: "branch", locationId: branch.id, productId: product.id,
      delta: 20, sourceType: "adjustment", sourceId: uuid(), note: "seed juice",
    });

    // Create a straw material directly (no straw is seeded by migrations).
    const [s] = await db.insert(packagingMaterial)
      .values({ name: "Straw", unitLabel: "straw", sizeMl: null, kind: "straw", isActive: true })
      .returning();
    straw = s!.id;

    const today = new Date().toISOString().slice(0, 10);
    const shiftRes = await call("POST", `/v1/branches/${branch.id}/shift-open`, { business_date: today, stock_counts: [] });
    if ((shiftRes as { status: number }).status !== 201) {
      throw new Error(`shift-open failed: ${JSON.stringify(shiftRes)}`);
    }

    const confirm = await call<{ data: { id: string } }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      packaging: [{ packaging_material_id: straw, quantity: 1 }],
      created_at_local: new Date().toISOString(),
    });
    if (confirm.status !== 201) {
      throw new Error(`sale create failed: ${JSON.stringify(confirm)}`);
    }
    const pay = await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    if ((pay as { status: number }).status !== 200) {
      throw new Error(`sale pay failed: ${JSON.stringify(pay)}`);
    }
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("packaging breakdown labels straws as kind=straw", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ data: { packaging_breakdown: Array<{ kind: string; units: number }> } }>(
      "GET", `/v1/reports/daily?date=${today}`,
    );
    expect(res.status).toBe(200);
    const strawLine = res.body.data.packaging_breakdown.find((b) => b.kind === "straw");
    expect(strawLine).toBeDefined();
    expect(strawLine!.units).toBe(1);
  });
});
