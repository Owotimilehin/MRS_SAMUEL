import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Bucket {
  date: string;
  gross_ngn: number;
  net_ngn: number;
  orders: number;
}

describe("reports/timeseries", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

  async function get(path: string): Promise<{ status: number; body: { data: Bucket[] } }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookies } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : { data: [] } };
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
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("day interval is zero-filled and continuous across the whole range", async () => {
    const res = await get("/v1/reports/timeseries?from=2026-06-01&to=2026-06-07&interval=day");
    expect(res.status).toBe(200);
    const rows = res.body.data;
    // 7 inclusive days, one bucket each.
    expect(rows).toHaveLength(7);
    expect(rows[0]!.date).toBe("2026-06-01");
    expect(rows[6]!.date).toBe("2026-06-07");
    // No sales seeded → every bucket zero.
    for (const r of rows) {
      expect(r.gross_ngn).toBe(0);
      expect(r.net_ngn).toBe(0);
      expect(r.orders).toBe(0);
    }
    // Dates strictly ascending.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.date > rows[i - 1]!.date).toBe(true);
    }
  });

  it("week interval buckets to week starts", async () => {
    const res = await get("/v1/reports/timeseries?from=2026-06-01&to=2026-06-21&interval=week");
    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.orders).toBe(0);
      expect(r.net_ngn).toBe(0);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.date > rows[i - 1]!.date).toBe(true);
    }
  });

  it("defaults to a 30-day window when no range is given", async () => {
    const res = await get("/v1/reports/timeseries");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});
