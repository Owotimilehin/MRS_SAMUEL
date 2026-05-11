import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { deviceStatus, type DbClient } from "@ms/db";
import { requireAuth, requireRole } from "../middleware/auth.js";

const Telemetry = z.object({
  device_id: z.string().min(1),
  app_version: z.string(),
  queue_depth: z.number().int().nonnegative(),
  last_sync_at: z.string().datetime().nullable().optional(),
});

export function telemetryRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

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

  r.get("/devices", requireRole("owner"), async (c) => {
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
