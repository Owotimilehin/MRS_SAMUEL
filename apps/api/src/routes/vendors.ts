import { Hono } from "hono";
import { eq, and, isNull, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { vendor, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  email: z.string().email().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export function vendorRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", requireCapability("expenses.view"), async (c) => {
    const url = new URL(c.req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const conds = [isNull(vendor.deletedAt)];
    if (q.length > 0) {
      conds.push(ilike(vendor.name, `%${q}%`));
    }
    const rows = await db
      .select()
      .from(vendor)
      .where(and(...conds))
      .orderBy(sql`${vendor.name} ASC`)
      .limit(20);
    return c.json({ data: rows });
  });

  r.get("/:id", requireCapability("expenses.view"), async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(vendor).where(eq(vendor.id, id));
    if (!row) throw new BusinessError("not_found", "vendor not found", 404);
    return c.json({ data: row });
  });

  r.post("/", requireCapability("expenses.write"), async (c) => {
    const body = CreateBody.parse(await c.req.json());
    const [row] = await db
      .insert(vendor)
      .values({
        name: body.name.trim(),
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        notes: body.notes?.trim() || null,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);
    await writeAudit(db, c, {
      action: "vendor.create",
      entityType: "vendor",
      entityId: row.id,
      after: { name: row.name },
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/:id", requireCapability("expenses.write"), async (c) => {
    const id = c.req.param("id");
    const body = PatchBody.parse(await c.req.json());
    const patch: Partial<typeof vendor.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.phone !== undefined) patch.phone = body.phone?.trim() || null;
    if (body.email !== undefined) patch.email = body.email?.trim() || null;
    if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;
    const [row] = await db
      .update(vendor)
      .set(patch)
      .where(eq(vendor.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "vendor not found", 404);
    await writeAudit(db, c, {
      action: "vendor.update",
      entityType: "vendor",
      entityId: id,
      after: patch,
    });
    return c.json({ data: row });
  });

  r.delete("/:id", requireCapability("expenses.write"), async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .update(vendor)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(vendor.id, id), isNull(vendor.deletedAt)))
      .returning();
    if (!row) {
      const [existed] = await db.select().from(vendor).where(eq(vendor.id, id));
      if (!existed) throw new BusinessError("not_found", "vendor not found", 404);
    }
    await writeAudit(db, c, {
      action: "vendor.delete",
      entityType: "vendor",
      entityId: id,
    });
    return c.json({ data: { id, deleted: true } });
  });

  return r;
}
