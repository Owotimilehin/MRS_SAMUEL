import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { saleOrder, payment, type DbClient } from "@ms/db";

/**
 * Needs-review inbox: payment_attention bucket
 *
 * Covers:
 *   1. An online order with status = 'reconcile_needed' appears in payment_attention
 *   2. An online order with refundOwedNgn set (any status) appears in payment_attention
 *   3. reported_ngn is populated from the latest payment.amountNgn when a payment row exists
 *   4. Walk-up (non-online) orders are NOT surfaced even if they have reconcile_needed
 */
describe("GET /v1/review – payment_attention bucket", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let db: DbClient;
  let branchId: string;

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

    // Create a branch to attach orders to
    const bRes = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: "Review Test Branch",
      code: "RVW",
      delivery_zones: [],
    });
    branchId = bRes.body.data.id;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("surfaces reconcile_needed online order and refund-owed cancelled online order in payment_attention", async () => {
    // --- Seed: online order with status = 'reconcile_needed' ---
    const [reconcileOrder] = await db
      .insert(saleOrder)
      .values({
        orderNumber: `TEST-REC-${uuid().slice(0, 8)}`,
        branchId,
        channel: "online",
        status: "reconcile_needed",
        subtotalNgn: 5000,
        totalNgn: 5000,
        paymentMethod: "transfer",
        paymentStatus: "pending",
        createdAtLocal: new Date(),
        idempotencyKey: uuid(),
      })
      .returning();
    if (!reconcileOrder) throw new Error("Failed to seed reconcile order");

    // Add a payment row for this order so reported_ngn can be set
    await db.insert(payment).values({
      saleOrderId: reconcileOrder.id,
      method: "transfer",
      amountNgn: 4800, // slightly different — the "reported" amount
      status: "paid",
      processor: "payaza",
      processorReference: `PAY-${uuid().slice(0, 8)}`,
    });

    // --- Seed: cancelled online order with refundOwedNgn set ---
    const [refundOrder] = await db
      .insert(saleOrder)
      .values({
        orderNumber: `TEST-REF-${uuid().slice(0, 8)}`,
        branchId,
        channel: "online",
        status: "cancelled",
        subtotalNgn: 3000,
        totalNgn: 3000,
        refundOwedNgn: 3000,
        paymentMethod: "transfer",
        paymentStatus: "paid",
        createdAtLocal: new Date(),
        idempotencyKey: uuid(),
      })
      .returning();
    if (!refundOrder) throw new Error("Failed to seed refund order");
    // No payment row for this one → reported_ngn should be null

    // --- Seed: walkup order with reconcile_needed (should NOT appear) ---
    await db.insert(saleOrder).values({
      orderNumber: `TEST-WLK-${uuid().slice(0, 8)}`,
      branchId,
      channel: "walkup",
      status: "reconcile_needed",
      subtotalNgn: 2000,
      totalNgn: 2000,
      paymentMethod: "cash",
      paymentStatus: "pending",
      createdAtLocal: new Date(),
      idempotencyKey: uuid(),
    });

    // --- GET /v1/review ---
    const review = await call<{
      data: {
        payment_attention: Array<{
          id: string;
          order_number: string;
          status: string;
          total_ngn: number;
          refund_owed_ngn: number | null;
          reported_ngn: number | null;
        }>;
      };
    }>("GET", "/v1/review");

    expect(review.status).toBe(200);
    const attention = review.body.data.payment_attention;
    expect(Array.isArray(attention)).toBe(true);

    // Both seeded online orders must appear
    const reconcileItem = attention.find((a) => a.id === reconcileOrder.id);
    const refundItem = attention.find((a) => a.id === refundOrder.id);

    expect(reconcileItem).toBeDefined();
    expect(reconcileItem!.status).toBe("reconcile_needed");
    expect(reconcileItem!.total_ngn).toBe(5000);
    expect(reconcileItem!.refund_owed_ngn).toBeNull();
    expect(reconcileItem!.reported_ngn).toBe(4800); // from payment row

    expect(refundItem).toBeDefined();
    expect(refundItem!.status).toBe("cancelled");
    expect(refundItem!.total_ngn).toBe(3000);
    expect(refundItem!.refund_owed_ngn).toBe(3000);
    expect(refundItem!.reported_ngn).toBeNull(); // no payment row

    // Walk-up order must NOT appear
    const walkupInAttention = attention.filter(
      (a) => a.order_number.startsWith("TEST-WLK"),
    );
    expect(walkupInAttention.length).toBe(0);
  });
});
