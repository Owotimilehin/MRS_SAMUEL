import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { makeTestApp, authOwner } from "./helpers.js";

/**
 * Integration tests for the site-banner settings endpoints.
 *
 * Helper mapping (brief placeholder → real helper):
 *   createTestApp  → makeTestApp   (spins up a Hono app against a real testcontainer DB)
 *   authHeaderFor(app, "owner") → authOwner(app)  (returns { cookie } for the seeded owner)
 *
 * makeTestApp already calls seedOwner internally, so no extra seeding is needed.
 */
describe("settings banner", () => {
  let app: Hono;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    const t = await makeTestApp();
    app = t.app;
    container = t.container;
  }, 90_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("returns a disabled default when unset", async () => {
    const res = await app.request("/v1/public/settings/banner");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, message: "" });
  });

  it("owner can set the banner and the public route returns it", async () => {
    const { cookie } = await authOwner(app);
    const patch = await app.request("/v1/settings/banner", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, message: "  330ml is bulk preorder only  " }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ enabled: true, message: "330ml is bulk preorder only" });

    const pub = await app.request("/v1/public/settings/banner");
    expect(await pub.json()).toEqual({ enabled: true, message: "330ml is bulk preorder only" });
  });

  it("rejects an unauthenticated write", async () => {
    const res = await app.request("/v1/settings/banner", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, message: "x" }),
    });
    expect(res.status).toBe(401);
  });
});
