import { Hono } from "hono";
import { eq, and, gte, lte, sql, inArray, desc } from "drizzle-orm";
import { z } from "zod";
import {
  stockAdjustment,
  stockLedger,
  outboxEvent,
  product,
  factory,
  branch,
  adminUser,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability, requireAnyCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const AdjustBody = z
  .object({
    location_type: z.enum(["factory", "branch"]),
    location_id: z.string().uuid(),
    reason_code: z.enum([
      "physical_recount",
      "damaged",
      "spoilage",
      "theft",
      "found",
      "opening_balance",
      "other_with_note",
    ]),
    reason_note: z.string().max(500).optional(),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid(),
          new_quantity: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine(
    (v) => v.reason_code !== "other_with_note" || (v.reason_note?.trim().length ?? 0) > 0,
    { message: "reason_note required when reason_code is other_with_note" },
  );

export function inventoryRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("stock.adjust"));

  r.post("/adjust", async (c) => {
    const body = AdjustBody.parse(await c.req.json());
    const auth = c.get("auth");

    if (body.location_type === "factory") {
      const [f] = await db.select().from(factory).where(eq(factory.id, body.location_id));
      if (!f) throw new BusinessError("not_found", "factory not found", 404);
    } else {
      const [b] = await db.select().from(branch).where(eq(branch.id, body.location_id));
      if (!b) throw new BusinessError("not_found", "branch not found", 404);
    }

    const productIds = body.items.map((i) => i.product_id);
    const rows = await db
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(inArray(product.id, productIds));
    if (rows.length !== productIds.length) {
      throw new BusinessError("not_found", "one or more products not found", 404);
    }
    const nameById = new Map(rows.map((r) => [r.id, r.name]));

    const result = await db.transaction(async (tx) => {
      const [header] = await tx
        .insert(stockAdjustment)
        .values({
          locationType: body.location_type,
          locationId: body.location_id,
          reasonCode: body.reason_code,
          reasonNote: body.reason_note?.trim() ?? null,
          recordedByUserId: auth.userId,
        })
        .returning();
      if (!header) throw new BusinessError("internal_error", "insert returned no rows", 500);

      const lines: Array<{
        product_id: string;
        product_name: string;
        old_quantity: number;
        new_quantity: number;
        delta: number;
      }> = [];

      for (const item of body.items) {
        const balRow = await tx
          .select({ bal: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)::int` })
          .from(stockLedger)
          .where(
            and(
              eq(stockLedger.locationType, body.location_type),
              eq(stockLedger.locationId, body.location_id),
              eq(stockLedger.productId, item.product_id),
            ),
          );
        const oldQty = Number(balRow[0]?.bal ?? 0);
        const delta = item.new_quantity - oldQty;
        if (delta === 0) continue;

        try {
          await tx.insert(stockLedger).values({
            locationType: body.location_type,
            locationId: body.location_id,
            productId: item.product_id,
            delta,
            sourceType: "adjustment",
            sourceId: header.id,
            recordedByUserId: auth.userId,
            note: body.reason_note
              ? `${body.reason_code}: ${body.reason_note.trim()}`
              : body.reason_code,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/check_violation|negative/i.test(message)) {
            // ErrorCode taxonomy doesn't have a dedicated "would_go_negative"
            // entry; map to conflict (status 422) with the offending product
            // in details so the UI can render a precise inline error.
            throw new BusinessError("conflict", "stock would go negative", 422, {
              reason: "would_go_negative",
              product_id: item.product_id,
              current_quantity: oldQty,
              attempted_new_quantity: item.new_quantity,
            });
          }
          throw err;
        }

        lines.push({
          product_id: item.product_id,
          product_name: nameById.get(item.product_id) ?? item.product_id,
          old_quantity: oldQty,
          new_quantity: item.new_quantity,
          delta,
        });
      }

      await tx.insert(outboxEvent).values({
        eventType: "stock_adjustment.recorded",
        payload: {
          adjustment_id: header.id,
          location_type: body.location_type,
          location_id: body.location_id,
          reason_code: body.reason_code,
          reason_note: body.reason_note?.trim() ?? null,
          items: lines,
        },
      });

      return { adjustmentId: header.id, itemsRecorded: lines.length };
    });

    await writeAudit(db, c, {
      action: "stock_adjustment.create",
      entityType: "stock_adjustment",
      entityId: result.adjustmentId,
      after: { reason_code: body.reason_code, item_count: result.itemsRecorded },
    });

    return c.json(
      { data: { id: result.adjustmentId, items_recorded: result.itemsRecorded } },
      201,
    );
  });

  // History — list past adjustments with their ledger lines.
  // Gated by stock.adjust OR stock.read so both editors and viewers see it.
  r.get("/adjustments", requireAnyCapability("stock.adjust", "stock.read"), async (c) => {
    const url = new URL(c.req.url);
    const fromStr =
      url.searchParams.get("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const toStr = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
    const from = new Date(`${fromStr}T00:00:00.000Z`);
    const toEnd = new Date(`${toStr}T23:59:59.999Z`);
    const locationType = url.searchParams.get("location_type");
    const locationId = url.searchParams.get("location_id");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("page_size") ?? 50)));

    const conds = [
      gte(stockAdjustment.createdAt, from),
      lte(stockAdjustment.createdAt, toEnd),
    ];
    if (locationType === "factory" || locationType === "branch") {
      conds.push(eq(stockAdjustment.locationType, locationType));
    }
    if (locationId) conds.push(eq(stockAdjustment.locationId, locationId));

    const where = and(...conds);
    const totalRow = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(stockAdjustment)
      .where(where);
    const total = Number(totalRow[0]?.total ?? 0);

    const headers = await db
      .select({
        id: stockAdjustment.id,
        location_type: stockAdjustment.locationType,
        location_id: stockAdjustment.locationId,
        reason_code: stockAdjustment.reasonCode,
        reason_note: stockAdjustment.reasonNote,
        recorded_by_user_id: stockAdjustment.recordedByUserId,
        recorded_by_email: adminUser.email,
        created_at: stockAdjustment.createdAt,
      })
      .from(stockAdjustment)
      .leftJoin(adminUser, eq(adminUser.id, stockAdjustment.recordedByUserId))
      .where(where)
      .orderBy(desc(stockAdjustment.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const ids = headers.map((h) => h.id);
    const linesByHeader = new Map<string, Array<{
      product_id: string;
      product_name: string;
      delta: number;
      note: string | null;
    }>>();
    if (ids.length > 0) {
      const lines = await db
        .select({
          source_id: stockLedger.sourceId,
          product_id: stockLedger.productId,
          product_name: product.name,
          delta: stockLedger.delta,
          note: stockLedger.note,
        })
        .from(stockLedger)
        .leftJoin(product, eq(product.id, stockLedger.productId))
        .where(
          and(
            eq(stockLedger.sourceType, "adjustment"),
            inArray(stockLedger.sourceId, ids),
          ),
        );
      for (const l of lines) {
        const arr = linesByHeader.get(l.source_id) ?? [];
        arr.push({
          product_id: l.product_id,
          product_name: l.product_name ?? l.product_id,
          delta: l.delta,
          note: l.note,
        });
        linesByHeader.set(l.source_id, arr);
      }
    }

    const data = headers.map((h) => ({
      id: h.id,
      location_type: h.location_type,
      location_id: h.location_id,
      reason_code: h.reason_code,
      reason_note: h.reason_note,
      recorded_by_user_id: h.recorded_by_user_id,
      recorded_by_email: h.recorded_by_email,
      created_at: h.created_at.toISOString(),
      lines: linesByHeader.get(h.id) ?? [],
    }));

    return c.json({ data, pagination: { page, page_size: pageSize, total } });
  });

  return r;
}
