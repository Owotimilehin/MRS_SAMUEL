import { Hono } from "hono";
import { eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { branch, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const DeliveryZone = z.object({
  name: z.string().min(1),
  fee_ngn: z.number().int().nonnegative(),
});

const CreateBranch = z.object({
  name: z.string().min(1),
  code: z.string().regex(/^[A-Z0-9_-]+$/),
  address: z.string().optional(),
  phone: z.string().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  manager_user_id: z.string().uuid().nullable().optional(),
  delivery_zones: z.array(DeliveryZone).default([]),
  opens_at: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  closes_at: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
});

const PatchBranch = CreateBranch.partial().extend({
  is_online_default: z.boolean().optional(),
});

export function branchRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", async (c) => {
    const rows = await db.select().from(branch).where(isNull(branch.deletedAt));
    return c.json({ data: rows });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(branch).where(eq(branch.id, id));
    if (!row) throw new BusinessError("not_found", "branch not found", 404);
    return c.json({ data: row });
  });

  r.post("/", requireCapability("branches.manage"), async (c) => {
    const body = CreateBranch.parse(await c.req.json());
    const [row] = await db
      .insert(branch)
      .values({
        name: body.name,
        code: body.code,
        address: body.address ?? null,
        phone: body.phone ?? null,
        managerUserId: body.manager_user_id ?? null,
        deliveryZones: body.delivery_zones,
        opensAt: body.opens_at ?? null,
        closesAt: body.closes_at ?? null,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);
    await writeAudit(db, c, {
      action: "branch.create",
      entityType: "branch",
      entityId: row.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/:id", requireCapability("branches.manage"), async (c) => {
    const id = c.req.param("id");
    const body = PatchBranch.parse(await c.req.json());

    const [before] = await db.select().from(branch).where(eq(branch.id, id));
    if (!before) throw new BusinessError("not_found", "branch not found", 404);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.address !== undefined) patch["address"] = body.address;
    if (body.phone !== undefined) patch["phone"] = body.phone;
    if (body.lat !== undefined) patch["lat"] = body.lat === null ? null : String(body.lat);
    if (body.lng !== undefined) patch["lng"] = body.lng === null ? null : String(body.lng);
    if (body.manager_user_id !== undefined) patch["managerUserId"] = body.manager_user_id;
    if (body.delivery_zones !== undefined) patch["deliveryZones"] = body.delivery_zones;
    if (body.opens_at !== undefined) patch["opensAt"] = body.opens_at;
    if (body.closes_at !== undefined) patch["closesAt"] = body.closes_at;
    if (body.is_online_default !== undefined) patch["isOnlineDefault"] = body.is_online_default;

    // Exactly one branch may be the online-fulfilment default. Setting it on this
    // branch clears it everywhere else, in one transaction so the invariant holds.
    const after = await db.transaction(async (tx) => {
      if (body.is_online_default === true) {
        await tx
          .update(branch)
          .set({ isOnlineDefault: false, updatedAt: new Date() })
          .where(sql`${branch.id} <> ${id} AND ${branch.isOnlineDefault} = true`);
      }
      const [row] = await tx.update(branch).set(patch).where(eq(branch.id, id)).returning();
      return row;
    });
    if (!after) throw new BusinessError("internal_error", "update returned no rows", 500);

    await writeAudit(db, c, {
      action: "branch.update",
      entityType: "branch",
      entityId: id,
      before,
      after,
    });
    return c.json({ data: after });
  });

  // Soft-delete a branch. We never hard-delete — sales, closes and ledger rows
  // reference the branch and must stay readable. Setting deletedAt drops it from
  // the GET list (which filters isNull(deletedAt)) and isActive=false hides it
  // everywhere else. Guarded: refuse while the branch still holds on-hand stock
  // so inventory is never orphaned — the owner must transfer or write it off first.
  r.delete("/:id", requireCapability("branches.manage"), async (c) => {
    const id = c.req.param("id");
    const [before] = await db.select().from(branch).where(eq(branch.id, id));
    if (!before) throw new BusinessError("not_found", "branch not found", 404);
    if (before.deletedAt) throw new BusinessError("conflict", "branch already deleted", 409);

    const onHand = await db.execute<{ qty: number | string | null }>(sql`
      SELECT COALESCE(SUM(delta), 0)::int AS qty
      FROM stock_ledger
      WHERE location_type = 'branch' AND location_id = ${id}
    `);
    const remaining = Number(onHand[0]?.qty ?? 0);
    if (remaining > 0) {
      throw new BusinessError(
        "conflict",
        `branch still holds ${remaining} unit(s) of stock — transfer or write it off before deleting`,
        409,
        { on_hand: remaining },
      );
    }

    const [after] = await db
      .update(branch)
      .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(eq(branch.id, id))
      .returning();
    if (!after) throw new BusinessError("internal_error", "delete update returned no rows", 500);

    await writeAudit(db, c, {
      action: "branch.delete",
      entityType: "branch",
      entityId: id,
      before,
      after,
    });
    return c.json({ data: after });
  });

  return r;
}
