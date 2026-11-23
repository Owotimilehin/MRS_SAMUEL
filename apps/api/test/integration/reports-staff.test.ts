import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, seedUser, seedCatalog, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  branch,
  productPrice,
  saleOrder,
  saleOrderItem,
  saleReturn,
  dailyClose,
} from "@ms/db";
import { eq } from "drizzle-orm";

/**
 * GET /v1/reports/staff: two staff at two branches, one refund, one short
 * shift-end, one online order with no staff, plus orders that must NOT count
 * (cancelled; outside the range).
 */
describe("GET /v1/reports/staff", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let ownerCookie: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let branchA: string;
  let branchB: string;
  let ada: string;
  let bola: string;
  const DAY = "2026-11-20";
  // 10:00 Lagos on DAY
  const at = new Date("2026-11-20T09:00:00Z");

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
    const cat = await seedCatalog(db);
    branchA = cat.branchId;
    const [b2] = await db.insert(branch).values({ name: "Second Branch", code: `SB-${Date.now()}` }).returning();
    branchB = b2!.id;
    ada = (await seedUser(db, { email: "ada@example.com", role: "branch_staff", branchId: branchA })).id;
    bola = (await seedUser(db, { email: "bola@example.com", role: "branch_staff", branchId: branchB })).id;
    const [price] = await db.select().from(productPrice).where(eq(productPrice.variantId, cat.variantId));

    const sale = async (opts: {
      branchId: string;
      userId: string | null;
      qty: number;
      total: number;
      status?: string;
      when?: Date;
      channel?: string;
    }): Promise<string> => {
      const [o] = await db
        .insert(saleOrder)
        .values({
          orderNumber: `S-${uuid()}`,
          branchId: opts.branchId,
          channel: (opts.channel ?? "walkup") as never,
          status: (opts.status ?? "paid") as never,
          paymentStatus: "paid",
          paymentMethod: "transfer",
          subtotalNgn: opts.total,
          totalNgn: opts.total,
          createdAtLocal: opts.when ?? at,
          createdByUserId: opts.userId,
          idempotencyKey: uuid(),
        })
        .returning();
      await db.insert(saleOrderItem).values({
        saleOrderId: o!.id,
        productId: cat.productId,
        variantId: cat.variantId,
        productPriceId: price!.id,
        quantity: opts.qty,
        unitPriceNgn: Math.round(opts.total / opts.qty),
        lineTotalNgn: opts.total,
      });
      return o!.id;
    };

    // Ada at branch A: 2 sales (3 + 2 bottles), one refunded ₦2,500.
    const adaSale = await sale({ branchId: branchA, userId: ada, qty: 3, total: 7500 });
    await sale({ branchId: branchA, userId: ada, qty: 2, total: 5000 });
    // Ada also rang one sale at branch B.
    await sale({ branchId: branchB, userId: ada, qty: 1, total: 2500 });
    // Bola at branch B: 1 sale of 4 bottles.
    await sale({ branchId: branchB, userId: bola, qty: 4, total: 10000 });
    // Not counted: cancelled, and a sale the day before (Lagos).
    await sale({ branchId: branchA, userId: ada, qty: 9, total: 99999, status: "cancelled" });
    await sale({ branchId: branchA, userId: ada, qty: 9, total: 88888, when: new Date("2026-11-19T22:30:00Z") });
    // 23:30 UTC on the 19th is 00:30 Lagos on the 20th: counts.
    await sale({ branchId: branchB, userId: bola, qty: 1, total: 1000, when: new Date("2026-11-19T23:30:00Z") });
    // Online, no staff.
    await sale({ branchId: branchA, userId: null, qty: 2, total: 6000, channel: "online", status: "delivered" });

    await db.insert(saleReturn).values({
      returnNumber: `R-${uuid()}`,
      originalSaleOrderId: adaSale,
      branchId: branchA,
      channel: "walkup",
      status: "completed",
      reasonCategory: "quality_issue",
      refundMethod: "transfer",
      refundAmountNgn: 2500,
      createdByUserId: ada,
      idempotencyKey: uuid(),
      createdAt: at,
    });

    // Bola submitted a close ₦700 short; Ada one that balanced; a draft is ignored.
    await db.insert(dailyClose).values([
      { branchId: branchB, businessDate: DAY, status: "submitted", varianceNgn: -700, submittedByUserId: bola, submittedAt: at },
      { branchId: branchA, businessDate: DAY, status: "approved", varianceNgn: 0, submittedByUserId: ada, submittedAt: at },
      { branchId: branchA, businessDate: DAY, status: "draft", varianceNgn: -5000, submittedByUserId: ada },
    ]);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    ownerCookie = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  interface Row {
    user_id: string | null;
    name: string;
    branch_id: string;
    orders: number;
    bottles: number;
    gross_ngn: number;
    refunds_ngn: number;
    net_ngn: number;
    avg_order_ngn: number;
    closes_submitted: number;
    short_count: number;
    short_total_ngn: number;
  }
  const get = async (qs: string) => {
    const res = await fetch(`${baseUrl}/v1/reports/staff?${qs}`, { headers: { cookie: ownerCookie } });
    return { status: res.status, body: (await res.json()) as { data: { rows: Row[]; totals: Record<string, number> } } };
  };

  it("splits each person by branch with net, bottles, average and shift-end shortfalls", async () => {
    const { status, body } = await get(`from=${DAY}&to=${DAY}`);
    expect(status).toBe(200);
    const rows = body.data.rows;
    const find = (u: string | null, b: string) => rows.find((r) => r.user_id === u && r.branch_id === b);

    expect(find(ada, branchA)).toMatchObject({
      orders: 2, bottles: 5, gross_ngn: 12500, refunds_ngn: 2500, net_ngn: 10000, avg_order_ngn: 6250,
      closes_submitted: 1, short_count: 0, short_total_ngn: 0,
    });
    expect(find(ada, branchB)).toMatchObject({ orders: 1, bottles: 1, net_ngn: 2500 });
    expect(find(bola, branchB)).toMatchObject({
      orders: 2, bottles: 5, gross_ngn: 11000, net_ngn: 11000, closes_submitted: 1, short_count: 1, short_total_ngn: 700,
    });
    expect(find(null, branchA)).toMatchObject({ name: "Online (no staff)", orders: 1, bottles: 2, net_ngn: 6000 });
    expect(rows).toHaveLength(4);
    expect(body.data.totals).toMatchObject({ orders: 6, net_ngn: 29500, short_total_ngn: 700 });
  });

  it("filters by branch", async () => {
    const { body } = await get(`from=${DAY}&to=${DAY}&branch_id=${branchB}`);
    expect(body.data.rows.every((r) => r.branch_id === branchB)).toBe(true);
    expect(body.data.rows).toHaveLength(2);
  });

  it("rejects a bad range", async () => {
    expect((await get(`from=2026-11-21&to=2026-11-20`)).status).toBe(400);
    expect((await get(`from=${DAY}&to=${DAY}&branch_id=nope`)).status).toBe(400);
  });

  it("needs reports.view", async () => {
    const staffCookie = await loginAs(baseUrl, "ada@example.com", "userpassword123");
    const res = await fetch(`${baseUrl}/v1/reports/staff?from=${DAY}&to=${DAY}`, { headers: { cookie: staffCookie } });
    expect(res.status).toBe(403);
  });
});
