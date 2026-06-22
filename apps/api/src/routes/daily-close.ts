import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dailyClose,
  dailyCloseStockCount,
  shiftOpen,
  shiftOpenStockCount,
  adminUser,
  product,
  productVariant,
  type DbClient,
} from "@ms/db";
import {
  cashSalesForDay,
  cashSalesForShift,
  expectedCashForDay,
  expectedCashForShift,
  expectedStockForDay,
  expectedStockKey,
  expectedStockMap,
} from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { enqueueOutbox } from "../lib/notify.js";

const Submit = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cash_counted_ngn: z.number().int().nonnegative(),
  transfers_counted_ngn: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
  stock_counts: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        variant_id: z.string().uuid().nullable().optional(),
        counted_quantity: z.number().int().nonnegative(),
        variance_reason: z.string().optional(),
      }),
    )
    .min(1),
});

export function dailyCloseRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  r.post("/", requireCapability("daily_close.submit"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = Submit.parse(await c.req.json());
    const auth = c.get("auth");

    const created = await db.transaction(async (tx) => {
      // Require an open shift — conclusive close guard.
      const [openShift] = await tx
        .select()
        .from(shiftOpen)
        .where(and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.status, "open")));
      if (!openShift) {
        throw new BusinessError("conflict", "no open shift to close", 409);
      }

      const now = new Date();
      const openedAt = openShift.openedAt ?? new Date(0);
      // Expected money is scoped to the shift window; expected stock is per (product, variant).
      const expectedCash = await expectedCashForShift(tx, branchId, openedAt, now);
      const expectedLines = await expectedStockForDay(tx, branchId);
      const expectedByKey = expectedStockMap(expectedLines);
      const sizeByKey = new Map(
        expectedLines.map((l) => [expectedStockKey(l.product_id, l.variant_id), l.size_ml]),
      );
      const variance = body.cash_counted_ngn + body.transfers_counted_ngn - expectedCash;

      // Plain INSERT (no upsert) — shift uniqueness is the conclusive guard.
      const [close] = await tx
        .insert(dailyClose)
        .values({
          branchId,
          businessDate: body.business_date,
          status: "submitted",
          cashCountedNgn: body.cash_counted_ngn,
          transfersCountedNgn: body.transfers_counted_ngn,
          systemCashTotalNgn: expectedCash,
          varianceNgn: variance,
          submittedByUserId: auth.userId,
          submittedAt: now,
          notes: body.notes ?? null,
          shiftId: openShift.id,
        })
        .returning();
      if (!close) throw new BusinessError("internal_error", "daily close insert failed", 500);

      // Insert stock counts, per (product, variant). The close row is freshly
      // inserted above (shift uniqueness is the conclusive guard), so there are
      // no prior counts to replace.
      for (const sc of body.stock_counts) {
        const variantId = sc.variant_id ?? null;
        const expected = expectedByKey.get(expectedStockKey(sc.product_id, variantId)) ?? 0;
        const lineVariance = sc.counted_quantity - expected;
        // Per-size reason is required when that size moved.
        if (lineVariance !== 0 && !sc.variance_reason) {
          throw new BusinessError(
            "validation_failed",
            "variance_reason required on varianced line",
            400,
          );
        }
        await tx.insert(dailyCloseStockCount).values({
          dailyCloseId: close.id,
          productId: sc.product_id,
          variantId,
          systemQuantity: expected,
          countedQuantity: sc.counted_quantity,
          variance: lineVariance,
          varianceReason: sc.variance_reason ?? null,
        });
      }

      // Close the shift in the same transaction.
      await tx
        .update(shiftOpen)
        .set({
          status: "closed",
          closedAt: now,
          closedByUserId: auth.userId,
          updatedAt: now,
        })
        .where(eq(shiftOpen.id, openShift.id));

      // Build a per-size variance list for the owner notification.
      const variancedInputs = body.stock_counts
        .map((sc) => {
          const variantId = sc.variant_id ?? null;
          const expected = expectedByKey.get(expectedStockKey(sc.product_id, variantId)) ?? 0;
          return { ...sc, variantId, variance: sc.counted_quantity - expected };
        })
        .filter((x) => x.variance !== 0);
      const nameRows = variancedInputs.length
        ? await tx
            .select({ id: product.id, name: product.name })
            .from(product)
            .where(inArray(product.id, [...new Set(variancedInputs.map((v) => v.product_id))]))
        : [];
      const nameOf = new Map(nameRows.map((n) => [n.id, n.name]));
      const variances = variancedInputs.map((v) => {
        const size = sizeByKey.get(expectedStockKey(v.product_id, v.variantId));
        const label = `${nameOf.get(v.product_id) ?? v.product_id.slice(0, 8)}${size ? ` ${size}ml` : ""}`;
        return { label, variance: v.variance, reason: v.variance_reason ?? null };
      });

      const [filer] = await tx
        .select({ email: adminUser.email })
        .from(adminUser)
        .where(eq(adminUser.id, auth.userId));
      await enqueueOutbox(tx, c, "daily_close.submitted", {
        daily_close_id: close.id,
        branch_id: branchId,
        business_date: body.business_date,
        shift_id: openShift.id,
        cash_ngn: body.cash_counted_ngn,
        transfer_ngn: body.transfers_counted_ngn,
        variance_ngn: variance,
        filed_by: filer?.email ?? auth.userId,
        variances,
      });
      return close;
    });

    await writeAudit(db, c, {
      action: "daily_close.submit",
      entityType: "daily_close",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  r.patch("/:id/approve", requireCapability("close.approve"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");
    const updated = await db.transaction(async (tx) => {
      const [close] = await tx.select().from(dailyClose).where(eq(dailyClose.id, id));
      if (!close) throw new BusinessError("not_found", "daily close not found", 404);
      if (close.status !== "submitted") {
        throw new BusinessError("conflict", `cannot approve from ${close.status}`, 409);
      }
      const [u] = await tx
        .update(dailyClose)
        .set({
          status: "approved",
          approvedByUserId: auth.userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dailyClose.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "approve update failed", 500);
      return u;
    });
    await writeAudit(db, c, {
      action: "daily_close.approve",
      entityType: "daily_close",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  r.patch("/:id/dispute", requireCapability("close.approve"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const { reason } = z
      .object({ reason: z.string().min(1) })
      .parse(await c.req.json());
    const [u] = await db
      .update(dailyClose)
      .set({
        status: "disputed",
        notes: sql`COALESCE(notes, '') || E'\n[DISPUTE] ' || ${reason}`,
        updatedAt: new Date(),
      })
      .where(eq(dailyClose.id, id))
      .returning();
    if (!u) throw new BusinessError("not_found", "daily close not found", 404);
    return c.json({ data: u });
  });

  r.get("/preview", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const cash = await expectedCashForDay(db, branchId, new Date(date));
    const cashSales = await cashSalesForDay(db, branchId, new Date(date));
    const stock = await expectedStockForDay(db, branchId);
    return c.json({
      data: { expected_cash_ngn: cash, expected_stock: stock, cash_sales: cashSales },
    });
  });

  r.get("/", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const rows = await db
      .select({
        id: dailyClose.id,
        branchId: dailyClose.branchId,
        businessDate: dailyClose.businessDate,
        status: dailyClose.status,
        cashCountedNgn: dailyClose.cashCountedNgn,
        transfersCountedNgn: dailyClose.transfersCountedNgn,
        systemCashTotalNgn: dailyClose.systemCashTotalNgn,
        varianceNgn: dailyClose.varianceNgn,
        submittedByUserId: dailyClose.submittedByUserId,
        submittedAt: dailyClose.submittedAt,
        approvedByUserId: dailyClose.approvedByUserId,
        approvedAt: dailyClose.approvedAt,
        notes: dailyClose.notes,
        shiftId: dailyClose.shiftId,
        createdAt: dailyClose.createdAt,
        updatedAt: dailyClose.updatedAt,
        shiftNumber: shiftOpen.shiftNumber,
        openedAt: shiftOpen.openedAt,
        closedAt: shiftOpen.closedAt,
      })
      .from(dailyClose)
      .leftJoin(shiftOpen, eq(dailyClose.shiftId, shiftOpen.id))
      .where(eq(dailyClose.branchId, branchId));
    return c.json({ data: rows });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [close] = await db.select().from(dailyClose).where(eq(dailyClose.id, id));
    if (!close) throw new BusinessError("not_found", "daily close not found", 404);
    const counts = await db
      .select({
        id: dailyCloseStockCount.id,
        dailyCloseId: dailyCloseStockCount.dailyCloseId,
        productId: dailyCloseStockCount.productId,
        variantId: dailyCloseStockCount.variantId,
        systemQuantity: dailyCloseStockCount.systemQuantity,
        countedQuantity: dailyCloseStockCount.countedQuantity,
        variance: dailyCloseStockCount.variance,
        varianceReason: dailyCloseStockCount.varianceReason,
        sizeMl: productVariant.sizeMl,
      })
      .from(dailyCloseStockCount)
      .leftJoin(productVariant, eq(productVariant.id, dailyCloseStockCount.variantId))
      .where(eq(dailyCloseStockCount.dailyCloseId, id));
    // Show itemised cash sales for this shift window (or fall back to day-window if no shift).
    let cashSales;
    if (close.shiftId) {
      // Fetch the linked shift to get its window.
      const [linkedShift] = await db.select().from(shiftOpen).where(eq(shiftOpen.id, close.shiftId));
      if (linkedShift?.openedAt && linkedShift.closedAt) {
        cashSales = await cashSalesForShift(db, close.branchId, linkedShift.openedAt, linkedShift.closedAt);
      } else {
        cashSales = await cashSalesForDay(db, close.branchId, new Date(close.businessDate));
      }
    } else {
      cashSales = await cashSalesForDay(db, close.branchId, new Date(close.businessDate));
    }
    // Resolve staff identities.
    const submittedBy = close.submittedByUserId
      ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, close.submittedByUserId)))[0]?.email ?? null
      : null;
    const approvedBy = close.approvedByUserId
      ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, close.approvedByUserId)))[0]?.email ?? null
      : null;
    // Fetch the linked shift-open via daily_close.shift_id (not by branch+date).
    let shiftOpenOut = null;
    if (close.shiftId) {
      const [open] = await db.select().from(shiftOpen).where(eq(shiftOpen.id, close.shiftId));
      if (open) {
        const openCounts = await db
          .select({
            id: shiftOpenStockCount.id,
            shiftOpenId: shiftOpenStockCount.shiftOpenId,
            productId: shiftOpenStockCount.productId,
            variantId: shiftOpenStockCount.variantId,
            systemQuantity: shiftOpenStockCount.systemQuantity,
            countedQuantity: shiftOpenStockCount.countedQuantity,
            variance: shiftOpenStockCount.variance,
            varianceReason: shiftOpenStockCount.varianceReason,
            sizeMl: productVariant.sizeMl,
          })
          .from(shiftOpenStockCount)
          .leftJoin(productVariant, eq(productVariant.id, shiftOpenStockCount.variantId))
          .where(eq(shiftOpenStockCount.shiftOpenId, open.id));
        const openedBy = open.openedByUserId
          ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, open.openedByUserId)))[0]?.email ?? null
          : null;
        shiftOpenOut = { ...open, opened_by: openedBy, stock_counts: openCounts };
      }
    }
    return c.json({
      data: { ...close, submitted_by: submittedBy, approved_by: approvedBy, stock_counts: counts, cash_sales: cashSales, shift_open: shiftOpenOut },
    });
  });

  return r;
}
