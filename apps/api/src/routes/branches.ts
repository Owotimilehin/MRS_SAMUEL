import { Hono } from "hono";
import { eq, isNull } from "drizzle-orm";
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

const PatchBranch = CreateBranch.partial();

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

    const [after] = await db.update(branch).set(patch).where(eq(branch.id, id)).returning();
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

  return r;
}
