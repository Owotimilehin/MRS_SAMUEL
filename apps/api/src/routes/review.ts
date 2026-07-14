import { Hono } from "hono";
import { eq, or, isNotNull, desc, and, inArray } from "drizzle-orm";
import {
  stockTransfer,
  saleReturn,
  saleOrder,
  payment,
  dailyClose,
  shiftOpen,
  branch,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";

/**
 * Owner-only "Needs review" inbox. Aggregates everything that needs the
 * owner's eye:
 *   - stock transfers in received_with_variance
 *   - sale returns pending_approval
 *   - online sale orders needing payment attention (reconcile_needed OR refund_owed)
 *   - submitted (unapproved) shift closes — the cash/transfer reconciliation the
 *     owner must approve or dispute; previously invisible here, so backlogs piled up
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
      .select({ ret: saleReturn, originalSaleOrderNumber: saleOrder.orderNumber })
      .from(saleReturn)
      .leftJoin(saleOrder, eq(saleOrder.id, saleReturn.originalSaleOrderId))
      .where(eq(saleReturn.status, "pending_approval"));

    // Online orders that need the owner's payment attention:
    //   - status = 'reconcile_needed'  (Payaza amount mismatch detected)
    //   - refund_owed_ngn IS NOT NULL  (business owes customer money back)
    const paymentAttentionOrders = await db
      .select()
      .from(saleOrder)
      .where(
        and(
          eq(saleOrder.channel, "online"),
          or(
            eq(saleOrder.status, "reconcile_needed"),
            isNotNull(saleOrder.refundOwedNgn),
          ),
        ),
      );

    // For each flagged order, pull the latest payment row's amount as `reported_ngn`
    // (the amount Payaza actually reported, which may differ from totalNgn).
    const latestPayments =
      paymentAttentionOrders.length > 0
        ? await db
            .select({
              saleOrderId: payment.saleOrderId,
              amountNgn: payment.amountNgn,
              netNgn: payment.netNgn,
              createdAt: payment.createdAt,
            })
            .from(payment)
            .where(
              inArray(
                payment.saleOrderId,
                paymentAttentionOrders.map((o) => o.id),
              ),
            )
            .orderBy(desc(payment.createdAt))
        : [];

    // Build a lookup: saleOrderId → latest amountNgn (first row per order after DESC sort)
    const reportedByOrderId = new Map<string, number>();
    for (const p of latestPayments) {
      if (!reportedByOrderId.has(p.saleOrderId)) {
        reportedByOrderId.set(p.saleOrderId, p.amountNgn);
      }
    }

    const netByOrderId = new Map<string, number | null>();
    for (const p of latestPayments) {
      if (!netByOrderId.has(p.saleOrderId)) {
        netByOrderId.set(p.saleOrderId, p.netNgn ?? null);
      }
    }

    const paymentAttention = paymentAttentionOrders.map((o) => ({
      id: o.id,
      order_number: o.orderNumber,
      status: o.status,
      total_ngn: o.totalNgn,
      refund_owed_ngn: o.refundOwedNgn ?? null,
      reported_ngn: reportedByOrderId.get(o.id) ?? null,
      net_ngn: netByOrderId.get(o.id) ?? null,
      shortfall_ngn: o.feeShortfallNgn ?? null,
    }));

    // Submitted (unapproved) shift closes — surfaced so the owner can approve or
    // dispute them instead of the backlog silently growing on /owner/closes.
    const pendingCloses = await db
      .select({
        id: dailyClose.id,
        branch_id: dailyClose.branchId,
        branch_name: branch.name,
        business_date: dailyClose.businessDate,
        variance_ngn: dailyClose.varianceNgn,
        cash_counted_ngn: dailyClose.cashCountedNgn,
        transfers_counted_ngn: dailyClose.transfersCountedNgn,
        system_cash_total_ngn: dailyClose.systemCashTotalNgn,
        submitted_at: dailyClose.submittedAt,
        shift_number: shiftOpen.shiftNumber,
      })
      .from(dailyClose)
      .leftJoin(branch, eq(branch.id, dailyClose.branchId))
      .leftJoin(shiftOpen, eq(shiftOpen.id, dailyClose.shiftId))
      .where(eq(dailyClose.status, "submitted"))
      .orderBy(desc(dailyClose.submittedAt));

    return c.json({
      data: {
        pending_closes: pendingCloses,
        transfer_variances: transferVariances,
        return_approvals: returnApprovals.map((r) => ({
          ...r.ret,
          originalSaleOrderNumber: r.originalSaleOrderNumber,
        })),
        payment_attention: paymentAttention,
      },
    });
  });

  return r;
}
