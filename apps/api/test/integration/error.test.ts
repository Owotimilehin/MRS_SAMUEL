import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { onError } from "../../src/middleware/error.js";
import { requestIdMiddleware } from "../../src/middleware/request-id.js";
import { BusinessError } from "../../src/lib/errors.js";

describe("error middleware", () => {
  const app = new Hono();
  app.use("*", requestIdMiddleware());
  app.onError(onError);
  app.get("/boom", () => {
    throw new BusinessError("not_found", "missing", 404);
  });
  app.get("/explode", () => {
    throw new Error("kaboom");
  });

  it("maps BusinessError to structured 404", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("not_found");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("maps unknown errors to 500 with request_id", async () => {
    const res = await app.request("/explode");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; details: { request_id?: string } } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.details.request_id).toBeTruthy();
  });
});
