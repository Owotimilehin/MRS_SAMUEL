import { Hono } from "hono";
import { eq, and, desc, sql, ne, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  stockTransfer,
  stockTransferItem,
  stockLedger,
  packagingStockLedger,
  packagingMaterial,
  packagingBalanceAt,
  product,
  productVariant,
  type DbClient,
} from "@ms/db";
import { checkFactoryStockAvailableByVariant, nextTransferNumber, recordVarianceLoss } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { enqueueOutbox } from "../lib/notify.js";

function actsOnAnyBranch(role: string): boolean {
  return role === "owner" || role === "admin" || role === "manager";
}

const CreateDraft = z.object({
  factory_id: z.string().uuid(),
  branch_id: z.string().uuid(),
  items: z
    .array(
      z
        .object({
          // A line is EITHER a product (juice) OR a packaging material (bag).
          product_id: z.string().uuid().nullish(),
          variant_id: z.string().uuid().nullish(),
          packaging_material_id: z.string().uuid().nullish(),
          quantity_sent: z.number().int().positive(),
          unit_cost_ngn: z.number().int().nonnegative().optional(),
          notes: z.string().optional(),
        })
        .refine((i) => (i.product_id != null) !== (i.packaging_material_id != null), {
          message: "each line must be a product XOR a packaging material",
        }),
    )
    .min(1),
  vehicle_info: z.string().optional(),
  driver_name: z.string().optional(),
  notes: z.string().optional(),
});

const ReceiveBody = z.object({
  items: z
    .array(
      z
        .object({
          item_id: z.string().uuid(),
          quantity_received: z.number().int().nonnegative(),
          variance_reason: z
            .enum([
              "short_shipped",
              "damaged_in_transit",
              "wrong_item",
              "extra_received",
              "count_error_at_branch",
              "other_with_note",
            ])
            .optional(),
          /** Free-text detail. REQUIRED when variance_reason === "other_with_note";
           *  optional for the canned reasons (lets the branch add colour). */
          variance_note: z.string().max(500).optional(),
          notes: z.string().optional(),
        })
        .refine(
          (v) => v.variance_reason !== "other_with_note" || (v.variance_note?.trim().length ?? 0) > 0,
          { message: "variance_note required when variance_reason is other_with_note" },
        ),
    )
    .min(1),
});

const RejectBody = z.object({ reason: z.string().min(1) });

const ListQuery = z.object({
  status: z
    .enum([
      "dispatched",
      "in_transit",
      "arrived",
      "received",
      "received_with_variance",
      "rejected",
      "completed",
      "cancelled",
    ])
    .optional(),
  branch_id: z.string().uuid().optional(),
  factory_id: z.string().uuid().optional(),
});

