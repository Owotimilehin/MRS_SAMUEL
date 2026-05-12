import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { idempotencyKey } from "@ms/db";
import type { DbClient } from "@ms/db";
import { BusinessError } from "../lib/errors.js";

const TTL_DAYS = 30;

function hashBody(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function idempotencyMiddleware(db: DbClient): MiddlewareHandler {
  return async (c, next) => {
    if (!["POST", "PATCH", "PUT"].includes(c.req.method)) return next();
    const key = c.req.header("idempotency-key");
    if (!key) return next();

    const raw = await c.req.raw.clone().text();
    const reqHash = hashBody(raw);
    const auth = c.get("auth") as { userId: string } | undefined;
    const userId = auth?.userId ?? null;

    const inserted = await db
      .insert(idempotencyKey)
      .values({
        key,
        userId,
        endpoint: c.req.path,
        requestHash: reqHash,
        status: "in_progress",
        expiresAt: new Date(Date.now() + TTL_DAYS * 86_400_000),
      })
      .onConflictDoNothing({ target: idempotencyKey.key })
      .returning();

    if (inserted.length === 0) {
      const [existing] = await db
        .select()
        .from(idempotencyKey)
        .where(eq(idempotencyKey.key, key));
      if (!existing) throw new BusinessError("conflict", "idempotency race", 409);
      if (existing.requestHash !== reqHash) {
        throw new BusinessError(
          "idempotency_key_reused",
          "idempotency key reused with different payload",
          409,
        );
      }
      if (existing.status === "in_progress") {
        throw new BusinessError("idempotency_in_flight", "request still in flight", 409);
      }
      return c.json(
        (existing.responseBody ?? {}) as Record<string, unknown>,
        (existing.responseStatus ?? 200) as ContentfulStatusCode,
      );
    }

    await next();

    const status = c.res.status;
    let body: unknown = null;
    try {
      body = await c.res.clone().json();
    } catch {
      /* not JSON */
    }
    await db
      .update(idempotencyKey)
      .set({
        responseStatus: status,
        responseBody: body as Record<string, unknown>,
        status: "done",
      })
      .where(eq(idempotencyKey.key, key));
  };
}
