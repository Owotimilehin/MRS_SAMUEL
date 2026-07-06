import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { makeTestApp, authOwner, authBranchStaff } from "./helpers.js";

/**
 * Integration tests for the active payment-provider settings endpoints
 * (GET/PATCH /v1/settings/payment-provider). The owner toggles the provider
 * used by new online orders; the seam defaults to OPay when unset.
 */
describe("settings payment provider", () => {
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

  it("defaults to opay when unset", async () => {
    const { cookie } = await authOwner(app);
    const res = await app.request("/v1/settings/payment-provider", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "opay" });
  });

  it("owner can switch to payaza and GET reflects it", async () => {
    const { cookie } = await authOwner(app);
    const patch = await app.request("/v1/settings/payment-provider", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "payaza" }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ provider: "payaza" });

    const get = await app.request("/v1/settings/payment-provider", { headers: { cookie } });
    expect(await get.json()).toEqual({ provider: "payaza" });

    // Restore the default so ordering between tests doesn't leak state.
    await app.request("/v1/settings/payment-provider", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "opay" }),
    });
  });

  it("rejects an invalid provider value", async () => {
    const { cookie } = await authOwner(app);
    const res = await app.request("/v1/settings/payment-provider", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "stripe" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a write without settings.manage capability", async () => {
    const { cookie } = await authBranchStaff(app);
    const res = await app.request("/v1/settings/payment-provider", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "payaza" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated write", async () => {
    const res = await app.request("/v1/settings/payment-provider", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "payaza" }),
    });
    expect(res.status).toBe(401);
  });
});
