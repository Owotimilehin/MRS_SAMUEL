import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
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
        stock: { low_stock_skus: number; expiring_48h: number };
        fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number };
        today: { net_ngn: number; yesterday_net_ngn: number; wtd_net_ngn: number };
        growth: {
          month_revenue_ngn: number;
          month_expenses_ngn: number;
          month_profit_ngn: number;
          active_subscriptions: number;
          mrr_ngn: number;
          new_leads: number;
        };
      };
    };
    const { data } = json;

    // stock block
    expect(typeof data.stock.low_stock_skus).toBe("number");
    expect(typeof data.stock.expiring_48h).toBe("number");

    // fulfilment block
    expect(typeof data.fulfilment.orders_pending).toBe("number");
    expect(typeof data.fulfilment.preorders_open).toBe("number");
    expect(typeof data.fulfilment.bags_queue).toBe("number");

    // today block
    expect(typeof data.today.net_ngn).toBe("number");
    expect(typeof data.today.yesterday_net_ngn).toBe("number");
    expect(typeof data.today.wtd_net_ngn).toBe("number");

    // growth block
    expect(typeof data.growth.month_revenue_ngn).toBe("number");
    expect(typeof data.growth.month_expenses_ngn).toBe("number");
    expect(typeof data.growth.month_profit_ngn).toBe("number");
    expect(typeof data.growth.active_subscriptions).toBe("number");
    expect(typeof data.growth.mrr_ngn).toBe("number");
    expect(typeof data.growth.new_leads).toBe("number");
  });

  it("empty seeded DB yields all zeros", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`, {
      headers: { cookie: cookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, Record<string, number>> };

    expect(data.stock.low_stock_skus).toBe(0);
    expect(data.stock.expiring_48h).toBe(0);
    expect(data.fulfilment.orders_pending).toBe(0);
    expect(data.fulfilment.preorders_open).toBe(0);
    expect(data.fulfilment.bags_queue).toBe(0);
    expect(data.today.net_ngn).toBe(0);
    expect(data.today.yesterday_net_ngn).toBe(0);
    expect(data.today.wtd_net_ngn).toBe(0);
    expect(data.growth.month_revenue_ngn).toBe(0);
    expect(data.growth.month_expenses_ngn).toBe(0);
    expect(data.growth.month_profit_ngn).toBe(0);
    expect(data.growth.active_subscriptions).toBe(0);
    expect(data.growth.mrr_ngn).toBe(0);
    expect(data.growth.new_leads).toBe(0);
  });

  it("month_profit_ngn === month_revenue_ngn - month_expenses_ngn", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`, {
      headers: { cookie: cookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        growth: {
          month_revenue_ngn: number;
          month_expenses_ngn: number;
          month_profit_ngn: number;
        };
      };
    };
    expect(data.growth.month_profit_ngn).toBe(
      data.growth.month_revenue_ngn - data.growth.month_expenses_ngn,
    );
  });

  it("returns 401 without auth cookie", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`);
    expect(res.status).toBe(401);
  });
});
