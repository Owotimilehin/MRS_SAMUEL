import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dailyClose,
  dailyCloseStockCount,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { expectedCashForDay, expectedStockForDay } from "@ms/domain";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const Submit = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cash_counted_ngn: z.number().int().nonnegative(),
  transfers_counted_ngn: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
  stock_counts: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        counted_quantity: z.number().int().nonnegative(),
        variance_reason: z.string().optional(),
      }),
    )
    .min(1),
});

export function dailyCloseRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  r.post("/", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = Submit.parse(await c.req.json());
    const auth = c.get("auth");
    const businessDate = new Date(body.business_date);

    const created = await db.transaction(async (tx) => {
      const expectedCash = await expectedCashForDay(tx, branchId, businessDate);
      const expectedStock = await expectedStockForDay(tx, branchId);
      const variance = body.cash_counted_ngn + body.transfers_counted_ngn - expectedCash;
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
          submittedAt: new Date(),
          notes: body.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [dailyClose.branchId, dailyClose.businessDate],
          set: {
            cashCountedNgn: body.cash_counted_ngn,
            transfersCountedNgn: body.transfers_counted_ngn,
            systemCashTotalNgn: expectedCash,
            varianceNgn: variance,
            submittedByUserId: auth.userId,
            submittedAt: new Date(),
            notes: body.notes ?? null,
            status: "submitted",
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!close) throw new BusinessError("internal_error", "daily close upsert failed", 500);

      // Replace stock counts atomically
      await tx
        .delete(dailyCloseStockCount)
        .where(eq(dailyCloseStockCount.dailyCloseId, close.id));
      for (const sc of body.stock_counts) {
        const expected = expectedStock[sc.product_id] ?? 0;
        await tx.insert(dailyCloseStockCount).values({
          dailyCloseId: close.id,
          productId: sc.product_id,
          systemQuantity: expected,
          countedQuantity: sc.counted_quantity,
          variance: sc.counted_quantity - expected,
          varianceReason: sc.variance_reason ?? null,
        });
      }

      await tx.insert(outboxEvent).values({
        eventType: "daily_close.submitted",
        payload: {
          daily_close_id: close.id,
          branch_id: branchId,
          variance_ngn: variance,
        },
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

  r.patch("/:id/approve", requireRole("owner"), async (c) => {
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

  r.patch("/:id/dispute", requireRole("owner"), async (c) => {
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
    const stock = await expectedStockForDay(db, branchId);
    return c.json({ data: { expected_cash_ngn: cash, expected_stock: stock } });
  });

  r.get("/", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const rows = await db
      .select()
      .from(dailyClose)
      .where(eq(dailyClose.branchId, branchId));
    return c.json({ data: rows });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [close] = await db.select().from(dailyClose).where(eq(dailyClose.id, id));
    if (!close) throw new BusinessError("not_found", "daily close not found", 404);
    const counts = await db
      .select()
      .from(dailyCloseStockCount)
      .where(eq(dailyCloseStockCount.dailyCloseId, id));
    return c.json({ data: { ...close, stock_counts: counts } });
  });

  return r;
}
