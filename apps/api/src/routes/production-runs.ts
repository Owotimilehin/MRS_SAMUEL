import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import {
  productionRun,
  productionRunItem,
  stockLedger,
  outboxEvent,
  productVariant,
  packagingStockLedger,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const ItemInput = z.object({
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  quantity_produced: z.number().int().positive(),
  batch_code: z.string().optional(),
});

const CreateRun = z.object({
  factory_id: z.string().uuid(),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Items optional at create — the factory often wants to open an empty draft
  // and append flavours through the day, one at a time.
  items: z.array(ItemInput).optional(),
  notes: z.string().optional(),
});

const AppendItems = z.object({
  items: z.array(ItemInput).min(1),
});

const UpdateItem = z.object({
  quantity_produced: z.number().int().positive().optional(),
  batch_code: z.string().nullable().optional(),
});

export function productionRunRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("production.manage"));

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
      for (const it of body.items ?? []) {
        await tx.insert(productionRunItem).values({
          productionRunId: run.id,
          productId: it.product_id,
          variantId: it.variant_id ?? null,
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
    // Always include the items array (possibly empty) so the UI can treat
    // create and /open responses the same way.
    const items = await db
      .select()
      .from(productionRunItem)
      .where(eq(productionRunItem.productionRunId, created.id));
    return c.json({ data: { ...created, items } }, 201);
  });

  r.patch("/:id/complete", async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");

    let completed;
    try {
      completed = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(productionRun).where(eq(productionRun.id, id));
      if (!run) throw new BusinessError("not_found", "production_run not found", 404);
      if (run.status !== "draft") {
        throw new BusinessError("conflict", `cannot complete from status ${run.status}`, 409);
      }
      const items = await tx
        .select()
        .from(productionRunItem)
        .where(eq(productionRunItem.productionRunId, id));
      if (items.length === 0) {
        throw new BusinessError("validation_failed", "production run has no items — add at least one flavour first", 422);
      }

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

      // Packaging consumption — only fires when the item has a variant_id
      // AND that variant has a bottle_material_id linkage. Legacy items
      // (variant_id IS NULL) silently skip. The packaging_stock_ledger
      // trigger fires at commit time, so the negative-balance rejection is
      // re-shaped to a 422 in the OUTER try/catch around db.transaction
      // below — not here.
      for (const it of items) {
        if (!it.variantId) continue;
        const [variant] = await tx
          .select()
          .from(productVariant)
          .where(eq(productVariant.id, it.variantId));
        if (!variant?.bottleMaterialId) continue;

        await tx.insert(packagingStockLedger).values({
          factoryId: run.factoryId,
          packagingMaterialId: variant.bottleMaterialId,
          delta: -it.quantityProduced,
          sourceType: "consumption",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Run ${id} consumed ${it.quantityProduced} bottles`,
        });
      }

      const [updated] = await tx
        .update(productionRun)
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(productionRun.id, id))
        .returning();
      if (!updated) throw new BusinessError("internal_error", "update returned no rows", 500);
      const bottleCount = items.reduce((sum, it) => sum + it.quantityProduced, 0);
      await tx.insert(outboxEvent).values({
        eventType: "production_run.completed",
        payload: {
          production_run_id: updated.id,
          run_date: updated.runDate,
          bottle_count: bottleCount,
        },
      });
      return updated;
      });
    } catch (err) {
      // The trigger error fires at commit time, escaping the inner try/catch
      // as a DrizzleQueryError. Walk the error chain (err, err.cause, etc)
      // looking for the Postgres trigger text.
      if (err instanceof BusinessError) throw err;
      let walker: unknown = err;
      let messages = "";
      let depth = 0;
      while (walker && depth < 5) {
        if (walker instanceof Error) {
          messages += walker.message + " | ";
          walker = (walker as { cause?: unknown }).cause;
        } else {
          break;
        }
        depth++;
      }
      if (messages.includes("negative balance") || messages.includes("packaging_stock_ledger")) {
        throw new BusinessError("conflict", "packaging stock would go negative", 422, {
          reason: "packaging_insufficient",
        });
      }
      throw err;
    }

    await writeAudit(db, c, {
      action: "production_run.complete",
      entityType: "production_run",
      entityId: id,
      after: completed,
    });
    // Return items alongside the run so the response matches the shape of
    // /open and create — the UI relies on `data.items` always being present.
    const items = await db
      .select()
      .from(productionRunItem)
      .where(eq(productionRunItem.productionRunId, id));
    return c.json({ data: { ...completed, items } });
  });

  /** Find today's open draft for a factory so the UI can resume it instead
   *  of creating a new run per flavour. Returns null if none exists.
   *  Registered BEFORE `/:id` so the literal path wins over the param. */
  r.get("/open", async (c) => {
    const url = new URL(c.req.url);
    const factoryId = url.searchParams.get("factory_id");
    const runDate = url.searchParams.get("run_date");
    if (!factoryId || !runDate) {
      throw new BusinessError("validation_failed", "factory_id and run_date required", 400);
    }
    const [run] = await db
      .select()
      .from(productionRun)
      .where(
        and(
          eq(productionRun.factoryId, factoryId),
          eq(productionRun.runDate, runDate),
          eq(productionRun.status, "draft"),
        ),
      )
      .orderBy(desc(productionRun.createdAt))
      .limit(1);
    if (!run) return c.json({ data: null });
    const items = await db
      .select()
      .from(productionRunItem)
      .where(eq(productionRunItem.productionRunId, run.id));
    return c.json({ data: { ...run, items } });
  });

  /** Recent runs for the history list, newest first. Optionally scoped to a
   *  factory. Each run carries its items so the UI can show flavour/bottle
   *  totals and link into the detail page. Registered before `/:id`. */
  r.get("/", async (c) => {
    const url = new URL(c.req.url);
    const factoryId = url.searchParams.get("factory_id");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const runs = await db
      .select()
      .from(productionRun)
      .where(factoryId ? eq(productionRun.factoryId, factoryId) : undefined)
      .orderBy(desc(productionRun.runDate), desc(productionRun.createdAt))
      .limit(limit);
    const withItems = await Promise.all(
      runs.map(async (run) => {
        const items = await db
          .select()
          .from(productionRunItem)
          .where(eq(productionRunItem.productionRunId, run.id));
        return { ...run, items };
      }),
    );
    return c.json({ data: withItems });
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

  /** Append flavours to an existing draft run. The factory does a flavour
   *  at a time and calls this each time the next batch is done. */
  r.post("/:id/items", async (c) => {
    const id = c.req.param("id");
    const body = AppendItems.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(productionRun).where(eq(productionRun.id, id));
      if (!run) throw new BusinessError("not_found", "production_run not found", 404);
      if (run.status !== "draft") {
        throw new BusinessError("conflict", `cannot edit items on status ${run.status}`, 409);
      }
      for (const it of body.items) {
        await tx.insert(productionRunItem).values({
          productionRunId: id,
          productId: it.product_id,
          variantId: it.variant_id ?? null,
          quantityProduced: it.quantity_produced,
          batchCode: it.batch_code ?? null,
        });
      }
      await tx
        .update(productionRun)
        .set({ updatedAt: new Date() })
        .where(eq(productionRun.id, id));
      const items = await tx
        .select()
        .from(productionRunItem)
        .where(eq(productionRunItem.productionRunId, id));
      return { ...run, items };
    });

    await writeAudit(db, c, {
      action: "production_run.append_items",
      entityType: "production_run",
      entityId: id,
      after: { added: body.items.length },
    });
    return c.json({ data: updated });
  });

  /** Edit a single draft line (typo on quantity, missing batch code, etc.). */
  r.patch("/:id/items/:itemId", async (c) => {
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body = UpdateItem.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(productionRun).where(eq(productionRun.id, id));
      if (!run) throw new BusinessError("not_found", "production_run not found", 404);
      if (run.status !== "draft") {
        throw new BusinessError("conflict", `cannot edit items on status ${run.status}`, 409);
      }
      const patch: { quantityProduced?: number; batchCode?: string | null } = {};
      if (body.quantity_produced !== undefined) patch.quantityProduced = body.quantity_produced;
      if (body.batch_code !== undefined) patch.batchCode = body.batch_code;
      if (Object.keys(patch).length === 0) {
        throw new BusinessError("validation_failed", "nothing to update", 400);
      }
      const [row] = await tx
        .update(productionRunItem)
        .set(patch)
        .where(and(eq(productionRunItem.id, itemId), eq(productionRunItem.productionRunId, id)))
        .returning();
      if (!row) throw new BusinessError("not_found", "item not found", 404);
      return row;
    });
    await writeAudit(db, c, {
      action: "production_run.update_item",
      entityType: "production_run_item",
      entityId: itemId,
      after: body,
    });
    return c.json({ data: updated });
  });

  /** Remove a flavour line from a draft run. */
  r.delete("/:id/items/:itemId", async (c) => {
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");

    await db.transaction(async (tx) => {
      const [run] = await tx.select().from(productionRun).where(eq(productionRun.id, id));
      if (!run) throw new BusinessError("not_found", "production_run not found", 404);
      if (run.status !== "draft") {
        throw new BusinessError("conflict", `cannot edit items on status ${run.status}`, 409);
      }
      const result = await tx
        .delete(productionRunItem)
        .where(and(eq(productionRunItem.id, itemId), eq(productionRunItem.productionRunId, id)))
        .returning();
      if (result.length === 0) throw new BusinessError("not_found", "item not found", 404);
    });
    await writeAudit(db, c, {
      action: "production_run.delete_item",
      entityType: "production_run_item",
      entityId: itemId,
    });
    return c.json({ data: { ok: true } });
  });

  return r;
}
