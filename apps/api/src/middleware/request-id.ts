import type { MiddlewareHandler } from "hono";
import { v4 as uuid } from "uuid";

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.header("x-request-id") ?? uuid();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}
