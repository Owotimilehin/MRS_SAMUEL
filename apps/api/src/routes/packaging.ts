import { Hono } from "hono";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  packagingMaterial,
  packagingStockLedger,
  packagingPurchase,
  packagingBalanceAt,
  businessExpense,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { enqueueOutbox } from "../lib/notify.js";

const MaterialCreate = z.object({
  name: z.string().min(1).max(200),
  unit_label: z.string().min(1).max(50),
  size_ml: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  kind: z.enum(["bottle", "bag", "straw", "other"]).optional(),
});

const MaterialPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  unit_label: z.string().min(1).max(50).optional(),
  size_ml: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  kind: z.enum(["bottle", "bag", "straw", "other"]).optional(),
});

const PurchaseCreate = z
  .object({
    factory_id: z.string().uuid(),
    packaging_material_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    unit_cost_ngn: z.number().int().nonnegative(),
    total_cost_ngn: z.number().int().nonnegative(),
    supplier_name: z.string().max(200).optional(),
    purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    feed_bookkeeping: z.boolean().optional().default(true),
  })
  .refine(
    (v) => v.total_cost_ngn === v.unit_cost_ngn * v.quantity,
    { message: "total_cost_ngn must equal unit_cost_ngn × quantity" },
  );

const ADJUST_REASONS = ["count_correction", "breakage", "spoilage", "theft_loss", "other"] as const;

const StockAdjust = z.object({
  location_type: z.enum(["factory", "branch"]),
  location_id: z.string().uuid(),
  packaging_material_id: z.string().uuid(),
  new_count: z.number().int().nonnegative(),
  reason: z.enum(ADJUST_REASONS),
  note: z.string().max(500).optional(),
});

/** Human label for a reason code, used in the ledger note + Telegram alert. */
const REASON_LABEL: Record<(typeof ADJUST_REASONS)[number], string> = {
  count_correction: "Stock count correction",
  breakage: "Breakage / damage",
  spoilage: "Spoilage / expiry",
  theft_loss: "Theft / loss",
  other: "Other",
};

/** Serialize a material row to the snake_case shape the admin UI expects. */
function serializeMaterial(m: typeof packagingMaterial.$inferSelect) {
  return {
    id: m.id,
    name: m.name,
    unit_label: m.unitLabel,
    size_ml: m.sizeMl,
    kind: m.kind,
    is_active: m.isActive,
  };
}

