import { Hono } from "hono";
import { eq, and, desc, sql, ne, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  stockTransfer,
  stockTransferItem,
  stockLedger,
  outboxEvent,
  product,
  type DbClient,
} from "@ms/db";
import { checkFactoryStockAvailable, nextTransferNumber } from "@ms/domain";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireFactoryRole } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const CreateDraft = z.object({
  factory_id: z.string().uuid(),
  branch_id: z.string().uuid(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity_sent: z.number().int().positive(),
        unit_cost_ngn: z.number().int().nonnegative().optional(),
        notes: z.string().optional(),
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
    if (auth.role === "branch_manager" || auth.role === "branch_staff") {
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

  // ============ Detail ============
  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [t] = await db.select().from(stockTransfer).where(eq(stockTransfer.id, id));
    if (!t) throw new BusinessError("not_found", "transfer not found", 404);
    const items = await db
      .select()
      .from(stockTransferItem)
      .where(eq(stockTransferItem.stockTransferId, id));
    return c.json({ data: { ...t, items } });
  });

  // ============ Send (factory) ============
  // Single-step create + dispatch: the row is inserted already in `dispatched`,
  // factory stock is debited, and the branch is notified atomically.
  r.post("/", requireFactoryRole(), async (c) => {
    const body = CreateDraft.parse(await c.req.json());
    const auth = c.get("auth");

    const created = await db.transaction(async (tx) => {
      // Verify factory has enough stock before reserving a transfer number
      // (so failed attempts don't burn sequence values).
      const check = await checkFactoryStockAvailable(
        tx,
        body.factory_id,
        body.items.map((i) => ({ productId: i.product_id, quantity: i.quantity_sent })),
      );
      if (!check.ok) {
        throw new BusinessError("conflict", "insufficient factory stock", 422, {
          insufficient: check.insufficient,
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

      for (const it of body.items) {
        await tx.insert(stockTransferItem).values({
          stockTransferId: t.id,
          productId: it.product_id,
          quantitySent: it.quantity_sent,
          unitCostNgn: it.unit_cost_ngn ?? null,
          notes: it.notes ?? null,
        });
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: t.factoryId,
          productId: it.product_id,
          delta: -it.quantity_sent,
          sourceType: "transfer_dispatch",
          sourceId: t.id,
          recordedByUserId: auth.userId,
          note: `Dispatch ${t.transferNumber}`,
        });
      }

      await tx.insert(outboxEvent).values({
        eventType: "stock_transfer.dispatched",
        payload: {
          transfer_id: t.id,
          transfer_number: t.transferNumber,
          branch_id: t.branchId,
          factory_id: t.factoryId,
        },
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
  r.patch("/:id/arrive", async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (auth.role !== "owner" && t.branchId !== auth.branchId) {
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
      await tx.insert(outboxEvent).values({
        eventType: "stock_transfer.arrived",
        payload: { transfer_id: id, transfer_number: t.transferNumber, branch_id: t.branchId },
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
  r.patch("/:id/receive", async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");
    const body = ReceiveBody.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (auth.role !== "owner" && t.branchId !== auth.branchId) {
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
          await tx.insert(stockLedger).values({
            locationType: "branch",
            locationId: t.branchId,
            productId: it.productId,
            delta: inp.quantity_received,
            sourceType: "transfer_receive",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Receive ${t.transferNumber}`,
          });
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
        await tx.insert(outboxEvent).values({
          eventType: "stock_transfer.variance_review",
          payload: {
            transfer_id: id,
            transfer_number: t.transferNumber,
            branch_id: t.branchId,
          },
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

  // ============ Approve variance (owner) ============
  r.patch("/:id/approve", requireRole("owner"), async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (t.status !== "received_with_variance") {
        throw new BusinessError("conflict", `cannot approve from ${t.status}`, 409);
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
    });

    await writeAudit(db, c, {
      action: "stock_transfer.approve_variance",
      entityType: "stock_transfer",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Reject (branch or owner) ============
  r.patch("/:id/reject", async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");
    const { reason } = RejectBody.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (t.status !== "arrived") {
        throw new BusinessError("conflict", `cannot reject from ${t.status}`, 409);
      }
      if (auth.role !== "owner" && t.branchId !== auth.branchId) {
        throw new BusinessError("forbidden", "wrong branch", 403);
      }

      const items = await tx
        .select()
        .from(stockTransferItem)
        .where(eq(stockTransferItem.stockTransferId, id));
      // Reverse the factory ledger so the rejected stock returns to inventory.
      for (const it of items) {
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: t.factoryId,
          productId: it.productId,
          delta: it.quantitySent,
          sourceType: "transfer_reject_reverse",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Reject reverse ${t.transferNumber}: ${reason}`,
        });
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

      await tx.insert(outboxEvent).values({
        eventType: "stock_transfer.rejected",
        payload: {
          transfer_id: id,
          transfer_number: t.transferNumber,
          branch_id: t.branchId,
          reason,
        },
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
  r.patch("/:id/items/:itemId/adjust", requireRole("owner"), async (c) => {
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
          productId: it.productId,
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
          productId: it.productId,
          delta,
          sourceType: "count_correction",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Received adjusted ${oldQty}→${body.new_quantity} (${body.reason})`,
        });
      }
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

  // ============ Shrinkage report ============
  // Every transfer where sent != received, with the variance bottles and
  // value (uses the variant's current price as cost proxy if unit_cost_ngn
  // is null). Owner-only.
  r.get("/shrinkage", requireRole("owner"), async (c) => {
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

  return r;
}
