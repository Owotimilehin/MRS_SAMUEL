import { Hono } from "hono";
import { and, eq, isNull, gte, inArray } from "drizzle-orm";
import {
  product,
  productPrice,
  stockTransfer,
  stockTransferItem,
  saleOrder,
  saleOrderItem,
  stockLedger,
  customer,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { BusinessError } from "../lib/errors.js";

/**
 * One-shot pull of everything a branch device needs since a given cursor.
 *
 * Cursor is just an ISO timestamp (kept simple for v1). The device sends
 * "since=2026-05-10T...", we return rows touched after that. Next pull
 * uses the response's next_cursor.
 *
 * Mutations from the device flow in via the regular /v1/branches/:id/sales
 * endpoints with client-generated Idempotency-Keys — no separate "push"
 * endpoint needed.
 */
export function syncRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  r.get("/pull", requireCapability("pos.sell"), async (c) => {
    const auth = c.get("auth");
    const url = new URL(c.req.url);
    const branchIdParam = url.searchParams.get("branch_id");
    if (!branchIdParam) {
      throw new BusinessError("validation_failed", "branch_id required", 400);
    }
    if (auth.role !== "owner" && auth.branchId !== branchIdParam) {
      throw new BusinessError("forbidden", "wrong branch", 403);
    }

    const sinceParam = url.searchParams.get("since");
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 86_400_000);

    // Independent queries — Drizzle's structured operators handle the uuid
    // parameter casting for us. Two-step approach for child tables (get
    // parent ids first, then fetch children with `inArray`) avoids raw SQL.

    const products = await db.select().from(product).where(isNull(product.deletedAt));
    const prices = await db
      .select()
      .from(productPrice)
      .where(gte(productPrice.validFrom, since));

    const transfers = await db
      .select()
      .from(stockTransfer)
      .where(and(eq(stockTransfer.branchId, branchIdParam), gte(stockTransfer.updatedAt, since)));
    const transferParentIds = transfers.map((t) => t.id);
    const transferItems =
      transferParentIds.length > 0
        ? await db
            .select()
            .from(stockTransferItem)
            .where(inArray(stockTransferItem.stockTransferId, transferParentIds))
        : [];

    const ledger = await db
      .select()
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.locationType, "branch"),
          eq(stockLedger.locationId, branchIdParam),
          gte(stockLedger.recordedAt, since),
        ),
      );

    const sales = await db
      .select()
      .from(saleOrder)
      .where(and(eq(saleOrder.branchId, branchIdParam), gte(saleOrder.updatedAt, since)));
    const saleParentIds = sales.map((s) => s.id);
    const saleItems =
      saleParentIds.length > 0
        ? await db
            .select()
            .from(saleOrderItem)
            .where(inArray(saleOrderItem.saleOrderId, saleParentIds))
        : [];

    const customers = await db.select().from(customer).where(gte(customer.updatedAt, since));

    return c.json({
      data: {
        products,
        prices,
        transfers,
        transfer_items: transferItems,
        ledger,
        sales,
        sale_items: saleItems,
        customers,
      },
      next_cursor: new Date().toISOString(),
    });
  });

  return r;
}
