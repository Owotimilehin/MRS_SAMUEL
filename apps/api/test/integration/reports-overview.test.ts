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
        stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
        fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number; pending_transfers: number };
        today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
      };
    };
    const { data } = json;

    expect(typeof data.stock.low_stock_factory).toBe("number");
    expect(typeof data.stock.low_stock_branch).toBe("number");
    expect(typeof data.stock.expiring_48h).toBe("number");
    expect(typeof data.fulfilment.orders_pending).toBe("number");
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
        fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number; pending_transfers: number };
        today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
      };
    };

    expect(data.stock.low_stock_factory).toBe(0);
    expect(data.stock.low_stock_branch).toBe(0);
    expect(data.stock.expiring_48h).toBe(0);
    expect(data.fulfilment.orders_pending).toBe(0);
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
});
