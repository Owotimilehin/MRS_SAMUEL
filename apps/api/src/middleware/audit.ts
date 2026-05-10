import type { Context } from "hono";
import { auditLog } from "@ms/db";
import type { DbClient } from "@ms/db";

export interface AuditContext {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(db: DbClient, c: Context, ctx: AuditContext): Promise<void> {
  const auth = c.get("auth") as
    | { userId: string; role: string; branchId: string | null; deviceId: string }
    | undefined;
  await db.insert(auditLog).values({
    actorUserId: auth?.userId ?? null,
    actorRole: auth?.role ?? null,
    actorBranchId: auth?.branchId ?? null,
    action: ctx.action,
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    beforeJson: (ctx.before as Record<string, unknown>) ?? null,
    afterJson: (ctx.after as Record<string, unknown>) ?? null,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    deviceId: auth?.deviceId ?? null,
    idempotencyKey: c.req.header("idempotency-key") ?? null,
  });
}
