import type { Context } from "hono";
import { auditLog } from "@ms/db";
import type { DbClient } from "@ms/db";

export interface AuditContext {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /**
   * Override the actor when the request has no auth context yet — e.g. the
   * login endpoint, which is reached anonymously but knows exactly which user
   * just authenticated successfully.
   */
  actor?: {
    userId: string;
    role: string;
    branchId: string | null;
    deviceId?: string | null;
  };
}

export async function writeAudit(db: DbClient, c: Context, ctx: AuditContext): Promise<void> {
  const auth = c.get("auth") as
    | { userId: string; role: string; branchId: string | null; deviceId: string }
    | undefined;
  const actor = ctx.actor ?? auth ?? undefined;
  await db.insert(auditLog).values({
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    actorBranchId: actor?.branchId ?? null,
    action: ctx.action,
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    beforeJson: (ctx.before as Record<string, unknown>) ?? null,
    afterJson: (ctx.after as Record<string, unknown>) ?? null,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    deviceId: actor?.deviceId ?? null,
    idempotencyKey: c.req.header("idempotency-key") ?? null,
  });
}
