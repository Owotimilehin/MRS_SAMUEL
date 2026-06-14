import { Hono } from "hono";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { z } from "zod";
import {
  packagingMaterial,
  packagingStockLedger,
  packagingPurchase,
  businessExpense,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const MaterialCreate = z.object({
  name: z.string().min(1).max(200),
  unit_label: z.string().min(1).max(50),
  size_ml: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  kind: z.enum(["bottle", "bag", "other"]).optional(),
});

const MaterialPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  unit_label: z.string().min(1).max(50).optional(),
  size_ml: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  kind: z.enum(["bottle", "bag", "other"]).optional(),
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

      await tx.insert(outboxEvent).values({
        eventType: "packaging.purchase_recorded",
        payload: {
          purchase_id: purchase.id,
          factory_id: body.factory_id,
          material_id: body.packaging_material_id,
          material_name: material.name,
          quantity: body.quantity,
          total_cost_ngn: body.total_cost_ngn,
          supplier_name: body.supplier_name ?? null,
        },
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
