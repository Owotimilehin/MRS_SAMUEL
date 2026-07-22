import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  branch,
  product,
  productVariant,
  productPrice,
  saleOrder,
  saleOrderItem,
  saleReturn,
} from "@ms/db";

// Regression coverage for two revenue-recognition bugs:
//   #1 — a fully-paid online order sitting in `out_for_delivery` (rider en
//        route) was excluded from every revenue query, so its money vanished
//        from the reports until the courier webhook flipped it to `delivered`.
//   #3 — /revenue attributed refunds via a correlated subquery keyed on a
//        (branch, channel) sale group *in the window*; a refund whose channel
//        had no counted sale in the window was silently dropped, so /revenue
//        disagreed with /pnl and /daily on the refund total.
describe("reports revenue-status coverage", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

  const FROM = "2026-05-01";
  const TO = "2026-05-31";
  const MONTH = "2026-05";
  const DAY = "2026-05-15";

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    const db = tdb.db;
    await seedOwner(db);

    const [br] = await db
      .insert(branch)
      .values({ name: "Cov Branch", code: "COV1" })
      .returning();
    if (!br) throw new Error("branch seed failed");

    const [prod] = await db
      .insert(product)
      .values({ name: "Cov Juice", slug: "cov-juice", category: "regular" })
      .returning();
    if (!prod) throw new Error("product seed failed");

    const [variant] = await db
      .insert(productVariant)
      .values({ productId: prod.id, sizeMl: 650, sku: "COV-650" })
      .returning();
    if (!variant) throw new Error("variant seed failed");

    const [price] = await db
      .insert(productPrice)
      .values({ productId: prod.id, variantId: variant.id, priceNgn: 1500 })
      .returning();
    if (!price) throw new Error("price seed failed");

    const at = new Date(`${DAY}T10:00:00+01:00`);

    // Order A — online, PAID and dispatched (out_for_delivery). 4 × ₦1500 = ₦6000.
    const [orderA] = await db
      .insert(saleOrder)
      .values({
        orderNumber: "COV-A",
        branchId: br.id,
        channel: "online",
        status: "out_for_delivery",
        subtotalNgn: 6000,
        totalNgn: 6000,
        paymentMethod: "transfer",
        paymentStatus: "paid",
        createdAtLocal: at,
        idempotencyKey: "aaaaaaaa-0000-4000-8000-000000000001",
      })
      .returning();
    if (!orderA) throw new Error("order A seed failed");
    await db.insert(saleOrderItem).values({
      saleOrderId: orderA.id,
      productId: prod.id,
      variantId: variant.id,
      productPriceId: price.id,
      quantity: 4,
      unitPriceNgn: 1500,
      lineTotalNgn: 6000,
    });

    // Order B — walk-up, paid. 3 × ₦1500 = ₦4500. Baseline already counted.
    const [orderB] = await db
      .insert(saleOrder)
      .values({
        orderNumber: "COV-B",
        branchId: br.id,
        channel: "walkup",
        status: "paid",
        subtotalNgn: 4500,
        totalNgn: 4500,
        paymentMethod: "transfer",
        paymentStatus: "paid",
        createdAtLocal: at,
        idempotencyKey: "bbbbbbbb-0000-4000-8000-000000000002",
      })
      .returning();
    if (!orderB) throw new Error("order B seed failed");
    await db.insert(saleOrderItem).values({
      saleOrderId: orderB.id,
      productId: prod.id,
      variantId: variant.id,
      productPriceId: price.id,
      quantity: 3,
      unitPriceNgn: 1500,
      lineTotalNgn: 4500,
    });

    // Order C — phone, CANCELLED (never a counted sale). Exists only to be the
    // FK target of a completed refund whose channel has no counted sale in the
    // window, exercising the #3 refund-only group.
    const [orderC] = await db
      .insert(saleOrder)
      .values({
        orderNumber: "COV-C",
        branchId: br.id,
        channel: "phone",
        status: "cancelled",
        subtotalNgn: 2000,
        totalNgn: 2000,
        paymentMethod: "transfer",
        paymentStatus: "refunded",
        createdAtLocal: at,
        idempotencyKey: "cccccccc-0000-4000-8000-000000000003",
      })
      .returning();
    if (!orderC) throw new Error("order C seed failed");

    await db.insert(saleReturn).values({
      returnNumber: "RET-COV-1",
      originalSaleOrderId: orderC.id,
      branchId: br.id,
      channel: "phone",
      status: "completed",
      reasonCategory: "quality_issue",
      refundMethod: "transfer",
      refundAmountNgn: 2000,
      idempotencyKey: "dddddddd-0000-4000-8000-000000000004",
      createdAt: at,
    });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  async function get<T>(path: string): Promise<{ status: number; data: T }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });
    const body = (await res.json()) as { data: T };
    return { status: res.status, data: body.data };
  }

  it("/revenue counts out_for_delivery as paid and keeps refund-only channel groups", async () => {
    const { status, data } = await get<
      Array<{ channel: string; gross_ngn: number; refunds_ngn: number; net_ngn: number; orders: number }>
    >(`/v1/reports/revenue?from=${FROM}&to=${TO}`);
    expect(status).toBe(200);

    const online = data.find((r) => r.channel === "online");
    expect(online).toBeDefined();
    expect(online!.gross_ngn).toBe(6000); // #1: out_for_delivery counted

    const phone = data.find((r) => r.channel === "phone");
    expect(phone).toBeDefined(); // #3: refund-only group survives
    expect(phone!.refunds_ngn).toBe(2000);
    expect(phone!.net_ngn).toBe(-2000);
    expect(phone!.orders).toBe(0);

    // Cross-endpoint identity: total net across groups == gross − all refunds.
    const totalNet = data.reduce((s, r) => s + r.net_ngn, 0);
    expect(totalNet).toBe(6000 + 4500 - 2000);
  });

  it("/pnl includes out_for_delivery revenue and carries a cost-basis label", async () => {
    const { status, data } = await get<{
      revenue_ngn: number;
      refunds_ngn: number;
      net_revenue_ngn: number;
      cost_basis_note: string;
    }>(`/v1/reports/pnl?month=${MONTH}`);
    expect(status).toBe(200);
    expect(data.revenue_ngn).toBe(10500); // 6000 + 4500, #1
    expect(data.refunds_ngn).toBe(2000);
    expect(data.net_revenue_ngn).toBe(8500);
    // #4: a label so P&L (expenses-only) is not mistaken for daily (COGS-based).
    expect(typeof data.cost_basis_note).toBe("string");
    expect(data.cost_basis_note.length).toBeGreaterThan(0);
  });

  it("/daily includes out_for_delivery revenue", async () => {
    const { status, data } = await get<{ revenue_ngn: number; refunds_ngn: number }>(
      `/v1/reports/daily?from=${FROM}&to=${TO}`,
    );
    expect(status).toBe(200);
    expect(data.revenue_ngn).toBe(10500); // #1
    expect(data.refunds_ngn).toBe(2000);
  });

  it("/timeseries includes out_for_delivery revenue in the day bucket", async () => {
    const { status, data } = await get<
      Array<{ date: string; gross_ngn: number }>
    >(`/v1/reports/timeseries?from=${FROM}&to=${TO}&interval=day`);
    expect(status).toBe(200);
    const dayBucket = data.find((b) => b.date === DAY);
    expect(dayBucket).toBeDefined();
    expect(dayBucket!.gross_ngn).toBe(10500); // #1
    const totalGross = data.reduce((s, b) => s + b.gross_ngn, 0);
    expect(totalGross).toBe(10500);
  });
});
