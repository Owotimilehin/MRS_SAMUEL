import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("packaging: straw kind", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("creates a straw material and returns kind=straw", async () => {
    const res = await call<{ data: { id: string; kind: string } }>("POST", "/v1/packaging/materials", {
      name: "Straw", unit_label: "straw", kind: "straw",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe("straw");
  });
});
