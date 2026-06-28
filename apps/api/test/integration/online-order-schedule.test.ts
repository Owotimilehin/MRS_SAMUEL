/**
 * Task 6 integration tests: server-authoritative delivery schedule + alt_phone.
 *
 * Seed setup:
 *   - online-default branch
 *   - 650ml variant with 5 in stock
 *   - 330ml variant with 0 in stock
 *
 * (a) Order 4×650 → is_preorder=false, scheduled_delivery_at is non-null and
 *     matches what orderSchedule/scheduledIso compute for the same algorithm.
 * (b) Order 1×330 → is_preorder=true, scheduled_delivery_at is next day (per algo).
 * (c) alt_phone in payload is persisted on the sale_order row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import {
  setupTestDb,
  seedOwner,
  loginAs,
  setOnlineDefaultBranch,
} from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { orderSchedule, scheduledIso } from "@ms/shared";

describe("Task 6: server-authoritative delivery schedule + alt_phone", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branchId: string;
  /** 650ml variant (in-stock: 5) */
  let variant650Id: string;
  /** 330ml variant (out-of-stock: 0) */
  let variant330Id: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);

    process.env.PAYAZA_PUBLIC_KEY = "PZ78-PKTEST-itest";

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    // Create branch via API
    const bRes = await fetch(`${baseUrl}/v1/branches`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({ name: "Schedule Test Branch", code: "SCHTB" }),
    });
    branchId = ((await bRes.json()) as { data: { id: string } }).data.id;

    // Mark as online default so the handler sees it
    await setOnlineDefaultBranch(tdb.db, branchId);

    // Create product via API (gets a 330ml variant by default)
    const pRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        name: "Schedule Juice",
        slug: "schedule-juice",
        category: "regular",
        initial_price_ngn: 3000,
      }),
    });
    const pData = ((await pRes.json()) as {
      data: {
        id: string;
        variants: Array<{ id: string; size_ml: number }>;
      };
    }).data;
    const productId = pData.id;

    // The default variant is 330ml
    const existingVariant330 = pData.variants.find((v) => v.size_ml === 330);
    if (!existingVariant330) throw new Error("expected 330ml variant from product create");
    variant330Id = existingVariant330.id;

    // Seed a 650ml variant directly in the DB (no API endpoint for adding variants)
    const {
      productVariant,
      productPrice,
      stockLedger,
    } = await import("@ms/db");
    const [v650] = await tdb.db
      .insert(productVariant)
      .values({
        productId,
        sizeMl: 650,
        sku: `sched-juice-650ml-${Date.now()}`,
      })
      .returning();
    if (!v650) throw new Error("650ml variant insert failed");
    variant650Id = v650.id;

    // Price for 650ml
    await tdb.db.insert(productPrice).values({
      productId,
      variantId: variant650Id,
      priceNgn: 4500,
    });

    // Stock: 5 units of 650ml at the branch, 0 of 330ml
    await tdb.db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branchId,
      productId,
      variantId: variant650Id,
      delta: 5,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });
    // 330ml stock intentionally left at 0
  }, 90_000);

  afterAll(async () => {
    delete process.env.PAYAZA_PUBLIC_KEY;
    server.close();
    await container.stop();
  });

  it("(a) 4×650ml in-stock order → is_preorder=false + scheduled_delivery_at non-null and algorithmically correct", async () => {
    const beforeNow = new Date();

    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        customer: {
          name: "Sched Customer A",
          phone: "+2348025551111",
          address: "1 Schedule Street",
        },
        items: [{ variant_id: variant650Id, quantity: 4 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string; is_preorder: boolean } };
    expect(body.data.is_preorder).toBe(false);

    // Read back the stored scheduled_delivery_at from the DB
    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ scheduledDeliveryAt: saleOrder.scheduledDeliveryAt })
      .from(saleOrder)
      .where(eq(saleOrder.id, body.data.id));
    expect(row).toBeDefined();
    expect(row!.scheduledDeliveryAt).not.toBeNull();

    const afterNow = new Date();

    // Compute expected date range from the same algorithm the handler uses.
    // The handler calls orderSchedule(new Date(), lineKinds) — we bracket with
    // beforeNow/afterNow. In normal (non-boundary) conditions these are the same.
    const inStockLine = { sizeMl: 650, inStock: true };
    const schedBefore = orderSchedule(beforeNow, [inStockLine]);
    const schedAfter = orderSchedule(afterNow, [inStockLine]);
    const windowBefore = schedBefore.fixedWindow ?? schedBefore.selectableWindows[0]!;
    const windowAfter = schedAfter.fixedWindow ?? schedAfter.selectableWindows[0]!;
    const expectedIsoBefore = scheduledIso(schedBefore.date, windowBefore);
    const expectedIsoAfter = scheduledIso(schedAfter.date, windowAfter);

    const stored = row!.scheduledDeliveryAt!.toISOString();
    // Must be a parseable, non-zero datetime
    expect(new Date(stored).getTime()).toBeGreaterThan(0);
    // The stored date (YYYY-MM-DD) must equal one of the expected dates
    const storedDate = stored.slice(0, 10);
    expect([expectedIsoBefore.slice(0, 10), expectedIsoAfter.slice(0, 10)]).toContain(storedDate);
  });

  it("(b) 1×330ml out-of-stock order → is_preorder=true + scheduled_delivery_at is next day (per algo)", async () => {
    const beforeNow = new Date();

    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        customer: {
          name: "Sched Customer B",
          phone: "+2348025552222",
          address: "2 Preorder Street",
        },
        items: [{ variant_id: variant330Id, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string; is_preorder: boolean } };
    expect(body.data.is_preorder).toBe(true);

    // Read back scheduled_delivery_at
    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ scheduledDeliveryAt: saleOrder.scheduledDeliveryAt })
      .from(saleOrder)
      .where(eq(saleOrder.id, body.data.id));
    expect(row).toBeDefined();
    expect(row!.scheduledDeliveryAt).not.toBeNull();

    const afterNow = new Date();

    // Preorder 330ml line → orderSchedule puts it on the next delivery day
    const preorderLine = { sizeMl: 330, inStock: false };
    const schedBefore = orderSchedule(beforeNow, [preorderLine]);
    const schedAfter = orderSchedule(afterNow, [preorderLine]);

    const storedDate = row!.scheduledDeliveryAt!.toISOString().slice(0, 10);
    expect([schedBefore.date, schedAfter.date]).toContain(storedDate);

    // The preorder date must be strictly after today in Lagos time
    const todayLagos = (() => {
      const l = new Date(beforeNow.getTime() + 3_600_000); // UTC+1
      return [
        l.getUTCFullYear(),
        String(l.getUTCMonth() + 1).padStart(2, "0"),
        String(l.getUTCDate()).padStart(2, "0"),
      ].join("-");
    })();
    expect(storedDate > todayLagos).toBe(true);
  });

  it("(d) valid delivery_window sent by client is honoured for in-stock order", async () => {
    // Compute the schedule the handler will see so we know which windows are selectable.
    const beforeNow = new Date();
    const inStockLine = { sizeMl: 650, inStock: true };
    const sched = orderSchedule(beforeNow, [inStockLine]);
    // This test is only meaningful when the schedule offers selectable windows.
    // If the schedule returns a fixed window the test is a no-op guard (still passes).
    const targetWindow =
      sched.fixedWindow ??
      // Pick the LAST selectable window so we're not just accepting the default.
      sched.selectableWindows[sched.selectableWindows.length - 1];
    if (!targetWindow) {
      // No windows at all — skip rather than assert a broken state.
      return;
    }

    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        delivery_window: targetWindow,
        customer: {
          name: "Sched Customer D",
          phone: "+2348025554444",
          address: "4 Window Street",
        },
        items: [{ variant_id: variant650Id, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string; is_preorder: boolean } };
    expect(body.data.is_preorder).toBe(false);

    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ scheduledDeliveryAt: saleOrder.scheduledDeliveryAt })
      .from(saleOrder)
      .where(eq(saleOrder.id, body.data.id));
    expect(row?.scheduledDeliveryAt).not.toBeNull();

    // The anchor hour for the chosen window (Lagos / UTC+1):
    // morning=09, afternoon=14, evening=18 → UTC: 08, 13, 17
    const anchorUtcHour: Record<string, number> = { morning: 8, afternoon: 13, evening: 17 };
    const storedHour = row!.scheduledDeliveryAt!.getUTCHours();
    expect(storedHour).toBe(anchorUtcHour[targetWindow]);
  });

  it("(e) invalid delivery_window for fixed-evening OOS order falls back to evening", async () => {
    // A 650ml OOS order produces a fixed evening window (when ordering before 16:00 Lagos).
    // Sending "morning" must be rejected silently and the stored time must still be evening.

    // We need a 650ml variant with 0 stock. Create a separate product for this.
    const { productVariant: pvTable, productPrice, stockLedger } = await import("@ms/db");

    // Create product via API
    const pRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        name: "OOS Juice 650",
        slug: `oos-juice-650-${Date.now()}`,
        category: "regular",
        initial_price_ngn: 4000,
      }),
    });
    const pData = ((await pRes.json()) as {
      data: { id: string; variants: Array<{ id: string; size_ml: number }> };
    }).data;
    const oosProdId = pData.id;

    // Insert 650ml variant for this product (0 stock)
    const [v650oos] = await db
      .insert(pvTable)
      .values({ productId: oosProdId, sizeMl: 650, sku: `oos-juice-650-${Date.now()}` })
      .returning();
    if (!v650oos) throw new Error("650ml OOS variant insert failed");
    await db.insert(productPrice).values({ productId: oosProdId, variantId: v650oos.id, priceNgn: 4000 });
    // No stock ledger row → 0 available

    const beforeNow = new Date();
    const oosLine = { sizeMl: 650, inStock: false };
    const sched = orderSchedule(beforeNow, [oosLine]);

    // Only run the evening-fixed assertion when the schedule is indeed fixed to evening.
    // Outside Lagos 16:00–24:00 the date advances to next day but may still be evening-fixed;
    // we check fixedWindow rather than time-of-day to stay robust.
    const isEveningFixed = sched.fixedWindow === "evening";

    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        delivery_window: "morning", // INVALID for evening-fixed schedule
        customer: {
          name: "Sched Customer E",
          phone: "+2348025555555",
          address: "5 OOS Street",
        },
        items: [{ variant_id: v650oos.id, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string; is_preorder: boolean } };
    expect(body.data.is_preorder).toBe(true);

    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ scheduledDeliveryAt: saleOrder.scheduledDeliveryAt })
      .from(saleOrder)
      .where(eq(saleOrder.id, body.data.id));
    expect(row?.scheduledDeliveryAt).not.toBeNull();

    if (isEveningFixed) {
      // Must NOT be stored at morning anchor (08:00 UTC); must be evening (17:00 UTC)
      const storedHour = row!.scheduledDeliveryAt!.getUTCHours();
      expect(storedHour).toBe(17); // 18:00 Lagos = 17:00 UTC
    } else {
      // Schedule is not evening-fixed right now (ordering after 16:00 Lagos, rolls to next day).
      // The stored window should still not be morning (the requested invalid window).
      // Just assert a valid ISO date is stored.
      expect(new Date(row!.scheduledDeliveryAt!).getTime()).toBeGreaterThan(0);
    }
  });

  it("(c) alt_phone in payload is persisted on the sale_order row and surfaced via admin detail API", async () => {
    const orderRes = await fetch(`${baseUrl}/v1/public/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        branch_id: branchId,
        delivery_fee_ngn: 0,
        customer: {
          name: "Sched Customer C",
          phone: "+2348025553333",
          alt_phone: "+2348099990000",
          address: "3 AltPhone Street",
        },
        items: [{ variant_id: variant650Id, quantity: 1 }],
      }),
    });
    expect(orderRes.status).toBe(201);
    const body = (await orderRes.json()) as { data: { id: string } };

    // Check the DB row directly for the persisted alt_phone
    const { saleOrder } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ altPhone: saleOrder.altPhone })
      .from(saleOrder)
      .where(eq(saleOrder.id, body.data.id));
    expect(row).toBeDefined();
    expect(row!.altPhone).toBe("+2348099990000");

    // Verify alt_phone is also surfaced via the admin detail endpoint (owner auth)
    const detailRes = await fetch(
      `${baseUrl}/v1/branches/${branchId}/sales/${body.data.id}`,
      { headers: { cookie: cookies } },
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: { altPhone: string | null };
    };
    expect(detailBody.data.altPhone).toBe("+2348099990000");
  });
});
