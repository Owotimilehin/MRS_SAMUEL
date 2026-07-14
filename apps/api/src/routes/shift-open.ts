import { Hono } from "hono";
import { eq, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { shiftOpen, shiftOpenStockCount, stockLedger, adminUser, product, type DbClient } from "@ms/db";
import {
  expectedStockForDay,
  expectedStockKey,
  expectedStockMap,
  recordVarianceLoss,
} from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { enqueueOutbox } from "../lib/notify.js";

const Submit = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
    .default([]), // empty allowed so an empty catalog cannot deadlock the gate
});

export function shiftOpenRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  r.get("/preview", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const stock = await expectedStockForDay(db, branchId);
    return c.json({ data: { expected_stock: stock } });
  });

  r.post("/", requireCapability("shift_open.submit"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = Submit.parse(await c.req.json());
    const auth = c.get("auth");

    // Server-side guard: a varianced line must carry a reason.
    const expectedLines = await expectedStockForDay(db, branchId);
    const expectedByKey = expectedStockMap(expectedLines);
    const sizeByKey = new Map(
      expectedLines.map((l) => [expectedStockKey(l.product_id, l.variant_id), l.size_ml]),
    );
    for (const sc of body.stock_counts) {
      const exp = expectedByKey.get(expectedStockKey(sc.product_id, sc.variant_id ?? null)) ?? 0;
      if (sc.counted_quantity - exp !== 0 && !sc.variance_reason) {
        throw new BusinessError("validation_failed", "variance_reason required on varianced line", 400);
      }
    }

    let created: typeof shiftOpen.$inferSelect;
    try {
      created = await db.transaction(async (tx) => {
        // Look up existing open shift for this branch.
        const [existing] = await tx
          .select()
          .from(shiftOpen)
          .where(and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.status, "open")));

        let open: typeof shiftOpen.$inferSelect;
        const isNewShift = !existing;

        if (existing) {
          // Re-count the existing open shift — do not create a second one.
          open = existing;
        } else {
          // Compute next shift_number for this branch+date.
          const [numRow] = await tx.execute<{ next_num: number }>(
            sql`SELECT COALESCE(MAX(shift_number), 0) + 1 AS next_num
                FROM shift_open
                WHERE branch_id = ${branchId}
                  AND business_date = ${body.business_date}`,
          );
          const shiftNumber = Number(numRow?.next_num ?? 1);

          const [inserted] = await tx
            .insert(shiftOpen)
            .values({
              branchId,
              businessDate: body.business_date,
              openedByUserId: auth.userId,
              openedAt: new Date(),
              notes: body.notes ?? null,
              status: "open",
              shiftNumber,
            })
            .returning();
          if (!inserted) throw new BusinessError("internal_error", "shift open insert failed", 500);
          open = inserted;
        }

        // Replace count rows atomically (re-count = delete + reinsert), per (product, variant).
        await tx.delete(shiftOpenStockCount).where(eq(shiftOpenStockCount.shiftOpenId, open.id));
        let varianceCount = 0;
        for (const sc of body.stock_counts) {
          const variantId = sc.variant_id ?? null;
          const exp = expectedByKey.get(expectedStockKey(sc.product_id, variantId)) ?? 0;
          const variance = sc.counted_quantity - exp;
          if (variance !== 0) varianceCount += 1;
          await tx.insert(shiftOpenStockCount).values({
            shiftOpenId: open.id,
            productId: sc.product_id,
            variantId,
            systemQuantity: exp,
            countedQuantity: sc.counted_quantity,
            variance,
            varianceReason: sc.variance_reason ?? null,
          });

          // Reconcile branch on-hand to the physical opening count so the till
          // stops selling against a stale expected balance for the rest of the
          // shift. Only on a freshly-opened shift — a re-count of an already-open
          // shift stays display-only to avoid stacking corrections; the close
          // still reconciles any remaining gap. A shortfall is a real loss.
          if (isNewShift && variance !== 0) {
            await tx.insert(stockLedger).values({
              locationType: "branch",
              locationId: branchId,
              productId: sc.product_id,
              variantId,
              delta: variance,
              sourceType: "count_correction",
              sourceId: open.id,
              recordedByUserId: auth.userId,
              note: sc.variance_reason ?? "shift open count",
            });
            if (variance < 0) {
              await recordVarianceLoss(tx, {
                source: "shift_open",
                sourceId: open.id,
                branchId,
                productId: sc.product_id,
                variantId,
                sizeMl: sizeByKey.get(expectedStockKey(sc.product_id, variantId)) ?? null,
                quantity: -variance,
                reason: sc.variance_reason ?? null,
                recordedByUserId: auth.userId,
              });
            }
          }
        }

        const [filer] = await tx
          .select({ email: adminUser.email })
          .from(adminUser)
          .where(eq(adminUser.id, auth.userId));
        const variances = body.stock_counts
          .map((sc) => {
            const variantId = sc.variant_id ?? null;
            const exp = expectedByKey.get(expectedStockKey(sc.product_id, variantId)) ?? 0;
            const size = expectedLines.find(
              (l) => l.product_id === sc.product_id && l.variant_id === variantId,
            )?.size_ml;
            return {
              product_id: sc.product_id,
              variance: sc.counted_quantity - exp,
              variance_reason: sc.variance_reason ?? null,
              size_ml: size ?? null,
            };
          })
          .filter((v) => v.variance !== 0);
        const nameRows = variances.length
          ? await tx
              .select({ id: product.id, name: product.name })
              .from(product)
              .where(inArray(product.id, [...new Set(variances.map((v) => v.product_id))]))
          : [];
        const nameOf = new Map(nameRows.map((n) => [n.id, n.name]));
        await enqueueOutbox(tx, c, "shift_open.submitted", {
          shift_open_id: open.id,
          branch_id: branchId,
          business_date: body.business_date,
          opened_by: filer?.email ?? auth.userId,
          variance_count: varianceCount,
          variances: variances.map((v) => ({
            label: `${nameOf.get(v.product_id) ?? v.product_id.slice(0, 8)}${v.size_ml ? ` ${v.size_ml}ml` : ""}`,
            variance: v.variance,
            reason: v.variance_reason,
          })),
        });
        return open;
      });
    } catch (err: unknown) {
      // Partial-index unique violation (concurrent open from another request).
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("uq_shift_open_one_open_per_branch")) {
        throw new BusinessError("conflict", "shift already open", 409);
      }
      throw err;
    }

    await writeAudit(db, c, {
      action: "shift_open.submit",
      entityType: "shift_open",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  r.get("/", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const date = c.req.query("date");
    const [open] = await db
      .select()
      .from(shiftOpen)
      .where(
        date
          ? and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.businessDate, date))
          : eq(shiftOpen.branchId, branchId),
      );
    if (!open) return c.json({ data: null });
    const counts = await db
      .select()
      .from(shiftOpenStockCount)
      .where(eq(shiftOpenStockCount.shiftOpenId, open.id));
    const openedBy = open.openedByUserId
      ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, open.openedByUserId)))[0]?.email ?? null
      : null;
    return c.json({ data: { ...open, opened_by: openedBy, stock_counts: counts } });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const branchId = c.req.param("branchId");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const [open] = await db.select().from(shiftOpen).where(and(eq(shiftOpen.id, id), eq(shiftOpen.branchId, branchId)));
    if (!open) throw new BusinessError("not_found", "shift open not found", 404);
    const counts = await db
      .select()
      .from(shiftOpenStockCount)
      .where(eq(shiftOpenStockCount.shiftOpenId, open.id));
    const openedBy = open.openedByUserId
      ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, open.openedByUserId)))[0]?.email ?? null
      : null;
    return c.json({ data: { ...open, opened_by: openedBy, stock_counts: counts } });
  });

  return r;
}
