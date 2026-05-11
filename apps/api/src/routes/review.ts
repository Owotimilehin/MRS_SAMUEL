import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { stockTransfer, type DbClient } from "@ms/db";
import { requireAuth, requireRole } from "../middleware/auth.js";

/**
 * Owner-only "Needs review" inbox. Right now it only lists transfers in the
 * received_with_variance state — Phase 4+ will add SaleReturn pending_approval
 * rows and RECONCILE_NEEDED sale flags to the same payload.
 */
export function reviewRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireRole("owner"));

  r.get("/", async (c) => {
    const transferVariances = await db
      .select()
      .from(stockTransfer)
      .where(eq(stockTransfer.status, "received_with_variance"));
    return c.json({
      data: {
        transfer_variances: transferVariances,
      },
    });
  });

  return r;
}