export function packagingRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  // ─── Materials ───
  r.get("/materials", requireCapability("packaging.view"), async (c) => {
    const rows = await db
      .select()
      .from(packagingMaterial)
      .orderBy(packagingMaterial.name);
    return c.json({ data: rows.map(serializeMaterial) });
  });

  r.post("/materials", requireCapability("packaging.write"), async (c) => {
    const body = MaterialCreate.parse(await c.req.json());
    const [row] = await db
      .insert(packagingMaterial)
      .values({
        name: body.name.trim(),
        unitLabel: body.unit_label.trim(),
        sizeMl: body.size_ml ?? null,
        kind: body.kind ?? "other",
        isActive: body.is_active ?? true,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);
    await writeAudit(db, c, {
      action: "packaging_material.create",
      entityType: "packaging_material",
      entityId: row.id,
      after: { name: row.name },
    });
    return c.json({ data: serializeMaterial(row) }, 201);
  });

  r.patch("/materials/:id", requireCapability("packaging.write"), async (c) => {
    const id = c.req.param("id");
    const body = MaterialPatch.parse(await c.req.json());
    const patch: Partial<typeof packagingMaterial.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.unit_label !== undefined) patch.unitLabel = body.unit_label.trim();
    if (body.size_ml !== undefined) patch.sizeMl = body.size_ml;
    if (body.is_active !== undefined) patch.isActive = body.is_active;
    if (body.kind !== undefined) patch.kind = body.kind;
    const [row] = await db
      .update(packagingMaterial)
      .set(patch)
      .where(eq(packagingMaterial.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "material not found", 404);
    await writeAudit(db, c, {
      action: "packaging_material.update",
      entityType: "packaging_material",
      entityId: id,
      after: patch,
    });
    return c.json({ data: serializeMaterial(row) });
  });

  // ─── Stock ───
  r.get("/stock", requireCapability("packaging.view"), async (c) => {
    const url = new URL(c.req.url);
    const factoryId = url.searchParams.get("factory_id");
    const locationType = url.searchParams.get("location_type") ?? (factoryId ? "factory" : null);
    const locationId = url.searchParams.get("location_id") ?? factoryId;
    if (!locationType || !locationId) {
      throw new BusinessError("validation_failed", "location_type+location_id (or factory_id) required", 400);
    }
    if (locationType !== "factory" && locationType !== "branch") {
      throw new BusinessError("validation_failed", "location_type must be 'factory' or 'branch'", 400);
    }

    const balances = await db.execute<{ packaging_material_id: string; balance: number }>(sql`
      SELECT packaging_material_id, COALESCE(SUM(delta), 0)::int AS balance
      FROM packaging_stock_ledger
      WHERE location_type = ${locationType} AND location_id = ${locationId}::uuid
      GROUP BY packaging_material_id
    `);
    const materials = await db.select().from(packagingMaterial);
    const balanceById = new Map(balances.map((b) => [b.packaging_material_id, Number(b.balance)]));

    const recentCostById = new Map<string, number>();
    if (locationType === "factory") {
      const recent = await db.execute<{ packaging_material_id: string; unit_cost_ngn: number }>(sql`
        SELECT DISTINCT ON (packaging_material_id) packaging_material_id, unit_cost_ngn
        FROM packaging_purchase
        WHERE factory_id = ${locationId}::uuid
        ORDER BY packaging_material_id, purchase_date DESC, created_at DESC
      `);
      for (const p of recent) recentCostById.set(p.packaging_material_id, Number(p.unit_cost_ngn));
    }

    const data = materials.map((m) => ({
      material_id: m.id,
      name: m.name,
      unit_label: m.unitLabel,
      size_ml: m.sizeMl,
      kind: m.kind,
      is_active: m.isActive,
      balance: balanceById.get(m.id) ?? 0,
      recent_unit_cost_ngn: recentCostById.get(m.id) ?? null,
    }));
    return c.json({ data });
  });

  // ─── Manual stock adjustment ───
  // Owner enters the actual on-hand count; the server computes the delta vs
  // the current balance and writes one `adjustment` ledger row. No bookkeeping
  // side-effect — an adjustment is a correction, not a purchase.
  r.post("/adjust", requireCapability("packaging.adjust"), async (c) => {
    const body = StockAdjust.parse(await c.req.json());
    const auth = c.get("auth");

    const [material] = await db
      .select()
      .from(packagingMaterial)
      .where(eq(packagingMaterial.id, body.packaging_material_id));
    if (!material) throw new BusinessError("not_found", "material not found", 404);

    const loc = { locationType: body.location_type, locationId: body.location_id };
    const current = await packagingBalanceAt(db, loc, body.packaging_material_id);
    const delta = body.new_count - current;
    if (delta === 0) {
      throw new BusinessError("validation_failed", "new_count equals current balance — nothing to adjust", 400);
    }

    const noteText = `${REASON_LABEL[body.reason]}${body.note?.trim() ? ` — ${body.note.trim()}` : ""}`;
    const sourceId = randomUUID();

    await db.transaction(async (tx) => {
      // The AFTER INSERT trigger guards against driving the balance negative.
      // It cannot here (new_count ≥ 0) but the guard stays for safety.
      await tx.insert(packagingStockLedger).values({
        factoryId: body.location_type === "factory" ? body.location_id : null,
        locationType: body.location_type,
        locationId: body.location_id,
        packagingMaterialId: body.packaging_material_id,
        delta,
        sourceType: "adjustment",
        sourceId,
        recordedByUserId: auth.userId,
        note: noteText,
      });

      await enqueueOutbox(tx, c, "packaging.stock_adjusted", {
        location_type: body.location_type,
        location_id: body.location_id,
        material_id: body.packaging_material_id,
        material_name: material.name,
        old_count: current,
        new_count: body.new_count,
        delta,
        reason: REASON_LABEL[body.reason],
        note: body.note?.trim() || null,
      });
    });

    await writeAudit(db, c, {
      action: "packaging_stock.adjust",
      entityType: "packaging_material",
      entityId: body.packaging_material_id,
      after: {
        name: material.name,
        location_type: body.location_type,
        old_count: current,
        new_count: body.new_count,
        delta,
        reason: REASON_LABEL[body.reason],
      },
    });

    return c.json({ data: { material_id: body.packaging_material_id, old_count: current, new_count: body.new_count, delta } }, 201);
  });

  // ─── Purchases ───
  r.get("/purchases", requireCapability("packaging.view"), async (c) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get("from") ??
      new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
    const factoryId = url.searchParams.get("factory_id");

    const conds = [
      gte(packagingPurchase.purchaseDate, from),
      lte(packagingPurchase.purchaseDate, to),
    ];
    if (factoryId) conds.push(eq(packagingPurchase.factoryId, factoryId));

    const rows = await db
      .select()
      .from(packagingPurchase)
      .where(and(...conds))
      .orderBy(desc(packagingPurchase.purchaseDate), desc(packagingPurchase.createdAt))
      .limit(200);
    return c.json({ data: rows });
  });

  r.post("/purchases", requireCapability("packaging.write"), async (c) => {
    const body = PurchaseCreate.parse(await c.req.json());
    const auth = c.get("auth");

    const [material] = await db
      .select()
      .from(packagingMaterial)
      .where(eq(packagingMaterial.id, body.packaging_material_id));
    if (!material) throw new BusinessError("not_found", "material not found", 404);

    const result = await db.transaction(async (tx) => {
      let expenseId: string | null = null;

      if (body.feed_bookkeeping) {
        const [exp] = await tx
          .insert(businessExpense)
          .values({
            expenseDate: body.purchase_date,
            categoryCode: "packaging",
            amountNgn: body.total_cost_ngn,
            vendorName: body.supplier_name?.trim() || null,
            description: `Purchased ${body.quantity} × ${material.name}`,
            recordedByUserId: auth.userId,
          })
          .returning();
        if (!exp) throw new BusinessError("internal_error", "expense insert returned no rows", 500);
        expenseId = exp.id;
      }

      const [purchase] = await tx
        .insert(packagingPurchase)
        .values({
          factoryId: body.factory_id,
          packagingMaterialId: body.packaging_material_id,
          quantity: body.quantity,
          unitCostNgn: body.unit_cost_ngn,
          totalCostNgn: body.total_cost_ngn,
          supplierName: body.supplier_name?.trim() || null,
          purchaseDate: body.purchase_date,
          businessExpenseId: expenseId,
          recordedByUserId: auth.userId,
        })
        .returning();
      if (!purchase) throw new BusinessError("internal_error", "purchase insert returned no rows", 500);

      await tx.insert(packagingStockLedger).values({
        factoryId: body.factory_id,
        locationType: "factory",
        locationId: body.factory_id,
        packagingMaterialId: body.packaging_material_id,
        delta: body.quantity,
        sourceType: "purchase",
        sourceId: purchase.id,
        recordedByUserId: auth.userId,
        note: body.supplier_name?.trim() || null,
      });

      await enqueueOutbox(tx, c, "packaging.purchase_recorded", {
        purchase_id: purchase.id,
        factory_id: body.factory_id,
        material_id: body.packaging_material_id,
        material_name: material.name,
        quantity: body.quantity,
        total_cost_ngn: body.total_cost_ngn,
        supplier_name: body.supplier_name ?? null,
      });

      return { purchase, expenseId };
    });

    await writeAudit(db, c, {
      action: "packaging_purchase.create",
      entityType: "packaging_purchase",
      entityId: result.purchase.id,
      after: {
        material_id: body.packaging_material_id,
        quantity: body.quantity,
        total_cost_ngn: body.total_cost_ngn,
        business_expense_id: result.expenseId,
      },
    });

    return c.json(
      {
        data: {
          id: result.purchase.id,
          business_expense_id: result.expenseId,
        },
      },
      201,
    );
  });

  // ─── Ledger history ───
  // Edit a purchase lot's unit cost and/or quantity (bottle prices change often,
  // and typos happen). Keeps all three side effects of a purchase consistent:
  // the FIFO lot (unit cost + qty), the factory stock ledger (a compensating
  // delta when qty changes), and the linked bookkeeping expense (new total).
  const PurchaseEdit = z
    .object({
      quantity: z.number().int().positive().optional(),
      unit_cost_ngn: z.number().int().nonnegative().optional(),
      supplier_name: z.string().max(200).nullish(),
      purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .refine(
      (v) =>
        v.quantity !== undefined ||
        v.unit_cost_ngn !== undefined ||
        v.supplier_name !== undefined ||
        v.purchase_date !== undefined,
      { message: "nothing to update" },
    );

  r.patch("/purchases/:id", requireCapability("packaging.write"), async (c) => {
    const id = c.req.param("id");
    const body = PurchaseEdit.parse(await c.req.json());
    const auth = c.get("auth");

    const result = await db
      .transaction(async (tx) => {
        const [purchase] = await tx
          .select()
          .from(packagingPurchase)
          .where(eq(packagingPurchase.id, id));
        if (!purchase) throw new BusinessError("not_found", "purchase not found", 404);

        const oldQty = purchase.quantity;
        const newQty = body.quantity ?? purchase.quantity;
        const newUnit = body.unit_cost_ngn ?? purchase.unitCostNgn;
        const newTotal = newQty * newUnit;
        const newDate = body.purchase_date ?? purchase.purchaseDate;
        const newSupplier =
          body.supplier_name === undefined
            ? purchase.supplierName
            : body.supplier_name?.trim() || null;

        const [updated] = await tx
          .update(packagingPurchase)
          .set({
            quantity: newQty,
            unitCostNgn: newUnit,
            totalCostNgn: newTotal,
            supplierName: newSupplier,
            purchaseDate: newDate,
          })
          .where(eq(packagingPurchase.id, id))
          .returning();
        if (!updated) throw new BusinessError("internal_error", "purchase update returned no rows", 500);

        // Quantity change → keep factory on-hand right with a compensating delta
        // (the ledger is append-only, so we add a row, never edit the original).
        if (newQty !== oldQty) {
          await tx.insert(packagingStockLedger).values({
            factoryId: purchase.factoryId,
            locationType: "factory",
            locationId: purchase.factoryId,
            packagingMaterialId: purchase.packagingMaterialId,
            delta: newQty - oldQty,
            sourceType: "purchase",
            sourceId: purchase.id,
            recordedByUserId: auth.userId,
            note: "purchase quantity corrected",
          });
        }

        // Keep the linked bookkeeping expense in step with the corrected total.
        if (purchase.businessExpenseId) {
          await tx
            .update(businessExpense)
            .set({ amountNgn: newTotal, expenseDate: newDate, vendorName: newSupplier })
            .where(eq(businessExpense.id, purchase.businessExpenseId));
        }

        return { before: purchase, after: updated };
      })
      .catch((err: unknown) => {
        if (err && typeof err === "object" && (err as { code?: string }).code === "23514") {
          throw new BusinessError(
            "conflict",
            "reducing the quantity would make packaging stock negative",
            409,
          );
        }
        throw err;
      });

    await writeAudit(db, c, {
      action: "packaging_purchase.update",
      entityType: "packaging_purchase",
      entityId: id,
      before: {
        quantity: result.before.quantity,
        unit_cost_ngn: result.before.unitCostNgn,
        total_cost_ngn: result.before.totalCostNgn,
      },
      after: {
        quantity: result.after.quantity,
        unit_cost_ngn: result.after.unitCostNgn,
        total_cost_ngn: result.after.totalCostNgn,
      },
    });

    return c.json({
      data: {
        id,
        quantity: result.after.quantity,
        unit_cost_ngn: result.after.unitCostNgn,
        total_cost_ngn: result.after.totalCostNgn,
      },
    });
  });

  r.get("/ledger", requireCapability("packaging.view"), async (c) => {
    const url = new URL(c.req.url);
    const factoryId = url.searchParams.get("factory_id");
    const locationType = url.searchParams.get("location_type") ?? (factoryId ? "factory" : null);
    const locationId = url.searchParams.get("location_id") ?? factoryId;
    const materialId = url.searchParams.get("material_id");
    if (!locationType || !locationId || !materialId) {
      throw new BusinessError("validation_failed", "location (factory_id or location_type+location_id) and material_id required", 400);
    }
    if (locationType !== "factory" && locationType !== "branch") {
      throw new BusinessError("validation_failed", "location_type must be 'factory' or 'branch'", 400);
    }
    const rows = await db
      .select()
      .from(packagingStockLedger)
      .where(
        and(
          eq(packagingStockLedger.locationType, locationType),
          eq(packagingStockLedger.locationId, locationId),
          eq(packagingStockLedger.packagingMaterialId, materialId),
        ),
      )
      .orderBy(desc(packagingStockLedger.occurredAt))
      .limit(200);
    const data = rows.map((row) => ({
      id: row.id,
      factory_id: row.factoryId,
      location_type: row.locationType,
      location_id: row.locationId,
      packaging_material_id: row.packagingMaterialId,
      delta: row.delta,
      source_type: row.sourceType,
      source_id: row.sourceId,
      occurred_at: row.occurredAt,
      recorded_by_user_id: row.recordedByUserId,
      note: row.note,
    }));
    return c.json({ data });
  });

  return r;
}
