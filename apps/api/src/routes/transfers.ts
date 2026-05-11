import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import {
  stockTransfer,
  stockTransferItem,
  stockLedger,
  outboxEvent,
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
      z.object({
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
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

const RejectBody = z.object({ reason: z.string().min(1) });

const ListQuery = z.object({
  status: z
    .enum([
      "draft",
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

  // ============ Create draft (factory) ============
  r.post("/", requireFactoryRole(), async (c) => {
    const body = CreateDraft.parse(await c.req.json());

    const created = await db.transaction(async (tx) => {
      const number = await nextTransferNumber(tx);
      const [t] = await tx
        .insert(stockTransfer)
        .values({
          transferNumber: number,
          factoryId: body.factory_id,
          branchId: body.branch_id,
          status: "draft",
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
      }
      return t;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.create_draft",
      entityType: "stock_transfer",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  // ============ Dispatch (factory) ============
  r.patch("/:id/dispatch", requireFactoryRole(), async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");

    const dispatched = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
      if (!t) throw new BusinessError("not_found", "transfer not found", 404);
      if (t.status !== "draft") {
        throw new BusinessError("conflict", `cannot dispatch from status ${t.status}`, 409);
      }

      const items = await tx
        .select()
        .from(stockTransferItem)
        .where(eq(stockTransferItem.stockTransferId, id));

      const check = await checkFactoryStockAvailable(
        tx,
        t.factoryId,
        items.map((i) => ({ productId: i.productId, quantity: i.quantitySent })),
      );
      if (!check.ok) {
        throw new BusinessError("conflict", "insufficient factory stock", 422, {
          insufficient: check.insufficient,
        });
      }

      for (const it of items) {
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: t.factoryId,
          productId: it.productId,
          delta: -it.quantitySent,
          sourceType: "transfer_dispatch",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Dispatch ${t.transferNumber}`,
        });
      }

      const [updated] = await tx
        .update(stockTransfer)
        .set({
          status: "dispatched",
          dispatchedAt: new Date(),
          dispatchedByUserId: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(stockTransfer.id, id))
        .returning();
      if (!updated) throw new BusinessError("internal_error", "update returned no rows", 500);

      await tx.insert(outboxEvent).values({
        eventType: "stock_transfer.dispatched",
        payload: {
          transfer_id: id,
          transfer_number: t.transferNumber,
          branch_id: t.branchId,
          factory_id: t.factoryId,
        },
      });

      return updated;
    });

    await writeAudit(db, c, {
      action: "stock_transfer.dispatch",
      entityType: "stock_transfer",
      entityId: id,
      after: dispatched,
    });
    return c.json({ data: dispatched });
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

  return r;
}
