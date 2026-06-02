import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("idempotency middleware", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("returns the original response on replay with same key + same body", async () => {
    const key = uuid();
    const body = JSON.stringify({ msg: "hello" });
    const r1 = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body,
    });
    const j1 = (await r1.json()) as Record<string, unknown>;
    const r2 = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body,
    });
    const j2 = (await r2.json()) as Record<string, unknown>;
    expect(j2).toEqual(j1);
  });

  it("returns 409 when same key reused with different body", async () => {
    const key = uuid();
    await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ msg: "a" }),
    });
    const r2 = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ msg: "different" }),
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_key_reused");
  });

  it("passes through requests without an idempotency-key header", async () => {
    const r = await fetch(`${baseUrl}/v1/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg: "no-key" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { msg: string } };
    expect(body.data.msg).toBe("no-key");
  });
});
