import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { varianceLoss, branch, product } from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Totals { bottles: number; value_ngn: number; by_source: Record<string, { bottles: number; value_ngn: number }> }
interface Report { month: string; totals: Totals; by_flavour: Array<{ name: string; source: string; bottles: number; value_ngn: number }> }

describe("GET /reports/variance-losses", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  async function call<T>(path: string, cookie = cookies): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const [br] = await db.insert(branch).values({ name: "VL Branch", code: `VL-${Date.now()}` }).returning();
    const [pr] = await db.insert(product).values({ name: "VL Sunrise", slug: `vl-${Date.now()}`, category: "regular" }).returning();
    const mk = (source: "transfer" | "shift_close", qty: number, value: number, when: string) => ({
      source, sourceId: uuid(), branchId: br!.id, productId: pr!.id, variantId: null,
      sizeMl: 650, quantity: qty, unitPriceNgn: Math.round(value / qty), valueNgn: value, reason: "x",
      recordedByUserId: null, occurredAt: new Date(when),
    });
    await db.insert(varianceLoss).values([
      mk("transfer", 5, 17500, "2026-06-10T10:00:00Z"),
      mk("shift_close", 7, 24500, "2026-06-20T10:00:00Z"),
      mk("transfer", 3, 10500, "2026-05-15T10:00:00Z"), // different month — excluded
    ]);
  }, 120_000);

  afterAll(async () => { server.close(); await container.stop(); });

  it("aggregates losses for the month with by-source totals", async () => {
    const res = await call<{ data: Report }>("/v1/reports/variance-losses?month=2026-06");
    expect(res.status).toBe(200);
    expect(res.body.data.totals.bottles).toBe(12);
    expect(res.body.data.totals.value_ngn).toBe(42000);
    expect(res.body.data.totals.by_source.transfer).toEqual({ bottles: 5, value_ngn: 17500 });
    expect(res.body.data.totals.by_source.shift_close).toEqual({ bottles: 7, value_ngn: 24500 });
    expect(res.body.data.by_flavour).toHaveLength(2);
  });

  it("rejects a bad month", async () => {
    const res = await call("/v1/reports/variance-losses?month=2026");
    expect(res.status).toBe(400);
  });

  it("forbids a non-owner (manager lacks finance.view)", async () => {
    await seedUser(db, { email: "mgr-vl@example.com", role: "manager", password: "mgrpass123" });
    const mgr = await loginAs(baseUrl, "mgr-vl@example.com", "mgrpass123");
    const res = await call("/v1/reports/variance-losses?month=2026-06", mgr);
    expect(res.status).toBe(403);
  });
});