export function transferRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  // ============ List ============
  r.get("/", async (c) => {
    const auth = c.get("auth");
    const url = new URL(c.req.url);
    const q = ListQuery.parse(Object.fromEntries(url.searchParams));

    const conds = [];
    if (q.status) conds.push(eq(stockTransfer.status, q.status));
    if (q.factory_id) conds.push(eq(stockTransfer.factoryId, q.factory_id));

    // Branch users are restricted to their own branch.
    if (auth.role === "manager" || auth.role === "branch_staff") {
      if (!auth.branchId) throw new BusinessError("forbidden", "no branch", 403);
      conds.push(eq(stockTransfer.branchId, auth.branchId));
    } else if (q.branch_id) {
      conds.push(eq(stockTransfer.branchId, q.branch_id));
    }

    const rows = conds.length > 0
      ? await db
          .select()
          .from(stockTransfer)
          .where(and(...conds))
          .orderBy(desc(stockTransfer.createdAt))
          .limit(100)
      : await db
          .select()
          .from(stockTransfer)
          .orderBy(desc(stockTransfer.createdAt))
          .limit(100);
    return c.json({ data: rows });
  });

  // ============ Shrinkage report ============
  // Every transfer where sent != received, with the variance bottles and
  // value (uses the variant's current price as cost proxy if unit_cost_ngn
  // is null). Owner-only. Must be registered BEFORE /:id to avoid Hono
  // matching "shrinkage" as a UUID parameter.
  r.get("/shrinkage", requireCapability("shrinkage.view"), async (c) => {
    const url = new URL(c.req.url);
    const from = url.searchParams.get("from"); // YYYY-MM-DD
    const to = url.searchParams.get("to");

    const conds = [
      isNotNull(stockTransferItem.quantityReceived),
      ne(stockTransferItem.quantitySent, stockTransferItem.quantityReceived),
    ];
    if (from) conds.push(sql`${stockTransfer.receivedAt} >= ${from}::timestamptz`);
    if (to) conds.push(sql`${stockTransfer.receivedAt} < (${to}::date + interval '1 day')::timestamptz`);

    const rows = await db
      .select({
        transferId: stockTransfer.id,
        transferNumber: stockTransfer.transferNumber,
        receivedAt: stockTransfer.receivedAt,
        productId: stockTransferItem.productId,
        productName: product.name,
        quantitySent: stockTransferItem.quantitySent,
        quantityReceived: stockTransferItem.quantityReceived,
        varianceReason: stockTransferItem.varianceReason,
        varianceNote: stockTransferItem.varianceNote,
        unitCostNgn: stockTransferItem.unitCostNgn,
      })
      .from(stockTransferItem)
      .innerJoin(stockTransfer, eq(stockTransfer.id, stockTransferItem.stockTransferId))
      .innerJoin(product, eq(product.id, stockTransferItem.productId))
      .where(and(...conds))
      .orderBy(desc(stockTransfer.receivedAt));

    let totalBottles = 0;
    let totalNgn = 0;
    const out = rows.map((r) => {
      const lost = r.quantitySent - (r.quantityReceived ?? 0);
      const lineNgn = (r.unitCostNgn ?? 0) * lost;
      totalBottles += lost;
      totalNgn += lineNgn;
      return {
        transfer_id: r.transferId,
        transfer_number: r.transferNumber,
        received_at: r.receivedAt,
        product_id: r.productId,
        product_name: r.productName,
        quantity_sent: r.quantitySent,
        quantity_received: r.quantityReceived,
        bottles_lost: lost,
        unit_cost_ngn: r.unitCostNgn,
        line_loss_ngn: lineNgn,
        variance_reason: r.varianceReason,
        variance_note: r.varianceNote,
      };
    });
    return c.json({
      data: {
        lines: out,
        summary: { total_bottles_lost: totalBottles, total_loss_ngn: totalNgn, line_count: out.length },
      },
    });
  });

  // ============ Detail ============
  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [t] = await db.select().from(stockTransfer).where(eq(stockTransfer.id, id));
    if (!t) throw new BusinessError("not_found", "transfer not found", 404);
    const items = await db
      .select({
        id: stockTransferItem.id,
        stock_transfer_id: stockTransferItem.stockTransferId,
        product_id: stockTransferItem.productId,
        variant_id: stockTransferItem.variantId,
        size_ml: productVariant.sizeMl,
        packaging_material_id: stockTransferItem.packagingMaterialId,
        material_name: packagingMaterial.name,
        material_kind: packagingMaterial.kind,
        quantity_sent: stockTransferItem.quantitySent,
        quantity_received: stockTransferItem.quantityReceived,
        variance_reason: stockTransferItem.varianceReason,
        variance_note: stockTransferItem.varianceNote,
        unit_cost_ngn: stockTransferItem.unitCostNgn,
        notes: stockTransferItem.notes,
      })
      .from(stockTransferItem)
      .leftJoin(productVariant, eq(productVariant.id, stockTransferItem.variantId))
      .leftJoin(packagingMaterial, eq(packagingMaterial.id, stockTransferItem.packagingMaterialId))
      .where(eq(stockTransferItem.stockTransferId, id));
    return c.json({ data: { ...t, items } });
  });

  // ============ Send (factory) ============
  // Single-step create + dispatch: the row is inserted already in `dispatched`,
  // factory stock is debited, and the branch is notified atomically.
  r.post("/", requireCapability("transfers.create"), async (c) => {
    const body = CreateDraft.parse(await c.req.json());
    const auth = c.get("auth");

    // Split the lines: juices move through stock_ledger, bags through the
    // packaging ledger. Each line is one or the other (validated by zod + a DB
    // CHECK), so a line with no product_id is a packaging-material line.
    const productItems = body.items.filter((i) => i.product_id != null);
    const materialItems = body.items.filter((i) => i.packaging_material_id != null);

    const created = await db.transaction(async (tx) => {
      // Verify factory has enough stock before reserving a transfer number
      // (so failed attempts don't burn sequence values).
      const check = await checkFactoryStockAvailableByVariant(
        tx,
        body.factory_id,
        productItems.map((i) => ({ productId: i.product_id!, variantId: i.variant_id ?? null, quantity: i.quantity_sent })),
      );
      if (!check.ok) {
        throw new BusinessError("conflict", "insufficient factory stock", 422, {
          insufficient: check.insufficient,
        });
      }

      // Same pre-flight for bags: you can't ship more than the factory holds.
      // Aggregate per material so multiple lines of one bag are checked together.
      const bagWant = new Map<string, number>();
      for (const m of materialItems) {
        bagWant.set(m.packaging_material_id!, (bagWant.get(m.packaging_material_id!) ?? 0) + m.quantity_sent);
      }
      const bagShort: Array<{ packaging_material_id: string; available: number; requested: number }> = [];
      for (const [materialId, want] of bagWant) {
        const have = await packagingBalanceAt(tx, { locationType: "factory", locationId: body.factory_id }, materialId);
        if (have < want) bagShort.push({ packaging_material_id: materialId, available: have, requested: want });
      }
      if (bagShort.length > 0) {
        throw new BusinessError("conflict", "insufficient factory bag stock", 422, {
          insufficient_packaging: bagShort,
        });
      }

      const number = await nextTransferNumber(tx);
      const now = new Date();
      const [t] = await tx
        .insert(stockTransfer)
        .values({
          transferNumber: number,
          factoryId: body.factory_id,
          branchId: body.branch_id,
          status: "dispatched",
          dispatchedAt: now,
          dispatchedByUserId: auth.userId,
          vehicleInfo: body.vehicle_info ?? null,
          driverName: body.driver_name ?? null,
          notes: body.notes ?? null,
        })
        .returning();
      if (!t) throw new BusinessError("internal_error", "insert returned no rows", 500);

      for (const it of productItems) {
        await tx.insert(stockTransferItem).values({
          stockTransferId: t.id,
          productId: it.product_id,
          variantId: it.variant_id ?? null,
          quantitySent: it.quantity_sent,
          unitCostNgn: it.unit_cost_ngn ?? null,
          notes: it.notes ?? null,
        });
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: t.factoryId,
          productId: it.product_id!,
          variantId: it.variant_id ?? null,
          delta: -it.quantity_sent,
          sourceType: "transfer_dispatch",
          sourceId: t.id,
          recordedByUserId: auth.userId,
          note: `Dispatch ${t.transferNumber}`,
        });
      }

      // Bag lines: record the line and debit the factory packaging ledger.
      for (const it of materialItems) {
        await tx.insert(stockTransferItem).values({
          stockTransferId: t.id,
          packagingMaterialId: it.packaging_material_id,
          quantitySent: it.quantity_sent,
          unitCostNgn: it.unit_cost_ngn ?? null,
          notes: it.notes ?? null,
        });
        await tx.insert(packagingStockLedger).values({
          locationType: "factory",
          locationId: t.factoryId,
          factoryId: t.factoryId,
          packagingMaterialId: it.packaging_material_id!,
          delta: -it.quantity_sent,
          sourceType: "transfer_dispatch",
          sourceId: t.id,
          recordedByUserId: auth.userId,
          note: `Dispatch ${t.transferNumber}`,
        });
      }

      await enqueueOutbox(tx, c, "stock_transfer.dispatched", {
        transfer_id: t.id,
        transfer_number: t.transferNumber,
        branch_id: t.branchId,
        factory_id: t.factoryId,
      });

      return t;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.dispatch",
      entityType: "stock_transfer",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  // ============ Arrive (branch) ============
  r.patch("/:id/arrive", requireCapability("transfers.receive"), async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (!actsOnAnyBranch(auth.role) && t.branchId !== auth.branchId) {
        throw new BusinessError("forbidden", "wrong branch", 403);
      }
      if (!["dispatched", "in_transit"].includes(t.status)) {
        throw new BusinessError("conflict", `cannot mark arrived from ${t.status}`, 409);
      }
      const [u] = await tx
        .update(stockTransfer)
        .set({ status: "arrived", updatedAt: new Date() })
        .where(eq(stockTransfer.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      await enqueueOutbox(tx, c, "stock_transfer.arrived", {
        transfer_id: id,
        transfer_number: t.transferNumber,
        branch_id: t.branchId,
      });
      return u;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.arrive",
      entityType: "stock_transfer",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Receive + variance (branch) ============
  r.patch("/:id/receive", requireCapability("transfers.receive"), async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");
    const body = ReceiveBody.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (!actsOnAnyBranch(auth.role) && t.branchId !== auth.branchId) {
        throw new BusinessError("forbidden", "wrong branch", 403);
      }
      if (t.status !== "arrived") {
        throw new BusinessError("conflict", `cannot receive from ${t.status}`, 409);
      }

      const items = await tx
        .select()
        .from(stockTransferItem)
        .where(eq(stockTransferItem.stockTransferId, id));
      const byId = new Map(items.map((i) => [i.id, i]));

      // A receipt must cover EVERY line. A line dispatched but omitted here would
      // keep quantityReceived = null: debited from the factory at dispatch but
      // credited nowhere and never settled — a silent stock leak. Reject the
      // whole receipt so the branch resubmits a complete count.
      const submittedIds = new Set(body.items.map((i) => i.item_id));
      const missing = items.filter((it) => !submittedIds.has(it.id)).map((it) => it.id);
      if (missing.length > 0) {
        throw new BusinessError(
          "validation_failed",
          "every transfer line must be received — resubmit with all lines",
          422,
          { missing_item_ids: missing },
        );
      }

      let hasVariance = false;
      for (const inp of body.items) {
        const it = byId.get(inp.item_id);
        if (!it) {
          throw new BusinessError("validation_failed", `unknown item ${inp.item_id}`, 422);
        }
        const variance = inp.quantity_received !== it.quantitySent;
        if (variance && !inp.variance_reason) {
          throw new BusinessError(
            "validation_failed",
            `variance_reason required for line ${inp.item_id}`,
            422,
          );
        }
        if (variance) hasVariance = true;

        await tx
          .update(stockTransferItem)
          .set({
            quantityReceived: inp.quantity_received,
            varianceReason: inp.variance_reason ?? null,
            varianceNote: inp.variance_note ?? null,
            notes: inp.notes ?? it.notes,
          })
          .where(eq(stockTransferItem.id, it.id));

        if (inp.quantity_received > 0) {
          if (it.packagingMaterialId) {
            // Bag line → credit the branch packaging ledger.
            await tx.insert(packagingStockLedger).values({
              locationType: "branch",
              locationId: t.branchId,
              packagingMaterialId: it.packagingMaterialId,
              delta: inp.quantity_received,
              sourceType: "transfer_receive",
              sourceId: id,
              recordedByUserId: auth.userId,
              note: `Receive ${t.transferNumber}`,
            });
          } else {
            await tx.insert(stockLedger).values({
              locationType: "branch",
              locationId: t.branchId,
              productId: it.productId!,
              variantId: it.variantId ?? null,
              delta: inp.quantity_received,
              sourceType: "transfer_receive",
              sourceId: id,
              recordedByUserId: auth.userId,
              note: `Receive ${t.transferNumber}`,
            });
          }
        }
      }

      const newStatus = hasVariance ? "received_with_variance" : "received";
      const [u] = await tx
        .update(stockTransfer)
        .set({
          status: newStatus,
          receivedAt: new Date(),
          receivedByUserId: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(stockTransfer.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);

      // Auto-approve clean receipts. Variance receipts await owner review.
      if (!hasVariance) {
        await tx
          .update(stockTransfer)
          .set({
            status: "completed",
            approvedAt: new Date(),
            approvedByUserId: auth.userId,
          })
          .where(eq(stockTransfer.id, id));
      } else {
        await enqueueOutbox(tx, c, "stock_transfer.variance_review", {
          transfer_id: id,
          transfer_number: t.transferNumber,
          branch_id: t.branchId,
        });
      }
      return u;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.receive",
      entityType: "stock_transfer",
      entityId: id,
      after: updated,
    });
    // Re-read for the response so the caller sees "completed" status on clean
    // receipts (after the auto-approve step above).
    const [final] = await db.select().from(stockTransfer).where(eq(stockTransfer.id, id));
    return c.json({ data: final });
  });

  // ============ Settle variance + approve (owner-only) ============
  // For each varianced line the owner decides where the gap (sent - received)
  // settles: "factory"/"branch" relocate the gap onto that location's stock
  // (nothing lost); "loss" writes it off to variance_loss at retail value.
  // EVERY varianced line must carry an explicit decision — an approval that
  // leaves any line unsettled is rejected (422) and the transfer stays in
  // received_with_variance (still in the owner review inbox) for correction.
  // No silent default-to-loss: writing off stock as lost money is deliberate.
  const SettleBody = z.object({
    settlements: z
      .array(
        z.object({
          item_id: z.string().uuid(),
          settle: z.enum(["factory", "branch", "loss"]),
        }),
      )
      .default([]),
  });

  r.patch("/:id/approve", requireCapability("variance.settle"), async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");
    const body = SettleBody.parse(await c.req.json().catch(() => ({})));
    const settleByItem = new Map(body.settlements.map((s) => [s.item_id, s.settle]));

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (t.status !== "received_with_variance") {
        throw new BusinessError("conflict", `cannot approve from ${t.status}`, 409);
      }
      const items = await tx
        .select()
        .from(stockTransferItem)
        .where(eq(stockTransferItem.stockTransferId, id));

      // Every varianced line — juice OR bag — needs an explicit settlement.
      // Validate the whole request up front and reject before mutating anything,
      // so a partial approval never writes some lines and errors on others. Bag
      // lines are included so a short/over-shipped bag is no longer silently
      // dropped: the owner must place it (factory/branch) or write it off (loss).
      const variancedItems = items.filter(
        (it) =>
          it.quantityReceived != null &&
          it.quantitySent - it.quantityReceived !== 0,
      );
      const unsettled = variancedItems
        .filter((it) => !settleByItem.has(it.id))
        .map((it) => it.id);
      if (unsettled.length > 0) {
        throw new BusinessError(
          "validation_failed",
          "every varianced line needs a settlement (factory, branch, or loss)",
          422,
          { unsettled_item_ids: unsettled },
        );
      }
      // An over-receive (received > sent) has extra stock to place, not a loss
      // to write off — "loss" is meaningless there.
      const badLoss = variancedItems
        .filter(
          (it) => it.quantitySent - it.quantityReceived! < 0 && settleByItem.get(it.id) === "loss",
        )
        .map((it) => it.id);
      if (badLoss.length > 0) {
        throw new BusinessError(
          "validation_failed",
          "over-received lines cannot be written off as loss — choose factory or branch",
          422,
          { over_receive_item_ids: badLoss },
        );
      }

      for (const it of items) {
        if (it.quantityReceived == null) continue; // unreceived line
        const gap = it.quantitySent - it.quantityReceived;
        if (gap === 0) continue;
        const settle = settleByItem.get(it.id)!; // validated present above

        // Bag (packaging) line: relocate the gap in the packaging ledger for
        // factory/branch. "loss" writes no ledger row and no variance_loss —
        // bags are tracked-only, so a write-off carries no money value; the
        // deliberate choice is captured in the audit payload below.
        if (it.packagingMaterialId) {
          if (settle === "loss") continue;
          const locationId = settle === "factory" ? t.factoryId : t.branchId;
          await tx.insert(packagingStockLedger).values({
            locationType: settle,
            locationId,
            factoryId: settle === "factory" ? t.factoryId : null,
            packagingMaterialId: it.packagingMaterialId,
            delta: gap,
            sourceType: "transfer_variance_settlement",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Variance settle ${t.transferNumber} (${settle})`,
          });
          continue;
        }

        // Product (juice) line.
        if (it.productId == null) continue; // defensive: neither product nor bag
        if (settle === "loss") {
          if (gap <= 0) continue; // can't write off an over-receive
          await recordVarianceLoss(tx, {
            source: "transfer",
            sourceId: id,
            branchId: t.branchId,
            productId: it.productId,
            variantId: it.variantId ?? null,
            sizeMl: null,
            quantity: gap,
            reason: it.varianceReason ?? null,
            recordedByUserId: auth.userId,
          });
        } else {
          const locationId = settle === "factory" ? t.factoryId : t.branchId;
          await tx.insert(stockLedger).values({
            locationType: settle,
            locationId,
            productId: it.productId,
            variantId: it.variantId ?? null,
            delta: gap,
            sourceType: "transfer_variance_settlement",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Variance settle ${t.transferNumber} (${settle})`,
          });
        }
      }

      const [u] = await tx
        .update(stockTransfer)
        .set({
          status: "completed",
          approvedAt: new Date(),
          approvedByUserId: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(stockTransfer.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      return u;
    }).catch((err: unknown) => {
      // The append-only ledger trigger raises check_violation (23514) if a
      // settlement would drive a location's balance negative.
      if (err && typeof err === "object" && (err as { code?: string }).code === "23514") {
        throw new BusinessError("conflict", "settlement would make stock negative", 409);
      }
      throw err;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.settle_variance",
      entityType: "stock_transfer",
      entityId: id,
      // Capture the per-line decisions so an unvalued bag write-off ("loss",
      // which leaves no ledger trace) is still a durable, audited choice.
      after: { ...updated, settlements: body.settlements },
    });
    return c.json({ data: updated });
  });

  // ============ Reject (branch or owner) ============
  r.patch("/:id/reject", requireCapability("transfers.receive"), async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");
    const { reason } = RejectBody.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (t.status !== "arrived") {
        throw new BusinessError("conflict", `cannot reject from ${t.status}`, 409);
      }
      if (!actsOnAnyBranch(auth.role) && t.branchId !== auth.branchId) {
        throw new BusinessError("forbidden", "wrong branch", 403);
      }

      const items = await tx
        .select()
        .from(stockTransferItem)
        .where(eq(stockTransferItem.stockTransferId, id));
      // Reverse the factory ledger so the rejected stock returns to inventory —
      // juices to the stock ledger, bags to the packaging ledger.
      for (const it of items) {
        if (it.packagingMaterialId) {
          await tx.insert(packagingStockLedger).values({
            locationType: "factory",
            locationId: t.factoryId,
            factoryId: t.factoryId,
            packagingMaterialId: it.packagingMaterialId,
            delta: it.quantitySent,
            sourceType: "transfer_reject_reverse",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Reject reverse ${t.transferNumber}: ${reason}`,
          });
        } else {
          await tx.insert(stockLedger).values({
            locationType: "factory",
            locationId: t.factoryId,
            productId: it.productId!,
            variantId: it.variantId ?? null,
            delta: it.quantitySent,
            sourceType: "transfer_reject_reverse",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Reject reverse ${t.transferNumber}: ${reason}`,
          });
        }
      }

      const [u] = await tx
        .update(stockTransfer)
        .set({
          status: "rejected",
          rejectedAt: new Date(),
          rejectedByUserId: auth.userId,
          rejectReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(stockTransfer.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);

      await enqueueOutbox(tx, c, "stock_transfer.rejected", {
        transfer_id: id,
        transfer_number: t.transferNumber,
        branch_id: t.branchId,
        reason,
      });
      return u;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.reject",
      entityType: "stock_transfer",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Adjust counts (owner) ============
  // Fix a wrong quantity on a completed transfer after the fact. Writes a
  // count_correction ledger entry on whichever side moved (factory or branch)
  // so balances stay accurate. Use case: "we dispatched 50 but the manifest
  // said 48", or "we counted 47 received but a re-count shows 49".
  r.patch("/:id/items/:itemId/adjust", requireCapability("transfers.adjust"), async (c) => {
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");
    const auth = c.get("auth");
    const body = z
      .object({
        side: z.enum(["sent", "received"]),
        new_quantity: z.number().int().nonnegative(),
        reason: z.string().min(3).max(500),
      })
      .parse(await c.req.json());

    const result = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      const [it] = await tx
        .select()
        .from(stockTransferItem)
        .where(and(eq(stockTransferItem.id, itemId), eq(stockTransferItem.stockTransferId, id)));
      if (!it) throw new BusinessError("not_found", "transfer item not found", 404);
      // Bags are tracked-only; after-the-fact count corrections on bag lines
      // aren't supported yet (would need a packaging count_correction source).
      if (it.packagingMaterialId) {
        throw new BusinessError(
          "validation_failed",
          "count adjustments aren't supported on bag (packaging) lines",
          422,
        );
      }

      const oldQty = body.side === "sent" ? it.quantitySent : (it.quantityReceived ?? 0);
      const delta = body.new_quantity - oldQty;
      if (delta === 0) {
        return { transferItem: it, ledgerDelta: 0 };
      }

      if (body.side === "sent") {
        await tx
          .update(stockTransferItem)
          .set({ quantitySent: body.new_quantity })
          .where(eq(stockTransferItem.id, itemId));
        // Adjusting sent count moves stock at the factory: if new > old, we
        // shipped MORE than recorded → factory had more out → factory ledger
        // gets the negative delta to match. Vice versa for new < old.
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: t.factoryId,
          productId: it.productId!,
          variantId: it.variantId ?? null,
          delta: -delta,
          sourceType: "count_correction",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Sent adjusted ${oldQty}→${body.new_quantity} (${body.reason})`,
        });
      } else {
        await tx
          .update(stockTransferItem)
          .set({ quantityReceived: body.new_quantity })
          .where(eq(stockTransferItem.id, itemId));
        // Adjusting received count moves stock at the branch.
        await tx.insert(stockLedger).values({
          locationType: "branch",
          locationId: t.branchId,
          productId: it.productId!,
          variantId: it.variantId ?? null,
          delta,
          sourceType: "count_correction",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Received adjusted ${oldQty}→${body.new_quantity} (${body.reason})`,
        });
      }

      // Telegram alert so the owner (and the side whose count moved) sees
      // every after-the-fact correction in real time.
      await enqueueOutbox(tx, c, "stock_transfer.count_corrected", {
        transfer_id: id,
        transfer_number: t.transferNumber,
        side: body.side,
        old_quantity: oldQty,
        new_quantity: body.new_quantity,
        delta,
        reason: body.reason,
      });

      return { transferItem: { ...it, quantitySent: body.side === "sent" ? body.new_quantity : it.quantitySent, quantityReceived: body.side === "received" ? body.new_quantity : it.quantityReceived }, ledgerDelta: delta };
    });

    await writeAudit(db, c, {
      action: "stock_transfer.adjust_count",
      entityType: "stock_transfer_item",
      entityId: itemId,
      after: { side: body.side, new_quantity: body.new_quantity, reason: body.reason, ledger_delta: result.ledgerDelta },
    });
    return c.json({ data: result.transferItem });
  });

  return r;
}
