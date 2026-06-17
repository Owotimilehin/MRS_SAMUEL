import type { Context } from "hono";
import { auditLog, outboxEvent } from "@ms/db";
import type { DbClient } from "@ms/db";
import { resolveActor, diffChanges } from "../lib/notify.js";

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
  /**
   * Suppress the auto-generated Telegram notification for this action. Set on
   * the rare call site that wants the audit row without an owner ping.
   */
  notify?: boolean;
}

/**
 * Actions that already enqueue a richer, purpose-built outbox event elsewhere
 * (and would otherwise produce a duplicate owner ping). Login is excluded
 * because it fires on every page-load refresh and would be pure noise.
 */
const SKIP_NOTIFY = new Set<string>([
  "auth.login_success",
  "stock_transfer.dispatch", // → stock_transfer.dispatched
  "stock_transfer.arrive", // → stock_transfer.arrived
  "stock_transfer.receive", // → stock_transfer.variance_review (arrival already pinged)
  "stock_transfer.reject", // → stock_transfer.rejected
  "stock_transfer.adjust_count", // → stock_transfer.count_corrected
  "stock_adjustment.create", // → stock_adjustment.recorded
  "packaging_purchase.create", // → packaging.purchase_recorded
  "sale_return.create", // → sale_return.pending_approval
  "daily_close.submit", // → daily_close.submitted
  "production_run.complete", // → production_run.completed
  "sale.pay", // → sale.branch_sold
]);

/** A friendly noun for each audited entity, used in the owner notification. */
const ENTITY_NOUN: Record<string, string> = {
  admin_user: "User",
  branch: "Branch",
  product: "Product",
  blog_post: "Blog post",
  vendor: "Vendor",
  recurring_expense: "Recurring expense",
  business_expense: "Expense",
  packaging_material: "Packaging material",
  subscription_plan: "Subscription plan",
  bundle: "Bundle",
  media_asset: "Image",
  production_run: "Production run",
  sale_order: "Sale",
  daily_close: "Shift-end report",
};

/** Pull a human identifier (name/number/title) out of the audit payload. */
function identifierOf(after: unknown, before: unknown): string | null {
  const keys = [
    "name", "email", "title",
    "transferNumber", "transfer_number",
    "orderNumber", "order_number", "saleNumber",
    "returnNumber", "return_number",
    "runDate", "run_date", "businessDate", "business_date",
    "category_code",
  ];
  for (const src of [after, before]) {
    if (!src || typeof src !== "object") continue;
    const obj = src as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return null;
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

  // Mirror every meaningful action to the owner's Telegram channel so nothing
  // that happens in the app goes unseen. Actions that already fire a richer,
  // dedicated event are skipped to avoid double-pinging.
  const shouldNotify = ctx.notify ?? !SKIP_NOTIFY.has(ctx.action);
  if (shouldNotify) {
    const actorBlock = await resolveActor(db, c);
    await db.insert(outboxEvent).values({
      eventType: "audit.logged",
      payload: {
        action: ctx.action,
        entity_type: ctx.entityType,
        entity_id: ctx.entityId,
        entity_noun: ENTITY_NOUN[ctx.entityType] ?? ctx.entityType.replace(/_/g, " "),
        identifier: identifierOf(ctx.after, ctx.before),
        changes: diffChanges(ctx.before, ctx.after),
        ...actorBlock,
      },
    });
  }
}
