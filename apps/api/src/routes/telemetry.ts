import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { deviceStatus, checkoutAttemptLog, outboxEvent, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { logger } from "../logger.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { checkoutLogSchema, statusForStage, isFailureStage } from "../lib/checkout-log.js";

const Telemetry = z.object({
  device_id: z.string().min(1),
  app_version: z.string(),
  queue_depth: z.number().int().nonnegative(),
  last_sync_at: z.string().datetime().nullable().optional(),
});

const ClientError = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  line: z.number().int().optional(),
  col: z.number().int().optional(),
  ts: z.string().datetime().optional(),
  ua: z.string().max(500).optional(),
  app: z.enum(["customer", "admin"]),
});

export function telemetryRoutes(db: DbClient) {
  const r = new Hono();

  // Frontend error reporting — accepts admin auth OR no auth, rate-limited.
  // We log to structured logs (captured by Render/Sentry/etc); a future
  // migration could persist to a client_error table if useful.
  r.post(
    "/error",
    rateLimit({ points: 60, durationSeconds: 60, keyPrefix: "telemetry-error" }),
    async (c) => {
      try {
        const body = ClientError.parse(await c.req.json());
        logger.error(
          {
            kind: "client_error",
            app: body.app,
            message: body.message,
            stack: body.stack,
            url: body.url,
            line: body.line,
            col: body.col,
            ua: body.ua,
            ts: body.ts,
            ip: c.req.header("x-forwarded-for") ?? null,
          },
          "frontend error report",
        );
      } catch {
        /* swallow malformed reports */
      }
      return c.body(null, 204);
    },
  );

  // Diagnostic log of a customer checkout attempt (one row per stage of a
  // "Place order" press). Public + rate-limited; it must never error back to
  // the customer (logging can't break checkout). On a failure stage it also
  // enqueues a Telegram alert via the outbox.
  r.post(
    "/checkout",
    rateLimit({ points: 60, durationSeconds: 300, keyPrefix: "checkout-log" }),
    async (c) => {
      try {
        const body = checkoutLogSchema.parse(await c.req.json());
        await db.insert(checkoutAttemptLog).values({
          attemptId: body.attempt_id,
          stage: body.stage,
          status: statusForStage(body.stage),
          orderNumber: body.order_number ?? null,
          customerName: body.customer?.name ?? null,
          customerPhone: body.customer?.phone ?? null,
          customerEmail: body.customer?.email ?? null,
          deliveryAddress: body.customer?.address ?? null,
          deliveryState: body.customer?.state ?? null,
          deliveryWindow: body.delivery_window ?? null,
          scheduledFor: body.scheduled_for ? new Date(body.scheduled_for) : null,
          itemsJson: body.items ?? null,
          totalNgn: body.total_ngn ?? null,
          errorMessage: body.error_message ?? null,
          responseJson: body.response ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        });
        if (isFailureStage(body.stage)) {
          await db.insert(outboxEvent).values({
            eventType: "checkout.failed",
            payload: {
              attempt_id: body.attempt_id,
              stage: body.stage,
              customer_name: body.customer?.name ?? null,
              customer_phone: body.customer?.phone ?? null,
              order_number: body.order_number ?? null,
              error_message: body.error_message ?? null,
            },
          });
        }
      } catch {
        /* swallow malformed/oversized reports — logging must never 500 */
      }
      return c.body(null, 204);
    },
  );

  r.use("/sync", requireAuth());
  r.use("/devices", requireAuth());

  r.post("/sync", async (c) => {
    const body = Telemetry.parse(await c.req.json());
    const auth = c.get("auth");
    await db
      .insert(deviceStatus)
      .values({
        deviceId: body.device_id,
        branchId: auth.branchId ?? null,
        appVersion: body.app_version,
        queueDepth: body.queue_depth,
        lastSyncAt: body.last_sync_at ? new Date(body.last_sync_at) : null,
        reportedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: deviceStatus.deviceId,
        set: {
          appVersion: body.app_version,
          queueDepth: body.queue_depth,
          lastSyncAt: body.last_sync_at ? new Date(body.last_sync_at) : null,
          reportedAt: new Date(),
        },
      });
    return c.body(null, 204);
  });

  r.get("/devices", requireCapability("devices.view"), async (c) => {
    const rows = await db.execute<{
      device_id: string;
      branch_id: string | null;
      app_version: string | null;
      queue_depth: number;
      last_sync_at: string | null;
      reported_at: string;
      age_seconds: number;
    }>(sql`
      SELECT device_id, branch_id, app_version, queue_depth,
             last_sync_at, reported_at,
             EXTRACT(EPOCH FROM (NOW() - reported_at))::int AS age_seconds
      FROM device_status
      ORDER BY reported_at DESC
    `);
    return c.json({ data: rows });
  });

  return r;
}
