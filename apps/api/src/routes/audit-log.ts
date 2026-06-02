import { Hono } from "hono";
import { and, desc, eq, gte, lte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLog, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";

/**
 * Owner-only audit log reader. Filters by actor / entity / action / date.
 * Pagination is keyset on `occurred_at` for stable ordering as new rows arrive.
 */
const ListQuery = z.object({
  entity_type: z.string().optional(),
  action: z.string().optional(),
  actor_user_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditLogRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("audit.view"));

  r.get("/", async (c) => {
    const url = new URL(c.req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams));

    const conds = [];
    if (q.entity_type) conds.push(eq(auditLog.entityType, q.entity_type));
    if (q.action) conds.push(eq(auditLog.action, q.action));
    if (q.actor_user_id) conds.push(eq(auditLog.actorUserId, q.actor_user_id));
    if (q.from) conds.push(gte(auditLog.occurredAt, new Date(q.from)));
    if (q.to) conds.push(lte(auditLog.occurredAt, new Date(q.to)));
    if (q.before) conds.push(lt(auditLog.occurredAt, new Date(q.before)));

    const rows =
      conds.length > 0
        ? await db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.occurredAt)).limit(q.limit)
        : await db.select().from(auditLog).orderBy(desc(auditLog.occurredAt)).limit(q.limit);

    return c.json({
      data: rows,
      next_before: rows.length === q.limit ? rows[rows.length - 1]?.occurredAt : null,
    });
  });

  r.get("/facets", async (c) => {
    const entityTypes = await db.execute<{ entity_type: string }>(sql`
      SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type
    `);
    const actions = await db.execute<{ action: string }>(sql`
      SELECT DISTINCT action FROM audit_log ORDER BY action
    `);
    return c.json({
      data: {
        entity_types: Array.from(entityTypes).map((r) => r.entity_type),
        actions: Array.from(actions).map((r) => r.action),
      },
    });
  });

  return r;
}
