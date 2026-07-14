import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type createDbClient, shiftOpen, varianceLoss } from "@ms/db";
import { eq, and } from "drizzle-orm";

let testDb: ReturnType<typeof createDbClient>;

interface Branch { id: string; name: string }
interface Product { id: string; name: string; slug: string }

describe("shift-open flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

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

  /**
   * Create a unique branch + product, seed branch stock to `onHand` via
   * inventory/adjust (branch location), and return the ids.
   * When onHand is 0 no adjust call is made (balance is 0 by default).
   */
  async function seedBranch(onHand: number, withProduct = true): Promise<{
    branch: Branch;
    product: Product | null;
  }> {
    const code = `SO-${uuid().slice(0, 6).toUpperCase()}`;
    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: `ShiftOpen Branch ${code}`,
      code,
      delivery_zones: [],
    });
    const branch = bRes.body.data;

    if (!withProduct) {
      return { branch, product: null };
    }

    const slug = `shift-open-product-${uuid().slice(0, 8)}`;
    const pRes = await call<{ data: Product }>("POST", "/v1/products", {
      name: `Shift Open Juice ${slug}`,
      slug,
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    });
    const product = pRes.body.data;

    if (onHand > 0) {
      await call("POST", "/v1/inventory/adjust", {
        location_type: "branch",
        location_id: branch.id,
        reason_code: "opening_balance",
        items: [{ product_id: product.id, new_quantity: onHand }],
      });
    }

    return { branch, product };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    testDb = tdb.db;
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

  it("reconciles branch on-hand to the opening count and books the shortfall as loss", async () => {
    const { branch, product } = await seedBranch(10);
    const productId = product!.id;
    const branchId = branch.id;

    // Read on-hand before via branch-stock report (ledger sum)
    const beforeStock = await call<{
      data: Array<{ branch_id: string; product_id: string; variant_id: string | null; balance: number }>;
    }>("GET", "/v1/reports/branch-stock");
    const beforeOnHand = stockBalance(
      beforeStock.body.data.filter((r) => r.branch_id === branchId),
      productId,
    );
    expect(beforeOnHand).toBe(10);

    // POST the opening count (counted 8, system 10 → variance -2, reason required)
    const res = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      {
        business_date: "2026-06-19",
        stock_counts: [
          { product_id: productId, counted_quantity: 8, variance_reason: "found short" },
        ],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();

    // On-hand is now reconciled to the physical count (10 → 8): a freshly-opened
    // shift writes a count_correction so the till sells against the truth.
    const afterStock = await call<{
      data: Array<{ branch_id: string; product_id: string; variant_id: string | null; balance: number }>;
    }>("GET", "/v1/reports/branch-stock");
    const afterOnHand = stockBalance(
      afterStock.body.data.filter((r) => r.branch_id === branchId),
      productId,
    );
    expect(afterOnHand).toBe(8);

    // The 2-bottle shortfall is booked as a loss sourced to the opening count.
    const losses = await testDb
      .select()
      .from(varianceLoss)
      .where(and(eq(varianceLoss.sourceId, res.body.data.id), eq(varianceLoss.source, "shift_open")));
    expect(losses).toHaveLength(1);
    expect(losses[0]!.quantity).toBe(2);

    // GET the shift-open record and verify computed variance
    const getRes = await call<{
      data: {
        id: string;
        stock_counts: Array<{
          productId: string;
          systemQuantity: number;
          countedQuantity: number;
          variance: number;
        }>;
      };
    }>("GET", `/v1/branches/${branchId}/shift-open?date=2026-06-19`);
    expect(getRes.status).toBe(200);
    const line = getRes.body.data.stock_counts.find((s) => s.productId === productId);
    expect(line).toBeDefined();
    expect(line!.systemQuantity).toBe(10);
    expect(line!.countedQuantity).toBe(8);
    expect(line!.variance).toBe(-2);
  });

  it("rejects a varianced line with no reason", async () => {
    const { branch, product } = await seedBranch(5);
    const productId = product!.id;
    const branchId = branch.id;

    // counted_quantity (3) differs from system (5) but no variance_reason
    const res = await call(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      {
        business_date: "2026-06-19",
        stock_counts: [{ product_id: productId, counted_quantity: 3 }],
      },
    );
    expect(res.status).toBe(400);
  });

  it("allows an empty stock_counts array (empty catalog cannot deadlock the gate)", async () => {
    const { branch } = await seedBranch(0, false);
    const branchId = branch.id;

    const res = await call(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      {
        business_date: "2026-06-19",
        stock_counts: [],
      },
    );
    expect(res.status).toBe(201);
  });

  // Task 4 TDD: session lifecycle tests
  it("(a) first open returns 201 with status=open and shift_number=1", async () => {
    const { branch } = await seedBranch(0, false);
    const branchId = branch.id;
    const date = "2026-06-20";

    const res = await call<{ data: { id: string; status: string; shiftNumber: number } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      { business_date: date, stock_counts: [] },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("open");
    expect(res.body.data.shiftNumber).toBe(1);
  });

  it("(b) second POST while open updates counts, does NOT create a 2nd shift", async () => {
    const { branch, product } = await seedBranch(5);
    const branchId = branch.id;
    const productId = product!.id;
    const date = "2026-06-20";

    // First open
    const first = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      { business_date: date, stock_counts: [] },
    );
    expect(first.status).toBe(201);
    const firstId = first.body.data.id;

    // Second POST while still open (re-count)
    const second = await call<{ data: { id: string; status: string; shiftNumber: number } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      {
        business_date: date,
        stock_counts: [{ product_id: productId, counted_quantity: 5 }],
      },
    );
    expect(second.status).toBe(201);
    // Same row returned (same id)
    expect(second.body.data.id).toBe(firstId);
    expect(second.body.data.status).toBe("open");

    // Only 1 shift_open row for this branch+date
    const rows = await testDb
      .select()
      .from(shiftOpen)
      .where(and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.businessDate, date)));
    expect(rows.length).toBe(1);
    // Still open
    expect(rows[0]!.status).toBe("open");
  });

  it("(c) after the open shift is closed, next POST opens shift_number=2", async () => {
    const { branch } = await seedBranch(0, false);
    const branchId = branch.id;
    const date = "2026-06-20";

    // Open shift 1
    const first = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      { business_date: date, stock_counts: [] },
    );
    expect(first.status).toBe(201);
    const firstId = first.body.data.id;

    // Close it directly in the DB
    await testDb
      .update(shiftOpen)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(shiftOpen.id, firstId));

    // Open shift 2
    const second = await call<{ data: { id: string; status: string; shiftNumber: number } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      { business_date: date, stock_counts: [] },
    );
    expect(second.status).toBe(201);
    expect(second.body.data.status).toBe("open");
    expect(second.body.data.shiftNumber).toBe(2);
    // Different row
    expect(second.body.data.id).not.toBe(firstId);
  });

  it("sync pull includes open_shift: non-null with open shift, null without", async () => {
    const { branch } = await seedBranch(0, false);
    const branchId = branch.id;
    const todayLagos = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);

    // Before any shift: open_shift must be null
    const pre = await call<{ data: { open_shift: null | { id: string; opened_at: string } } }>(
      "GET",
      `/v1/sync/pull?branch_id=${branchId}`,
    );
    expect(pre.status).toBe(200);
    expect(pre.body.data.open_shift).toBeNull();

    // Open a shift for today
    const openRes = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      { business_date: todayLagos, stock_counts: [] },
    );
    expect(openRes.status).toBe(201);
    const shiftId = openRes.body.data.id;

    // After opening: open_shift is non-null with the right id
    const post = await call<{ data: { open_shift: null | { id: string; opened_at: string } } }>(
      "GET",
      `/v1/sync/pull?branch_id=${branchId}`,
    );
    expect(post.status).toBe(200);
    expect(post.body.data.open_shift).not.toBeNull();
    expect(post.body.data.open_shift!.id).toBe(shiftId);
    expect(post.body.data.open_shift!.opened_at).toBeDefined();
  });

  it("sync pull reports opened_today after an opening is filed", async () => {
    const { branch, product } = await seedBranch(4);
    const branchId = branch.id;
    const productId = product!.id;
    const todayLagos = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);

    // Before filing: pull should report opened_today === false
    const pre = await call<{ data: { opened_today: boolean } }>(
      "GET",
      `/v1/sync/pull?branch_id=${branchId}`,
    );
    expect(pre.status).toBe(200);
    expect(pre.body.data.opened_today).toBe(false);

    // File the opening count for today's Lagos date
    const openRes = await call(
      "POST",
      `/v1/branches/${branchId}/shift-open`,
      {
        business_date: todayLagos,
        stock_counts: [{ product_id: productId, counted_quantity: 4 }],
      },
    );
    expect(openRes.status).toBe(201);

    // After filing: pull should report opened_today === true
    const post = await call<{ data: { opened_today: boolean } }>(
      "GET",
      `/v1/sync/pull?branch_id=${branchId}`,
    );
    expect(post.status).toBe(200);
    expect(post.body.data.opened_today).toBe(true);
  });
});
