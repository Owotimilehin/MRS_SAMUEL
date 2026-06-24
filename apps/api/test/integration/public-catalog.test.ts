import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, seedCatalog, setOnlineDefaultBranch, addBranchStock } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public catalog stock", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  it("returns per-flavour available against the online-default branch", async () => {
    const { productId, branchId } = await seedCatalog(db);
    await setOnlineDefaultBranch(db, branchId);
    await addBranchStock(db, { branchId, productId, qty: 12 });

    const res = await fetch(`${baseUrl}/v1/public/catalog/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; available: number }> };
    const prod = body.data.find((p) => p.id === productId);
    expect(prod).toBeDefined();
    expect(prod!.available).toBe(12);
  });

  it("returns available=0 when no online-default branch is set", async () => {
    // Seed a fresh product; ensure no default branch is set (clear from previous test).
    const { productId, branchId } = await seedCatalog(db);
    // Clear any online-default branch from the previous test.
    const { branch } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    await db.update(branch).set({ isOnlineDefault: false }).where(eq(branch.isOnlineDefault, true));
    // Give this branch some stock — but since there's no online-default it should read 0.
    await addBranchStock(db, { branchId, productId, qty: 7 });

    const res = await fetch(`${baseUrl}/v1/public/catalog/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; available: number }> };
    const prod = body.data.find((p) => p.id === productId);
    expect(prod).toBeDefined();
    expect(prod!.available).toBe(0);
  });
});
