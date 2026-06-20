import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { setupTestDb, seedOwner, loginAs, stockBalance } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  outboxEvent,
  saleOrder,
  stockLedger,
  customerCredit,
  type DbClient,
} from "@ms/db";

interface Branch { id: string; name: string }
interface ProductRow { id: string; name: string; slug: string }
interface SaleOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
  paymentStatus: string;
}
interface SaleOrderDetail extends SaleOrderRow {
  items: Array<{ id: string; productId: string; quantity: number; unitPriceNgn: number }>;
}
interface ReturnRow {
  id: string;
  returnNumber: string;
  status: string;
  refundAmountNgn: number;
  refundMethod: string;
}

describe("Phase 4 returns flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: Branch;
  let product: ProductRow;
  let db: DbClient;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  async function buildPaidSale(opts: {
    quantity: number;
    paymentMethod: "cash" | "card";
  }): Promise<SaleOrderDetail> {
    const confirm = await call<{ data: SaleOrderRow }>(
      "POST",
      `/v1/branches/${branch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: opts.quantity }],
        payment_method: opts.paymentMethod,
        created_at_local: new Date().toISOString(),
      },
    );
    expect(confirm.status).toBe(201);
    await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    const detail = await call<{ data: SaleOrderDetail }>(
      "GET",
      `/v1/branches/${branch.id}/sales/${confirm.body.data.id}`,
    );
    return detail.body.data;
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

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Returns Test Branch",
      code: "RTB",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const { factory: factoryTable } = await import("@ms/db");
    const [fac] = await tdb.db.insert(factoryTable).values({ name: "Returns Test Factory" }).returning();
    const factory = fac as { id: string };

    const pRes = await call<{ data: ProductRow }>("POST", "/v1/products", {
      name: "Returns Test Sunrise",
      slug: "returns-test-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;
    // The legacy create defaults to a 330ml variant; production + transfer lines
    // must name that variant (completion now requires a size per line).
    const variantId = (product as unknown as {
      variants: Array<{ id: string; size_ml: number }>;
    }).variants.find((v) => v.size_ml === 330)!.id;

    // Production completion hard-guards on bottle stock, so give the factory
    // bottles to consume before running production (mirrors sales-flow setup).
    const mats = await call<{ data: Array<{ id: string; size_ml: number | null }> }>(
      "GET",
      "/v1/packaging/materials",
    );
    const bottle330 = mats.body.data.find((m) => m.size_ml === 330)!;
    await call("POST", "/v1/packaging/purchases", {
      factory_id: factory.id,
      packaging_material_id: bottle330.id,
      quantity: 1000,
      unit_cost_ngn: 50,
      total_cost_ngn: 50_000,
      purchase_date: "2026-05-01",
    });

    // Pre-stock branch with 40 bottles (enough for all four scenarios).
    const run = await call<{ data: { id: string } }>("POST", "/v1/production-runs", {
      factory_id: factory.id,
      run_date: "2026-05-11",
      items: [{ product_id: product.id, variant_id: variantId, quantity_produced: 40 }],
    });
    await call("PATCH", `/v1/production-runs/${run.body.data.id}/complete`);
    const xfer = await call<{ data: { id: string } }>("POST", "/v1/transfers", {
      factory_id: factory.id,
      branch_id: branch.id,
      items: [{ product_id: product.id, variant_id: variantId, quantity_sent: 40 }],
    });
    // POST /v1/transfers creates the row already in `dispatched` status —
    // no separate /dispatch call is needed (or exists on the route table).
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/arrive`);
    const detail = await call<{ data: { items: Array<{ id: string }> } }>(
      "GET",
      `/v1/transfers/${xfer.body.data.id}`,
    );
    await call("PATCH", `/v1/transfers/${xfer.body.data.id}/receive`, {
      items: [{ item_id: detail.body.data.items[0]!.id, quantity_received: 40 }],
    });

    // Open a shift for this branch so the sale-creation gate is satisfied.
    const today = new Date().toISOString().slice(0, 10);
    await call("POST", `/v1/branches/${branch.id}/shift-open`, {
      business_date: today,
      stock_counts: [],
    });
  }, 90_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("cash + restock disposition auto-completes and restocks ledger", async () => {
    const sale = await buildPaidSale({ quantity: 2, paymentMethod: "cash" });
    const stockBefore = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    const before = stockBalance(stockBefore.body.data, product.id);

    const res = await call<{ data: ReturnRow }>(
      "POST",
      `/v1/branches/${branch.id}/returns`,
      {
        original_sale_order_id: sale.id,
        reason_category: "wrong_flavor",
        refund_method: "cash",
        items: [
          {
            sale_order_item_id: sale.items[0]!.id,
            quantity_returned: 1,
            disposition: "restocked",
          },
        ],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("completed");
    expect(res.body.data.refundAmountNgn).toBe(2500);

    const stockAfter = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBalance(stockAfter.body.data, product.id)).toBe(before + 1);
  });

  it("restock returns stock to the SAME size bucket it was sold from", async () => {
    const sale = await buildPaidSale({ quantity: 1, paymentMethod: "cash" });
    // The sale deducted from a specific variant (size) bucket.
    const saleLedger = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.sourceId, sale.id));
    const soldVariantId = saleLedger[0]!.variantId;
    expect(soldVariantId).not.toBeNull();

    const res = await call<{ data: ReturnRow }>(
      "POST",
      `/v1/branches/${branch.id}/returns`,
      {
        original_sale_order_id: sale.id,
        reason_category: "wrong_flavor",
        refund_method: "cash",
        items: [
          { sale_order_item_id: sale.items[0]!.id, quantity_returned: 1, disposition: "restocked" },
        ],
      },
    );
    expect(res.body.data.status).toBe("completed");

    // The restock row must carry the SAME variant — restoring to the no-size
    // (NULL) bucket would leave the size grid permanently skewed.
    const restockLedger = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.sourceId, res.body.data.id));
    expect(restockLedger.length).toBe(1);
    expect(restockLedger[0]!.variantId).toBe(soldVariantId);
  });

  it("quality_issue + wasted disposition flags pending_approval until owner approves", async () => {
    const sale = await buildPaidSale({ quantity: 2, paymentMethod: "cash" });
    const stockBefore = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    const before = stockBalance(stockBefore.body.data, product.id);

    const res = await call<{ data: ReturnRow }>(
      "POST",
      `/v1/branches/${branch.id}/returns`,
      {
        original_sale_order_id: sale.id,
        reason_category: "quality_issue",
        reason_note: "Customer says it tasted off",
        refund_method: "cash",
        items: [
          {
            sale_order_item_id: sale.items[0]!.id,
            quantity_returned: 1,
            disposition: "wasted",
          },
        ],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("pending_approval");

    // Pending: ledger should be unchanged.
    const stockMid = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBalance(stockMid.body.data, product.id)).toBe(before);

    // Outbox should carry the review event.
    const events = await db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, "sale_return.pending_approval"));
    expect(events.length).toBeGreaterThan(0);

    // Review endpoint surfaces it.
    const review = await call<{
      data: { return_approvals: Array<{ id: string }> };
    }>("GET", "/v1/review");
    expect(review.body.data.return_approvals.some((r) => r.id === res.body.data.id)).toBe(true);

    // Owner approves.
    const approve = await call<{ data: ReturnRow }>(
      "PATCH",
      `/v1/branches/${branch.id}/returns/${res.body.data.id}/approve`,
    );
    expect(approve.body.data.status).toBe("completed");

    // After approval: two ledger rows — +1 in, -1 waste → net zero stock change.
    const stockAfter = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBalance(stockAfter.body.data, product.id)).toBe(before);

    const ledgerRows = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.sourceId, res.body.data.id));
    // Two rows: restock in + waste out
    expect(ledgerRows.length).toBe(2);
    const types = ledgerRows.map((r) => r.sourceType).sort();
    expect(types).toEqual(["return_restock", "waste"]);
  });

  it("replacement disposition creates a free sale order with outbound ledger", async () => {
    const sale = await buildPaidSale({ quantity: 2, paymentMethod: "cash" });
    const stockBefore = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    const before = stockBalance(stockBefore.body.data, product.id);

    const res = await call<{ data: ReturnRow }>(
      "POST",
      `/v1/branches/${branch.id}/returns`,
      {
        original_sale_order_id: sale.id,
        reason_category: "wrong_item",
        refund_method: "replacement",
        items: [
          {
            sale_order_item_id: sale.items[0]!.id,
            quantity_returned: 1,
            disposition: "replaced",
          },
        ],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("completed");

    // Net ledger: +1 (restocked) -1 (replacement leaving) = 0
    const stockAfter = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
      "GET",
      `/v1/stock/branch/${branch.id}`,
    );
    expect(stockBalance(stockAfter.body.data, product.id)).toBe(before);

    // A new free SaleOrder should exist.
    const freeOrders = await db
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.paymentMethod, "replacement"));
    expect(freeOrders.length).toBeGreaterThan(0);
    const free = freeOrders[freeOrders.length - 1]!;
    expect(free.totalNgn).toBe(0);
    expect(free.status).toBe("paid");
  });

  it("card_reversal refund emits payment.refund_request outbox event", async () => {
    const sale = await buildPaidSale({ quantity: 1, paymentMethod: "card" });
    const res = await call<{ data: ReturnRow }>(
      "POST",
      `/v1/branches/${branch.id}/returns`,
      {
        original_sale_order_id: sale.id,
        reason_category: "wrong_flavor",
        refund_method: "card_reversal",
        items: [
          {
            sale_order_item_id: sale.items[0]!.id,
            quantity_returned: 1,
            disposition: "restocked",
          },
        ],
      },
    );
    expect(res.status).toBe(201);
    // ₦2,500 is below the ₦5,000 threshold and not a quality issue, so it auto-completes.
    expect(res.body.data.status).toBe("completed");

    const events = await db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, "payment.refund_request"));
    const forThisReturn = events.find(
      (e) => (e.payload as Record<string, string>)["sale_return_id"] === res.body.data.id,
    );
    expect(forThisReturn).toBeDefined();
    expect((forThisReturn!.payload as Record<string, number>)["amount_ngn"]).toBe(2500);
  });

  it("store_credit refund posts to customer_credit ledger", async () => {
    // Tied to a customer
    const sale = await buildPaidSale({ quantity: 1, paymentMethod: "cash" });
    // Attach a customer for the sale via direct DB update (no API yet for customer creation).
    const { customer } = await import("@ms/db");
    const [cust] = await db
      .insert(customer)
      .values({ name: "Test Customer", phone: "+2348011111111" })
      .returning();
    await db.update(saleOrder).set({ customerId: cust!.id }).where(eq(saleOrder.id, sale.id));

    const res = await call<{ data: ReturnRow }>(
      "POST",
      `/v1/branches/${branch.id}/returns`,
      {
        original_sale_order_id: sale.id,
        reason_category: "changed_mind",
        refund_method: "store_credit",
        items: [
          {
            sale_order_item_id: sale.items[0]!.id,
            quantity_returned: 1,
            disposition: "restocked",
          },
        ],
        owner_override_window: true,
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("completed");

    const credits = await db
      .select()
      .from(customerCredit)
      .where(eq(customerCredit.customerId, cust!.id));
    expect(credits.length).toBe(1);
    expect(credits[0]!.amountNgn).toBe(2500);
  });
});
