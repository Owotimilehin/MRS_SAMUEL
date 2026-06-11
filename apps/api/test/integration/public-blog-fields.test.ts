import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner } from "./helpers.js";
import { blogPost } from "@ms/db";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("public blog content fields", () => {
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

    await db.insert(blogPost).values({
      slug: "field-test",
      title: "Field Test",
      excerpt: "x",
      bodyMd: "## Heading\n\nBody.",
      author: "Mrs. Samuel",
      readMins: 5,
      category: "Wellness",
      cluster: "root",
      publishedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("list includes author/read_mins/category/cluster", async () => {
    const res = await fetch(`${baseUrl}/v1/public/blog`);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    const post = data.find((p) => p["slug"] === "field-test")!;
    expect(post["author"]).toBe("Mrs. Samuel");
    expect(post["read_mins"]).toBe(5);
    expect(post["category"]).toBe("Wellness");
    expect(post["cluster"]).toBe("root");
  });

  it("detail includes the same fields plus body_md", async () => {
    const res = await fetch(`${baseUrl}/v1/public/blog/field-test`);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data["author"]).toBe("Mrs. Samuel");
    expect(data["read_mins"]).toBe(5);
    expect(data["category"]).toBe("Wellness");
    expect(data["cluster"]).toBe("root");
    expect(data["body_md"]).toContain("Heading");
  });
});
