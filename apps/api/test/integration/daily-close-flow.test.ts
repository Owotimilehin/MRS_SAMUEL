import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Branch { id: string; name: string }
interface ProductRow { id: string; name: string }
interface SaleOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
}
interface ClosePreview {
  expected_cash_ngn: number;
  expected_stock: Record<string, number>;
}
interface CloseRow {
  id: string;
  status: string;
  varianceNgn: number;
  cashCountedNgn: number;
  systemCashTotalNgn: number;
  shiftId?: string | null;
  shiftNumber?: number | null;
  openedAt?: string | null;
  closedAt?: string | null;
}
interface ShiftOpenRow {
  id: string;
  status: string;
  closedAt?: string | null;
}

describe("Phase 5 daily close flow", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: Branch;
  let product: ProductRow;

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

  /** Open a shift for the branch and return the shift row.
   * @param countedQty - what to report for the stock count (default 20)
   * @param varianceReason - required when countedQty differs from system qty
   */
  async function openShift(
    branchId: string,
    businessDate: string,
    countedQty = 20,
    varianceReason?: string,
  ): Promise<ShiftOpenRow> {
    const stockCount: Record<string, unknown> = {
      product_id: product.id,
      counted_quantity: countedQty,
    };
    if (varianceReason) stockCount.variance_reason = varianceReason;
    const res = await call<{ data: ShiftOpenRow }>("POST", `/v1/branches/${branchId}/shift-open`, {
      business_date: businessDate,
      stock_counts: [stockCount],
    });
    if (res.status !== 201) throw new Error(`openShift failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Close Test Branch",
      code: "CTB",
      delivery_zones: [],
    });
    branch = bRes.body.data;

    const pRes = await call<{ data: ProductRow }>("POST", "/v1/products", {
      name: "Close Test Sunrise",
      slug: "close-test-sunrise",
      category: "regular",
      ingredients: ["Carrot"],
      initial_price_ngn: 2500,
    });
    product = pRes.body.data;

    // Pre-stock 20 bottles directly at the branch via inventory adjust
    await call("POST", "/v1/inventory/adjust", {
      location_type: "branch",
      location_id: branch.id,
      reason_code: "opening_balance",
      items: [{ product_id: product.id, new_quantity: 20 }],
    });

    // Open a shift so the sale-creation gate is satisfied for the 3 beforeAll sales.
    // (These sales will be OUTSIDE the shift window for the daily-close tests,
    // which open a fresh shift via openShift() in the test body itself.)
    const today = new Date().toISOString().slice(0, 10);
    const preShift = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${branch.id}/shift-open`,
      { business_date: today, stock_counts: [] },
    );
    // Immediately close it in DB so the shift-close tests start with no open shift.
    // We do this after the 3 sales are made below.

    // Sell 3 bottles by transfer today (the till books every sale as transfer).
    for (let i = 0; i < 3; i++) {
      const confirm = await call<{ data: SaleOrderRow }>(
        "POST",
        `/v1/branches/${branch.id}/sales`,
        {
          channel: "walkup",
          items: [{ product_id: product.id, quantity: 1 }],
          payment_method: "transfer",
          created_at_local: new Date().toISOString(),
        },
      );
      await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    }

    // Close the pre-seeding shift so test (a) starts with no open shift.
    if (preShift.body?.data?.id) {
      const { createDbClient, shiftOpen } = await import("@ms/db");
      const { eq } = await import("drizzle-orm");
      const tmpDb = createDbClient(process.env.DATABASE_URL!);
      await tmpDb
        .update(shiftOpen)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(shiftOpen.id, preShift.body.data.id));
    }
  }, 90_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("preview returns expected cash + stock", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ data: ClosePreview }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close/preview?date=${today}`,
    );
    expect(res.status).toBe(200);
    // Expected reconcile figure now sums transfer sales (the till is transfer-only).
    expect(res.body.data.expected_cash_ngn).toBe(7500); // 3 × ₦2,500
    expect(res.body.data.expected_stock[product.id]).toBe(17); // 20 − 3 sold
  });

  // -------------------------------------------------------------------------
  // Task-5 tests: conclusive shift-lifecycle close
  // -------------------------------------------------------------------------

  it("(a) close with no open shift → 409 no_open_shift", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ error: { code: string } }>(
      "POST",
      `/v1/branches/${branch.id}/daily-close`,
      {
        business_date: today,
        cash_counted_ngn: 0,
        transfers_counted_ngn: 7500,
        stock_counts: [{ product_id: product.id, counted_quantity: 17 }],
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("(b) with an open shift → success, shift_id linked, shift now closed", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Open a shift first — count 17 (the system qty after 3 sales from 20)
    const shift = await openShift(branch.id, today, 17);
    expect(shift.status).toBe("open");

    // The shift was opened AFTER the 3 sales (which were made in beforeAll),
    // so those sales are outside the shift window. System total = 0.
    // Staff counts ₦7500 transfers → variance = +7500 (surplus vs 0 expected).
    const res = await call<{ data: CloseRow }>(
      "POST",
      `/v1/branches/${branch.id}/daily-close`,
      {
        business_date: today,
        cash_counted_ngn: 0,
        transfers_counted_ngn: 7500,
        stock_counts: [{ product_id: product.id, counted_quantity: 17 }],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("submitted");
    expect(res.body.data.shiftId).toBe(shift.id);
    // systemCashTotalNgn = 0 (all 3 sales pre-date the shift opening)
    expect(res.body.data.systemCashTotalNgn).toBe(0);
    // variance = transfers_counted - system = 7500 - 0 = 7500
    expect(res.body.data.varianceNgn).toBe(7500);

    // Verify the shift row is now 'closed' with closed_at set
    const shiftRes = await call<{ data: ShiftOpenRow }>(
      "GET",
      `/v1/branches/${branch.id}/shift-open/${shift.id}`,
    );
    expect(shiftRes.status).toBe(200);
    expect(shiftRes.body.data.status).toBe("closed");
    expect(shiftRes.body.data.closedAt).toBeTruthy();
  });

  it("(c) second close attempt (no open shift) → 409 conclusive", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // The previous test already closed the shift; no open shift remains
    const res = await call<{ error: { code: string } }>(
      "POST",
      `/v1/branches/${branch.id}/daily-close`,
      {
        business_date: today,
        cash_counted_ngn: 0,
        transfers_counted_ngn: 7500,
        stock_counts: [{ product_id: product.id, counted_quantity: 17 }],
      },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("(d) shift-window reconciliation excludes sales before opened_at", async () => {
    // Use a FRESH branch so we start clean (no prior sales or closes)
    const bRes = await call<{ data: Branch }>("POST", "/v1/branches", {
      name: "Window Test Branch",
      code: "WTB",
      delivery_zones: [],
    });
    const winBranch = bRes.body.data;

    // Pre-stock
    await call("POST", "/v1/inventory/adjust", {
      location_type: "branch",
      location_id: winBranch.id,
      reason_code: "opening_balance",
      items: [{ product_id: product.id, new_quantity: 10 }],
    });

    // The sale-creation gate requires an OPEN shift. Open a temporary shift so
    // the "pre-shift" sale can be created, then close it and open the real shift.
    // The reconciliation window is determined by opened_at of the REAL shift,
    // so using created_at_local = 1hr ago still places this sale "before" the
    // real shift window.
    const today = new Date().toISOString().slice(0, 10);
    const tempShift = await call<{ data: { id: string } }>(
      "POST",
      `/v1/branches/${winBranch.id}/shift-open`,
      { business_date: today, stock_counts: [] },
    );

    // Sale BEFORE the real shift opens — use a timestamp in the past (1 hour ago)
    const beforeShift = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const saleBeforeRes = await call<{ data: SaleOrderRow }>(
      "POST",
      `/v1/branches/${winBranch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method: "transfer",
        created_at_local: beforeShift,
      },
    );
    await call("PATCH", `/v1/branches/${winBranch.id}/sales/${saleBeforeRes.body.data.id}/pay`);

    // Close the temp shift so we can open the real shift (shift_number=2).
    // The real shift's opened_at will be AFTER beforeShift (1hr ago), which is
    // what the reconciliation uses to exclude the pre-shift sale.
    {
      const { createDbClient, shiftOpen } = await import("@ms/db");
      const { eq } = await import("drizzle-orm");
      const tmpDb = createDbClient(process.env.DATABASE_URL!);
      await tmpDb
        .update(shiftOpen)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(shiftOpen.id, tempShift.body.data.id));
    }

    // Open the REAL shift NOW (after beforeShift timestamp)
    // winBranch has 10 on-hand (but 1 sale already done before shift),
    // system qty = 9 after that sale. Count 9 (no variance).
    const winShift = await openShift(winBranch.id, today, 9);
    expect(winShift.status).toBe("open");

    // Sale INSIDE the shift window — use current time (shift is already open)
    const insideShift = new Date().toISOString();
    const saleInsideRes = await call<{ data: SaleOrderRow }>(
      "POST",
      `/v1/branches/${winBranch.id}/sales`,
      {
        channel: "walkup",
        items: [{ product_id: product.id, quantity: 1 }],
        payment_method: "transfer",
        created_at_local: insideShift,
      },
    );
    await call("PATCH", `/v1/branches/${winBranch.id}/sales/${saleInsideRes.body.data.id}/pay`);

    // Close — reconciliation should only see the in-window sale (₦2,500)
    const closeRes = await call<{ data: CloseRow }>(
      "POST",
      `/v1/branches/${winBranch.id}/daily-close`,
      {
        business_date: today,
        cash_counted_ngn: 0,
        transfers_counted_ngn: 2500,
        stock_counts: [{ product_id: product.id, counted_quantity: 8 }],
      },
    );
    expect(closeRes.status).toBe(201);
    // systemCashTotalNgn must reflect ONLY the in-window sale (₦2,500), not both (₦5,000)
    expect(closeRes.body.data.systemCashTotalNgn).toBe(2500);
    expect(closeRes.body.data.varianceNgn).toBe(0);
    expect(closeRes.body.data.shiftId).toBe(winShift.id);
  });

  it("owner approves a submitted close", async () => {
    const list = await call<{ data: CloseRow[] }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close`,
    );
    // Find the submitted close (from test b)
    const target = list.body.data.find((c) => c.status === "submitted");
    expect(target).toBeDefined();
    const approve = await call<{ data: CloseRow }>(
      "PATCH",
      `/v1/branches/${branch.id}/daily-close/${target!.id}/approve`,
    );
    expect(approve.body.data.status).toBe("approved");
  });

  it("list returns shift_number, opened_at, closed_at from joined shift_open", async () => {
    const list = await call<{ data: CloseRow[] }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close`,
    );
    expect(list.status).toBe(200);
    // Find the close linked to a shift (from test b)
    const withShift = list.body.data.find((c) => c.shiftId != null);
    expect(withShift).toBeDefined();
    expect(withShift!.shiftNumber).toBeGreaterThanOrEqual(1);
    expect(withShift!.openedAt).toBeTruthy();
    expect(withShift!.closedAt).toBeTruthy();
  });

  it("revenue report aggregates today's sales", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{
      data: Array<{ branch_id: string; channel: string; gross_ngn: number; orders: number }>;
    }>("GET", `/v1/reports/revenue?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const ours = res.body.data.find((r) => r.branch_id === branch.id);
    expect(ours).toBeDefined();
    expect(ours!.gross_ngn).toBe(7500);
    expect(ours!.orders).toBe(3);
  });

  it("top-products report ranks our product", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{
      data: Array<{ product_id: string; quantity: number; revenue_ngn: number }>;
    }>("GET", `/v1/reports/top-products?from=${today}&to=${today}`);
    const hit = res.body.data.find((p) => p.product_id === product.id);
    expect(hit).toBeDefined();
    expect(hit!.quantity).toBeGreaterThanOrEqual(3);
    expect(hit!.revenue_ngn).toBeGreaterThanOrEqual(7500);
  });

  it("close detail includes the linked shift_open via shift_id", async () => {
    // Find the close from test (b)
    const list = await call<{ data: CloseRow[] }>(
      "GET",
      `/v1/branches/${branch.id}/daily-close`,
    );
    const target = list.body.data[0]!;

    const detailRes = await call<{
      data: {
        shiftId: string | null;
        shift_open: {
          id: string;
          opened_by: string | null;
          stock_counts: Array<{ productId: string; countedQuantity: number }>;
        } | null;
      };
    }>("GET", `/v1/branches/${branch.id}/daily-close/${target.id}`);
    expect(detailRes.status).toBe(200);
    // The close was linked to a shift (test b), so shift_open must be present
    if (target.shiftId) {
      expect(detailRes.body.data.shift_open).not.toBeNull();
    }
  });
});
