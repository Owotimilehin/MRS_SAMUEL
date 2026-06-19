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
        packaging_cost_bottles_ngn: number;
        packaging_cost_bags_ngn: number;
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
});
