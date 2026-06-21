import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * The online-fulfilment default branch.
 *
 * Exactly one branch may carry is_online_default=true; setting it on one branch
 * must clear it on every other. The public catalog exposes the flag so checkout
 * can route web orders to that branch (falling back to the first when none set).
 */
describe("online-default branch", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

  async function createBranch(code: string): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/branches`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({ name: `Branch ${code}`, code }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  async function patchOnlineDefault(id: string): Promise<number> {
    const res = await fetch(`${baseUrl}/v1/branches/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({ is_online_default: true }),
    });
    return res.status;
  }

  async function listBranches(): Promise<Array<{ id: string; isOnlineDefault: boolean }>> {
    const res = await fetch(`${baseUrl}/v1/branches`, { headers: { cookie: cookies } });
    return ((await res.json()) as { data: Array<{ id: string; isOnlineDefault: boolean }> }).data;
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
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("enforces a single online-default branch", async () => {
    const a = await createBranch("ALPHA");
    const b = await createBranch("BETA");

    expect(await patchOnlineDefault(a)).toBe(200);
    let list = await listBranches();
    expect(list.find((x) => x.id === a)?.isOnlineDefault).toBe(true);

    // Setting BETA must clear ALPHA.
    expect(await patchOnlineDefault(b)).toBe(200);
    list = await listBranches();
    expect(list.find((x) => x.id === a)?.isOnlineDefault).toBe(false);
    expect(list.find((x) => x.id === b)?.isOnlineDefault).toBe(true);
    expect(list.filter((x) => x.isOnlineDefault).length).toBe(1);
  });

  it("exposes is_online_default on the public catalog", async () => {
    const id = await createBranch("PUBC");
    expect(await patchOnlineDefault(id)).toBe(200);
    const res = await fetch(`${baseUrl}/v1/public/catalog/branches`);
    const rows = ((await res.json()) as { data: Array<{ id: string; is_online_default?: boolean }> }).data;
    expect(rows.find((x) => x.id === id)?.is_online_default).toBe(true);
  });
});
