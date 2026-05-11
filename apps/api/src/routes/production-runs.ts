import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { productionRun, productionRunItem, stockLedger, type DbClient } from "@ms/db";
import { requireAuth } from "../middleware/auth.js";
import { requireFactoryRole } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const CreateRun = z.object({
  factory_id: z.string().uuid(),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity_produced: z.number().int().positive(),
        batch_code: z.string().optional(),
      }),
    )
    .min(1),
  notes: z.string().optional(),
});

export function productionRunRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireFactoryRole());

  r.post("/", async (c) => {
    const body = CreateRun.parse(await c.req.json());
    const auth = c.get("auth");

    const created = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(productionRun)
        .values({
          factoryId: body.factory_id,
          runDate: body.run_date,
          status: "draft",
          createdByUserId: auth.userId,
          notes: body.notes ?? null,
        })
        .returning();
      if (!run) throw new BusinessError("internal_error", "insert returned no rows", 500);
      for (const it of body.items) {
        await tx.insert(productionRunItem).values({
          productionRunId: run.id,
          productId: it.product_id,
          quantityProduced: it.quantity_produced,
          batchCode: it.batch_code ?? null,
        });
      }
      return run;
    });

    await writeAudit(db, c, {
      action: "production_run.create_draft",
      entityType: "production_run",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  r.patch("/:id/complete", async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");

    const completed = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(productionRun).where(eq(productionRun.id, id));
      if (!run) throw new BusinessError("not_found", "production_run not found", 404);
      if (run.status !== "draft") {
        throw new BusinessError("conflict", `cannot complete from status ${run.status}`, 409);
      }
      const items = await tx
        .select()
        .from(productionRunItem)
        .where(eq(productionRunItem.productionRunId, id));

      for (const it of items) {
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: run.factoryId,
          productId: it.productId,
          delta: it.quantityProduced,
          sourceType: "production_run",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Production run ${id}`,
        });
      }

      const [updated] = await tx
        .update(productionRun)
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(productionRun.id, id))
        .returning();
      if (!updated) throw new BusinessError("internal_error", "update returned no rows", 500);
      return updated;
    });

    await writeAudit(db, c, {
      action: "production_run.complete",
      entityType: "production_run",
      entityId: id,
      after: completed,
    });
    return c.json({ data: completed });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [run] = await db.select().from(productionRun).where(eq(productionRun.id, id));
    if (!run) throw new BusinessError("not_found", "production_run not found", 404);
    const items = await db
      .select()
      .from(productionRunItem)
      .where(eq(productionRunItem.productionRunId, id));
    return c.json({ data: { ...run, items } });
  });

  return r;
}
