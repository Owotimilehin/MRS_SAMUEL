import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { stockTransfer, saleReturn, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";

/**
 * Owner-only "Needs review" inbox. Aggregates everything that needs the
 * owner's eye:
 *   - stock transfers in received_with_variance
 *   - sale returns pending_approval
 *   - (future) sale orders in reconcile_needed
 */
export function reviewRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("orders.manage"));

  r.get("/", async (c) => {
    const transferVariances = await db
      .select()
      .from(stockTransfer)
      .where(eq(stockTransfer.status, "received_with_variance"));

    const returnApprovals = await db
      .select()
      .from(saleReturn)
      .where(eq(saleReturn.status, "pending_approval"));

    return c.json({
      data: {
        transfer_variances: transferVariances,
        return_approvals: returnApprovals,
      },
    });
  });

  return r;
}
