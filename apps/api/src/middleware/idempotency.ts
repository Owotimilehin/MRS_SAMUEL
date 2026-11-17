import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import crypto from "node:crypto";
import { and, eq, lt, type SQL } from "drizzle-orm";
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
 * it over. It must stay well above the slowest handler. Checkout is the slowest:
 * its Turnstile call has no timeout of its own and can sit for about 5 minutes
 * before the platform gives up on the connection.
 */
const STALE_IN_PROGRESS_MS = 15 * 60_000;

/**
 * The only failures that are NOT remembered, so the same key can run again.
 *
 * A key is released only when the handler cannot have done its work: the
 * request was REJECTED, by an error thrown with one of these statuses.
 *
 *   - 401/403: no session or no permission; the request must run after re-login.
 *   - 429: turned away by the rate limiter before any handler ran.
 *   - 400/404/409/422: validation or a business rule (out of stock, no open
 *     shift). The till parks such a row and re-sends it under the same key when
 *     staff press Retry after fixing the cause; the no-JS checkout reuses one
 *     key for an hour. Re-running re-checks the rule against current data.
 *
 * Everything else is stored and replayed exactly as before, because the outcome
 * is unknown and running again could apply the change twice:
 *
 *   - any 5xx. Many handlers commit and only then do follow-up work (audit row,
 *     signing a receipt URL, an outbound call). A failure there is a 5xx with
 *     the change already saved, and clients retry 5xx automatically.
 *   - a non-2xx the handler RETURNED rather than threw: it chose that response
 *     itself, possibly after doing work.
 */
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);

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
     *  `stillTrue` (and still carries this request's payload) when the UPDATE
     *  takes the row lock. Exactly one of several concurrent callers can win;
     *  the rest are told the request is in flight. */
    const takeOver = async (stillTrue: SQL | undefined): Promise<void> => {
      const won = await db
        .update(idempotencyKey)
        .set({
          userId,
          endpoint: claim.endpoint,
          responseStatus: null,
          responseBody: null,
          status: "in_progress",
          firstSeenAt: claimedAt,
          expiresAt: claim.expiresAt,
        })
        .where(
          and(eq(idempotencyKey.key, key), eq(idempotencyKey.requestHash, reqHash), stillTrue),
        )
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
        // The earlier attempt was rejected and released the key between our
        // INSERT and SELECT. Claim it now; if someone else got there first,
        // they are in flight.
        inserted = await db
          .insert(idempotencyKey)
          .values(claim)
          .onConflictDoNothing({ target: idempotencyKey.key })
          .returning();
        if (inserted.length === 0) {
          throw new BusinessError("idempotency_in_flight", "request still in flight", 409);
        }
      } else {
        // Whatever state the key is in, a different payload never inherits it.
        if (existing.requestHash !== reqHash) {
          throw new BusinessError(
            "idempotency_key_reused",
            "idempotency key reused with different payload",
            409,
          );
        }
        if (existing.status === "in_progress") {
          const staleBefore = new Date(claimedAt.getTime() - STALE_IN_PROGRESS_MS);
          if (existing.firstSeenAt.getTime() >= staleBefore.getTime()) {
            throw new BusinessError("idempotency_in_flight", "request still in flight", 409);
          }
          // Abandoned claim. Take it over atomically: the WHERE re-checks the
          // staleness under the row lock, so of two concurrent retries only
          // one UPDATE matches and the other is turned away as in flight.
          await takeOver(
            and(
              eq(idempotencyKey.status, "in_progress"),
              lt(idempotencyKey.firstSeenAt, staleBefore),
            ),
          );
        } else if (
          existing.status === "done" &&
          existing.responseStatus !== null &&
          REJECTED_STATUSES.has(existing.responseStatus)
        ) {
          // A rejection stored by the old middleware, which stored every
          // response as "done" (rows live for 30 days). Treat it like a
          // released key so the retry finally executes. Failures this version
          // chooses to keep are stored as "failed" and never come here. The
          // WHERE insists the row is STILL that stored rejection: if a
          // concurrent retry has re-run it to success meanwhile, this must not
          // run it again.
          await takeOver(
            and(
              eq(idempotencyKey.status, "done"),
              eq(idempotencyKey.responseStatus, existing.responseStatus),
            ),
          );
        } else {
          return c.json(
            (existing.responseBody ?? {}) as Record<string, unknown>,
            (existing.responseStatus ?? 200) as ContentfulStatusCode,
          );
        }
      }
    }

    // We hold the claim. Hono turns a throwing handler into an error response
    // before next() returns and records the thrown error on the context.
    await next();

    const status = c.res.status;
    if (c.error !== undefined && REJECTED_STATUSES.has(status)) {
      // Rejected before doing its work: release the key so the retry executes.
      await db.delete(idempotencyKey).where(mine);
      return;
    }

    let body: unknown = null;
    try {
      body = await c.res.clone().json();
    } catch {
      /* not JSON */
    }
    // "done" = completed; "failed" = a failure kept on purpose (outcome
    // unknown). Both are replayed; the distinction keeps a kept failure apart
    // from the old middleware's stored rejections, which are retryable above.
    await db
      .update(idempotencyKey)
      .set({
        responseStatus: status,
        responseBody: body as Record<string, unknown>,
        status: status >= 200 && status < 300 ? "done" : "failed",
      })
      .where(mine);
  };
}
