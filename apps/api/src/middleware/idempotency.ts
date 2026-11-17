import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import crypto from "node:crypto";
import { and, eq, gte, lt, or, type SQL } from "drizzle-orm";
import { idempotencyKey } from "@ms/db";
import type { DbClient } from "@ms/db";
import { BusinessError } from "../lib/errors.js";

const TTL_DAYS = 30;

/**
 * How long an "in progress" claim is believed. A request that is still running
 * holds its key so a concurrent duplicate is turned away (409
 * idempotency_in_flight). But a request cut off mid-flight (deploy, crash)
 * never finishes its row, and would otherwise block every retry for the 30-day
 * TTL. Past this window the claim is treated as abandoned and a retry may take
 * it over. It must stay comfortably above the slowest handler: outbound calls
 * are capped at 8s (OPay) and the proxies in front of us give up at 60-100s, so
 * a request that is still genuinely running after 5 minutes is not expected.
 */
const STALE_IN_PROGRESS_MS = 5 * 60_000;

/**
 * Only a completed operation is remembered and replayed. A non-2xx response
 * from this API means the request was rejected or failed, almost always as a
 * thrown error (see middleware/error.ts) that rolled the handler's transaction
 * back. Nothing completed, so there is nothing to protect from running twice,
 * and replaying the failure only stops the retry from ever succeeding:
 *
 *   - 401/403: the session lapsed; the same request must run after re-login.
 *   - 429/5xx: transient; the caller is expected to retry with the same key.
 *   - 400/404/409/422: a rule was not met at that moment (out of stock, no open
 *     shift). No caller relies on these being replayed: the till's sync engine
 *     parks such a row at once and only re-sends it, under the same key, when
 *     staff press Retry after fixing the cause; the no-JS checkout reuses one
 *     key for an hour. A stored rejection would make both futile. Re-running
 *     instead re-checks the rule against current data.
 */
function isCompleted(status: number): boolean {
  return status >= 200 && status < 300;
}

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

    // The claim time doubles as this request's ownership token: the finishing
    // UPDATE/DELETE below only touch the row while it still carries it, so a
    // request whose claim was taken over as stale cannot overwrite its successor.
    const claimedAt = new Date();
    const claim = {
      key,
      userId,
      endpoint: c.req.path,
      requestHash: reqHash,
      status: "in_progress",
      firstSeenAt: claimedAt,
      expiresAt: new Date(claimedAt.getTime() + TTL_DAYS * 86_400_000),
    };
    const mine = and(
      eq(idempotencyKey.key, key),
      eq(idempotencyKey.status, "in_progress"),
      eq(idempotencyKey.firstSeenAt, claimedAt),
    );

    /** Re-claim an existing row for this request, but only if it still matches
     *  `stillTrue` when the UPDATE takes the row lock. Exactly one of several
     *  concurrent callers can win; the rest are told the request is in flight. */
    const takeOver = async (stillTrue: SQL | undefined): Promise<void> => {
      const won = await db
        .update(idempotencyKey)
        .set({
          userId,
          endpoint: claim.endpoint,
          requestHash: reqHash,
          responseStatus: null,
          responseBody: null,
          status: "in_progress",
          firstSeenAt: claimedAt,
          expiresAt: claim.expiresAt,
        })
        .where(and(eq(idempotencyKey.key, key), stillTrue))
        .returning({ key: idempotencyKey.key });
      if (won.length === 0) {
        throw new BusinessError("idempotency_in_flight", "request still in flight", 409);
      }
    };

    // The primary key makes the claim atomic: of any number of concurrent
    // requests with this key, exactly one INSERT returns a row.
    let inserted = await db
      .insert(idempotencyKey)
      .values(claim)
      .onConflictDoNothing({ target: idempotencyKey.key })
      .returning();

    if (inserted.length === 0) {
      const [existing] = await db
        .select()
        .from(idempotencyKey)
        .where(eq(idempotencyKey.key, key));
      if (!existing) {
        // The earlier attempt failed and released the key between our INSERT
        // and SELECT. Claim it now; if someone else got there first, they are
        // in flight.
        inserted = await db
          .insert(idempotencyKey)
          .values(claim)
          .onConflictDoNothing({ target: idempotencyKey.key })
          .returning();
        if (inserted.length === 0) {
          throw new BusinessError("idempotency_in_flight", "request still in flight", 409);
        }
      } else if (
        existing.status === "in_progress" &&
        existing.firstSeenAt.getTime() < claimedAt.getTime() - STALE_IN_PROGRESS_MS
      ) {
        // Abandoned claim. Take it over atomically: the WHERE re-checks the
        // staleness under the row lock, so of two concurrent retries only one
        // UPDATE matches and the other is turned away as in flight.
        await takeOver(
          and(
            eq(idempotencyKey.status, "in_progress"),
            lt(idempotencyKey.firstSeenAt, new Date(claimedAt.getTime() - STALE_IN_PROGRESS_MS)),
          ),
        );
      } else if (existing.status === "done" && !isCompleted(existing.responseStatus ?? 200)) {
        // A failure stored before failures stopped being stored (rows live for
        // 30 days). Treat it like a released key so the retry finally executes.
        // The WHERE insists the row is STILL a stored failure: if a concurrent
        // retry has re-run it to success meanwhile, this must not run it again.
        await takeOver(
          and(
            eq(idempotencyKey.status, "done"),
            or(lt(idempotencyKey.responseStatus, 200), gte(idempotencyKey.responseStatus, 300)),
          ),
        );
      } else {
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
    }

    // We hold the claim. Hono turns a throwing handler into an error response
    // before next() returns, so the status check below sees it; the catch only
    // covers a failure that escapes that handling.
    try {
      await next();
    } catch (err) {
      await db.delete(idempotencyKey).where(mine);
      throw err;
    }

    const status = c.res.status;
    if (!isCompleted(status)) {
      // Nothing completed: release the key so the retry executes.
      await db.delete(idempotencyKey).where(mine);
      return;
    }

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
      .where(mine);
  };
}
