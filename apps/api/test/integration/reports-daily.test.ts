import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  factory,
  branch,
  product,
  productVariant,
  productPrice,
  packagingMaterial,
  packagingPurchase,
  saleOrder,
  saleOrderItem,
  saleOrderPackaging,
  businessExpense,
} from "@ms/db";

describe("GET /v1/reports/daily", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let ownerCookies: string;
  let adminCookies: string;
  let server: ReturnType<typeof serve>;
  const DATE = "2026-06-19";

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    const db = tdb.db;
    await seedOwner(db);
    await seedUser(db, { email: "admin@example.com", role: "admin" });

    // --- Factory ---
    const [factoryRow] = await db
      .insert(factory)
      .values({ name: "Test Factory" })
      .returning();
    if (!factoryRow) throw new Error("factory seed failed");

    // --- Branch ---
    const [branchRow] = await db
      .insert(branch)
      .values({ name: "Test Branch", code: "TB01" })
      .returning();
    if (!branchRow) throw new Error("branch seed failed");

    // --- Product ---
    const [productRow] = await db
      .insert(product)
      .values({
        name: "Mango Juice",
        slug: "mango-juice",
        category: "regular",
        shelfLifeHours: 48,
      })
      .returning();
    if (!productRow) throw new Error("product seed failed");

    // --- Packaging materials ---
    // Bottle: 650ml glass bottle
    const [bottleMat] = await db
      .insert(packagingMaterial)
      .values({
        name: "650ml Glass Bottle",
        unitLabel: "bottle",
        sizeMl: 650,
        kind: "bottle",
      })
      .returning();
    if (!bottleMat) throw new Error("bottle material seed failed");

    // Bag: Small bag
    const [bagMat] = await db
      .insert(packagingMaterial)
      .values({
        name: "Small Bag",
        unitLabel: "bag",
        kind: "bag",
      })
      .returning();
    if (!bagMat) throw new Error("bag material seed failed");

    // --- Product variant (650ml, linked to bottle material) ---
    const [variantRow] = await db
      .insert(productVariant)
      .values({
        productId: productRow.id,
        sizeMl: 650,
        sku: "MANGO-650",
        bottleMaterialId: bottleMat.id,
      })
      .returning();
    if (!variantRow) throw new Error("variant seed failed");

    // --- Product price (required by sale_order_item.product_price_id NOT NULL) ---
    const [priceRow] = await db
      .insert(productPrice)
      .values({
        productId: productRow.id,
        variantId: variantRow.id,
        priceNgn: 1500,
      })
      .returning();
    if (!priceRow) throw new Error("price seed failed");

    // --- Packaging purchases ---
    // Bottle: Lot A: 20 @ ₦40 (2026-06-01), Lot B: 100 @ ₦60 (2026-06-10)
    await db.insert(packagingPurchase).values([
      {
        factoryId: factoryRow.id,
        packagingMaterialId: bottleMat.id,
        quantity: 20,
        unitCostNgn: 40,
        totalCostNgn: 800,
        purchaseDate: "2026-06-01",
      },
      {
        factoryId: factoryRow.id,
        packagingMaterialId: bottleMat.id,
        quantity: 100,
        unitCostNgn: 60,
        totalCostNgn: 6000,
        purchaseDate: "2026-06-10",
      },
    ]);

    // Bag: 100 @ ₦25 (2026-06-05)
    await db.insert(packagingPurchase).values({
      factoryId: factoryRow.id,
      packagingMaterialId: bagMat.id,
      quantity: 100,
      unitCostNgn: 25,
      totalCostNgn: 2500,
      purchaseDate: "2026-06-05",
    });

    // --- Sale order on 2026-06-19 ---
    const [orderRow] = await db
      .insert(saleOrder)
      .values({
        orderNumber: "ORD-TEST-001",
        branchId: branchRow.id,
        channel: "walkup",
        status: "paid",
        subtotalNgn: 45000,
        totalNgn: 45000,
        paymentMethod: "transfer",
        paymentStatus: "paid",
        createdAtLocal: new Date("2026-06-19T10:00:00+01:00"),
        idempotencyKey: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      })
      .returning();
    if (!orderRow) throw new Error("sale order seed failed");

    // --- Sale order item: 30 units of 650ml variant ---
    await db.insert(saleOrderItem).values({
      saleOrderId: orderRow.id,
      productId: productRow.id,
      variantId: variantRow.id,
      productPriceId: priceRow.id,
      quantity: 30,
      unitPriceNgn: 1500,
      lineTotalNgn: 45000,
    });

    // --- Sale order packaging: 12 bags ---
    await db.insert(saleOrderPackaging).values({
      saleOrderId: orderRow.id,
      packagingMaterialId: bagMat.id,
      quantity: 12,
    });

    // --- Business expenses on 2026-06-19 ---
    // transport ₦5000, packaging ₦999999 (must be ignored), salaries ₦8000
    await db.insert(businessExpense).values([
      {
        expenseDate: "2026-06-19",
        categoryCode: "transport",
        amountNgn: 5000,
        description: "Driver fuel",
      },
      {
        expenseDate: "2026-06-19",
        categoryCode: "packaging",
        amountNgn: 999999,
        description: "Packaging expense — should always be excluded",
      },
      {
        expenseDate: "2026-06-19",
        categoryCode: "salaries",
        amountNgn: 8000,
        description: "Daily staff pay",
      },
    ]);

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    adminCookies = await loginAs(baseUrl, "admin@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("forbids admin (no finance.view)", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/daily?date=${DATE}`, {
      headers: { cookie: adminCookies },
    });
    expect(res.status).toBe(403);
  });

  it("computes FIFO bottle cost spanning two purchase lots", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/daily?date=${DATE}`, {
      headers: { cookie: ownerCookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        packaging_cost_ngn: number;
        packaging_cost_bottles_ngn: number;
        packaging_cost_bags_ngn: number;
        net_revenue_ngn: number;
        expenses_ngn: number;
        daily_profit_ngn: number;
        total_units: number;
        units_by_size: Array<{ size_ml: number; units: number }>;
      };
    };
    // 30 bottles: 20 @40 + 10 @60 = 800 + 600 = 1400
    expect(data.packaging_cost_bottles_ngn).toBe(1400);
    // 12 bags @25 = 300
    expect(data.packaging_cost_bags_ngn).toBe(300);
    expect(data.total_units).toBe(30);
    expect(data.units_by_size).toEqual([{ size_ml: 650, units: 30 }]);
    // Top-level packaging_cost_ngn must be the sum of bottles + bags.
    expect(data.packaging_cost_ngn).toBe(1700);
    // End-to-end math: daily_profit = net_revenue - packaging_cost - expenses,
    // using whatever expense set the default (non-packaging) query selected.
    expect(data.daily_profit_ngn).toBe(
      data.net_revenue_ngn - data.packaging_cost_ngn - data.expenses_ngn,
    );
  });

  it("returns 200 with expenses_ngn=0 when the selected category set is empty after stripping packaging", async () => {
    const res = await fetch(
      `${baseUrl}/v1/reports/daily?date=${DATE}&expense_categories=packaging`,
      { headers: { cookie: ownerCookies } },
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { expenses_ngn: number; expenses_by_category: unknown[] };
    };
    expect(data.expenses_ngn).toBe(0);
    expect(data.expenses_by_category).toEqual([]);
  });

  it("excludes the packaging category from daily expenses but includes selected ones", async () => {
    const res = await fetch(
      `${baseUrl}/v1/reports/daily?date=${DATE}&expense_categories=transport,salaries`,
      { headers: { cookie: ownerCookies } },
    );
    const { data } = (await res.json()) as { data: { expenses_ngn: number } };
    expect(data.expenses_ngn).toBe(13000); // 5000 + 8000, packaging 999999 ignored
  });

  it("honours the category filter (transport only)", async () => {
    const res = await fetch(
      `${baseUrl}/v1/reports/daily?date=${DATE}&expense_categories=transport`,
      { headers: { cookie: ownerCookies } },
    );
    const { data } = (await res.json()) as { data: { expenses_ngn: number } };
    expect(data.expenses_ngn).toBe(5000);
  });

  it("returns size→type revenue, packaging breakdown, reconciliation, and margin", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/daily?date=${DATE}`, {
      headers: { cookie: ownerCookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        net_revenue_ngn: number;
        product_sales_ngn: number;
        delivery_fees_ngn: number;
        other_adjustments_ngn: number;
        refunds_ngn: number;
        daily_profit_ngn: number;
        margin_pct: number | null;
        revenue_by_size: Array<{
          size_ml: number;
          revenue_ngn: number;
          units: number;
          rows: Array<{ category: string; units: number; revenue_ngn: number; avg_unit_price_ngn: number }>;
        }>;
        packaging_breakdown: Array<{
          material_id: string;
          name: string;
          kind: string;
          units: number;
          unit_cost_ngn: number;
          cost_ngn: number;
        }>;
        packaging_cost_ngn: number;
      };
    };

    // revenue_by_size: one size (650ml), one category row (regular)
    expect(data.revenue_by_size).toEqual([
      {
        size_ml: 650,
        revenue_ngn: 45000,
        units: 30,
        rows: [{ category: "regular", units: 30, revenue_ngn: 45000, avg_unit_price_ngn: 1500 }],
      },
    ]);

    // reconciliation: product sales + delivery + other − refunds == net revenue.
    // For ordinary line-item orders the residual is 0; the identity holds
    // regardless (it's an identity by construction of other_adjustments_ngn).
    expect(data.product_sales_ngn).toBe(45000);
    expect(data.delivery_fees_ngn).toBe(0);
    expect(data.other_adjustments_ngn).toBe(0);
    expect(
      data.product_sales_ngn +
        data.delivery_fees_ngn +
        data.other_adjustments_ngn -
        data.refunds_ngn,
    ).toBe(data.net_revenue_ngn);

    // packaging_breakdown: a bottle line (30 @ ~₦47) + a bag line (12 @ ₦25),
    // summing to the unchanged packaging_cost_ngn.
    const bottle = data.packaging_breakdown.find((b) => b.kind === "bottle");
    const bag = data.packaging_breakdown.find((b) => b.kind === "bag");
    expect(bottle).toMatchObject({ units: 30, cost_ngn: 1400, unit_cost_ngn: 47 });
    expect(bag).toMatchObject({ units: 12, cost_ngn: 300, unit_cost_ngn: 25 });
    expect(data.packaging_breakdown.reduce((s, b) => s + b.cost_ngn, 0)).toBe(
      data.packaging_cost_ngn,
    );

    // margin = profit / net revenue, one decimal. profit = 45000 − 1700 − 13000 = 30300.
    expect(data.daily_profit_ngn).toBe(30300);
    expect(data.margin_pct).toBeCloseTo(67.3, 1);
  });
});
