import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner } from "./helpers.js";
import { bundle } from "@ms/db";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public bundles", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    await tdb.db.insert(bundle).values({
      slug: "starter-6",
      name: "Starter 6-Pack",
      priceNgn: 14000,
      contentsLabel: "6 × 330ml",
      badge: "Most loved",
      displayOrder: 1,
    });
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("GET /v1/public/catalog/bundles returns active bundles", async () => {
    const res = await fetch(`${baseUrl}/v1/public/catalog/bundles`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ slug: string; price_ngn: number }> };
    expect(data[0]!.slug).toBe("starter-6");
    expect(data[0]!.price_ngn).toBe(14000);
  });

});
