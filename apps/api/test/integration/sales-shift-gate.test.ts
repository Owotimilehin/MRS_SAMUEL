import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { shiftOpen, stockLedger, type DbClient } from "@ms/db";
import { eq } from "drizzle-orm";

/**
 * Task 6 (Phase 2): Sale-creation open-shift gate.
 *
 * (a) POST walk-up sale with NO open shift → 409, code "conflict"
 * (b) Open a shift, POST again → 201 success
 * (c) Preorder create with NO open shift → 409
 */
describe("Task 6: sale-creation open-shift gate", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let db: DbClient;
  let branchId: string;
  let productId: string;
  let variantId: string;

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
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  /** Open a shift for the given branch via the API. */
  async function openShiftForBranch(bid: string, date: string): Promise<string> {
    const res = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${bid}/shift-open`,
      { business_date: date, stock_counts: [] },
    );
    if (res.status !== 201) {
      throw new Error(`openShift failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.id;
  }

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

    // Create branch
    const bRes = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: "Shift Gate Branch",
      code: "SGB",
      delivery_zones: [],
    });
    branchId = bRes.body.data.id;

    // Create product
    const pRes = await call<{ data: { id: string; variants?: Array<{ id: string; size_ml: number }> } }>(
      "POST",
      "/v1/products",
      {
        name: "Shift Gate Juice",
        slug: "shift-gate-juice",
        category: "regular",
        ingredients: ["Orange"],
        initial_price_ngn: 2500,
      },
    );
    productId = pRes.body.data.id;
    // Grab the auto-created variant
    const { productVariant } = await import("@ms/db");
    const [v] = await db.select().from(productVariant).where(
      eq(productVariant.productId, productId),
    );
    if (!v) throw new Error("variant not found");
    variantId = v.id;

    // Seed branch stock directly (bypasses production pipeline)
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branchId,
      productId,
      variantId,
      delta: 50,
      sourceType: "adjustment",
      sourceId: uuid(),
      note: "Task 6 test seed",
    });
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  // (a) Walk-up sale with NO open shift → 409
  it("(a) walk-up sale with no open shift → 409 conflict", async () => {
    // Confirm there is no open shift for this branch
    const openShifts = await db
      .select()
      .from(shiftOpen)
      .where(eq(shiftOpen.branchId, branchId));
    // Either no rows or all closed
    const hasOpen = openShifts.some((s) => s.status === "open");
    expect(hasOpen).toBe(false);

    const res = await call<{ error: { code: string; message: string } }>(
      "POST",
      `/v1/branches/${branchId}/sales`,
      {
        channel: "walkup",
        items: [{ variant_id: variantId, product_id: productId, quantity: 1 }],
        payment_method: "transfer",
        created_at_local: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.message).toMatch(/open a shift/i);
  });

  // (b) After opening a shift → 201 success
  it("(b) with open shift → sale creates successfully (201)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await openShiftForBranch(branchId, today);

    const res = await call<{ data: { id: string; status: string } }>(
      "POST",
      `/v1/branches/${branchId}/sales`,
      {
        channel: "walkup",
        items: [{ variant_id: variantId, product_id: productId, quantity: 1 }],
        payment_method: "transfer",
        created_at_local: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("confirmed");
  });

  // (c) Preorder create with NO open shift → 409
  // Use a fresh branch with no shift
  it("(c) preorder create with no open shift → 409 conflict", async () => {
    // Create a fresh branch (guaranteed no shift)
    const b2Res = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: "Shift Gate Branch 2",
      code: "SGB2",
      delivery_zones: [],
    });
    const b2Id = b2Res.body.data.id;

    // Seed some stock for the new branch
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: b2Id,
      productId,
      variantId,
      delta: 10,
      sourceType: "adjustment",
      sourceId: uuid(),
      note: "Task 6 preorder gate test seed",
    });

    const res = await call<{ error: { code: string; message: string } }>(
      "POST",
      `/v1/branches/${b2Id}/sales`,
      {
        channel: "walkup",
        items: [{ variant_id: variantId, product_id: productId, quantity: 1 }],
        payment_method: "transfer",
        is_preorder: true,
        scheduled_delivery_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at_local: new Date().toISOString(),
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.message).toMatch(/open a shift/i);
  });
});
