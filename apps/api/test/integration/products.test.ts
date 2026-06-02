import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("products + prices", () => {
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

  it("requires auth on list", async () => {
    const res = await fetch(`${baseUrl}/v1/products`);
    expect(res.status).toBe(401);
  });

  it("starts empty and accepts a new product with initial price", async () => {
    const list = await fetch(`${baseUrl}/v1/products`, { headers: { cookie: cookies } });
    expect(list.status).toBe(200);
    const initial = (await list.json()) as { data: unknown[] };
    expect(Array.isArray(initial.data)).toBe(true);

    const create = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        name: "Test Juice",
        slug: "test-juice",
        category: "regular",
        ingredients: ["Carrot", "Orange"],
        initial_price_ngn: 1500,
      }),
    });
    expect(create.status).toBe(201);
    const { data } = (await create.json()) as { data: { id: string; slug: string } };
    expect(data.slug).toBe("test-juice");

    // Detail endpoint should report current_price_ngn = 1500
    const detail = await fetch(`${baseUrl}/v1/products/${data.id}`, { headers: { cookie: cookies } });
    const detailBody = (await detail.json()) as { data: { current_price_ngn: number } };
    expect(detailBody.data.current_price_ngn).toBe(1500);
  });

  it("publishes a new price and current_price_ngn updates", async () => {
    const create = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        name: "Price Test",
        slug: "price-test",
        category: "regular",
        initial_price_ngn: 1000,
      }),
    });
    const { data: prod } = (await create.json()) as { data: { id: string } };

    const publish = await fetch(`${baseUrl}/v1/products/${prod.id}/prices`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
      body: JSON.stringify({ price_ngn: 1500 }),
    });
    expect(publish.status).toBe(201);

    const detail = await fetch(`${baseUrl}/v1/products/${prod.id}`, { headers: { cookie: cookies } });
    const detailBody = (await detail.json()) as { data: { current_price_ngn: number } };
    expect(detailBody.data.current_price_ngn).toBe(1500);
  });
});
