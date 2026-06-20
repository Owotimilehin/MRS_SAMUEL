import { Hono } from "hono";
import { and, eq, isNull, gte, inArray, sql } from "drizzle-orm";
import {
  product,
  productVariant,
  productPrice,
  stockTransfer,
  stockTransferItem,
  saleOrder,
  saleOrderItem,
  stockLedger,
  customer,
  shiftOpen,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireAnyCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { BusinessError } from "../lib/errors.js";

// Cross-branch roles act on any branch's till (matches requireBranchScope and
// transfers' actsOnAnyBranch). Only branch_staff are pinned to their own branch.
function actsOnAnyBranch(role: string): boolean {
  return role === "owner" || role === "admin" || role === "manager";
}

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

  r.get("/pull", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
    const auth = c.get("auth");
    const url = new URL(c.req.url);
    const branchIdParam = url.searchParams.get("branch_id");
    if (!branchIdParam) {
      throw new BusinessError("validation_failed", "branch_id required", 400);
    }
    if (!actsOnAnyBranch(auth.role) && auth.branchId !== branchIdParam) {
      throw new BusinessError("forbidden", "wrong branch", 403);
    }

    const sinceParam = url.searchParams.get("since");
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 86_400_000);

    // Independent queries — Drizzle's structured operators handle the uuid
    // parameter casting for us. Two-step approach for child tables (get
    // parent ids first, then fetch children with `inArray`) avoids raw SQL.

    const products = await db.select().from(product).where(isNull(product.deletedAt));
    // Active can-sizes per product. The till needs these to let staff pick a
    // size and book the right variant price (the offline price table keys on
    // variant_id). Not date-filtered — variants change rarely and the device
    // needs the full set, not just recently-touched rows.
    const variants = await db
      .select()
      .from(productVariant)
      .where(isNull(productVariant.deletedAt));
    // All currently-active prices (validTo IS NULL), NOT date-filtered. The
    // till needs every product's current price to ring up; a delta window
    // (gte validFrom, since) silently drops prices set before a fresh device's
    // first sync, leaving those products at ₦0 on the till. Active prices are a
    // small bounded set (~one per variant), so sending them all every pull is
    // cheap and keeps the offline price table correct after any cache clear.
    const prices = await db
      .select()
      .from(productPrice)
      .where(isNull(productPrice.validTo));

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

    // Authoritative current on-hand for the branch: net SUM(delta) per
    // flavour+size, NOT date-filtered. This is the small, bounded snapshot the
    // till overwrites its local stock with on every successful pull — making the
    // server the single source of truth for availability. Because it's a full
    // re-derivation (not a delta), any server-side correction or wipe propagates
    // to the till on the next pull, so phantom stock can never accumulate.
    const stockRows = await db
      .select({
        productId: stockLedger.productId,
        variantId: stockLedger.variantId,
        qty: sql<string>`coalesce(sum(${stockLedger.delta}), 0)`,
      })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.locationType, "branch"),
          eq(stockLedger.locationId, branchIdParam),
        ),
      )
      .groupBy(stockLedger.productId, stockLedger.variantId);
    const stock = stockRows.map((s) => ({
      productId: s.productId,
      variantId: s.variantId,
      qty: Number(s.qty),
    }));

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

    // Has this branch filed an opening count for today (Lagos)? The till uses
    // this to satisfy the open-gate without a local marker (e.g. a 2nd device).
    const todayLagos = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
    const openRows = await db
      .select({ id: shiftOpen.id })
      .from(shiftOpen)
      .where(and(eq(shiftOpen.branchId, branchIdParam), eq(shiftOpen.businessDate, todayLagos)))
      .limit(1);
    const openedToday = openRows.length > 0;

    // Current open shift for the branch (status='open', any date — covers
    // multi-shift and overnight scenarios). The POS uses this to heal local
    // shift state on a fresh install or second device without re-opening.
    const openShiftRows = await db
      .select({ id: shiftOpen.id, openedAt: shiftOpen.openedAt })
      .from(shiftOpen)
      .where(and(eq(shiftOpen.branchId, branchIdParam), eq(shiftOpen.status, "open")))
      .limit(1);
    const openShiftRow = openShiftRows[0] ?? null;
    const openShift = openShiftRow
      ? { id: openShiftRow.id, opened_at: openShiftRow.openedAt?.toISOString() ?? null }
      : null;

    return c.json({
      data: {
        products,
        variants,
        prices,
        transfers,
        transfer_items: transferItems,
        ledger,
        stock,
        sales,
        sale_items: saleItems,
        customers,
        opened_today: openedToday,
        open_shift: openShift,
      },
      next_cursor: new Date().toISOString(),
    });
  });

  return r;
}
