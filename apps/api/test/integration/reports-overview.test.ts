import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("GET /v1/reports/overview", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

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
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("returns 200 with all numeric fields in contract shape", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`, {
      headers: { cookie: cookies },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
        fulfilment: {
          pos_orders_today: number;
          online_orders_today: number;
          online_pending: number;
          preorders_open: number;
          bags_queue: number;
          pending_transfers: number;
        };
        today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
      };
    };
    const { data } = json;

    expect(typeof data.stock.low_stock_factory).toBe("number");
    expect(typeof data.stock.low_stock_branch).toBe("number");
    expect(typeof data.stock.expiring_48h).toBe("number");
    expect(typeof data.fulfilment.pos_orders_today).toBe("number");
    expect(typeof data.fulfilment.online_orders_today).toBe("number");
    expect(typeof data.fulfilment.online_pending).toBe("number");
    expect(typeof data.fulfilment.preorders_open).toBe("number");
    expect(typeof data.fulfilment.bags_queue).toBe("number");
    expect(typeof data.fulfilment.pending_transfers).toBe("number");
    expect(typeof data.today.total_units).toBe("number");
    expect(Array.isArray(data.today.units_by_size)).toBe(true);
    // money must NOT leak into the operational overview
    expect((data as Record<string, unknown>).growth).toBeUndefined();
    expect((data.today as Record<string, unknown>).net_ngn).toBeUndefined();
  });

  it("empty seeded DB yields all zeros", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`, {
      headers: { cookie: cookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
        fulfilment: {
          pos_orders_today: number;
          online_orders_today: number;
          online_pending: number;
          preorders_open: number;
          bags_queue: number;
          pending_transfers: number;
        };
        today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
      };
    };

    expect(data.stock.low_stock_factory).toBe(0);
    expect(data.stock.low_stock_branch).toBe(0);
    expect(data.stock.expiring_48h).toBe(0);
    expect(data.fulfilment.pos_orders_today).toBe(0);
    expect(data.fulfilment.online_orders_today).toBe(0);
    expect(data.fulfilment.online_pending).toBe(0);
    expect(data.fulfilment.preorders_open).toBe(0);
    expect(data.fulfilment.bags_queue).toBe(0);
    expect(data.fulfilment.pending_transfers).toBe(0);
    expect(data.today.total_units).toBe(0);
    expect(data.today.units_by_size).toEqual([]);
  });

  it("returns 401 without auth cookie", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`);
    expect(res.status).toBe(401);
  });

  it("counts ONLY real online orders / genuine awaiting-fulfilment — not whatsapp counter sales or unpaid orders", async () => {
    // Reproduces the prod dashboard lie: "Online orders today" and "awaiting
    // fulfilment" were lumping whatsapp/phone counter sales (which sit at 'paid'
    // forever like walk-ups) and unpaid 'confirmed' online orders into the
    // counts. The honest definitions (matching the owner Orders worklist):
    //   online_orders_today = channel='online' placed today
    //   online_pending      = channel='online' AND not preorder AND status='paid'
    const { createDbClient, saleOrder, branch } = await import("@ms/db");
    const db = createDbClient(process.env.DATABASE_URL!);
    const [b] = await db
      .insert(branch)
      .values({ name: "Test Branch", code: `B-${uuid().slice(0, 8)}` })
      .returning({ id: branch.id });

    const mk = (channel: string, status: string, paymentStatus: string) =>
      db.insert(saleOrder).values({
        orderNumber: `T-${uuid()}`,
        branchId: b.id,
        channel: channel as never,
        status: status as never,
        paymentStatus: paymentStatus as never,
        paymentMethod: "card" as never,
        subtotalNgn: 1000,
        totalNgn: 1000,
        isPreorder: false,
        createdAtLocal: new Date(),
        idempotencyKey: uuid(),
      });

    await mk("whatsapp", "paid", "paid"); // counter sale — must NOT count anywhere
    await mk("online", "confirmed", "pending"); // unpaid — an online order today, NOT awaiting fulfilment
    await mk("online", "paid", "paid"); // genuinely paid, not yet dispatched — IS awaiting fulfilment
    await mk("online", "delivered", "paid"); // online order today, already done — NOT awaiting fulfilment

    const res = await fetch(`${baseUrl}/v1/reports/overview`, { headers: { cookie: cookies } });
    const { data } = (await res.json()) as {
      data: { fulfilment: { online_orders_today: number; online_pending: number } };
    };

    // 3 online orders today (confirmed + paid + delivered); the whatsapp one excluded.
    expect(data.fulfilment.online_orders_today).toBe(3);
    // Only the single paid-not-yet-dispatched online order awaits fulfilment.
    expect(data.fulfilment.online_pending).toBe(1);
  });
});
