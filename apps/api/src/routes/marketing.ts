import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  bundle,
  enquiryLead,
  contactMessage,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const slug = z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case").max(60);


const CreateBundle = z.object({
  slug,
  name: z.string().min(1).max(120),
  price_ngn: z.number().int().nonnegative(),
  description: z.string().max(600).nullable().optional(),
  contents_label: z.string().max(120).nullable().optional(),
  badge: z.string().max(60).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  display_order: z.number().int().optional().default(0),
  is_active: z.boolean().optional().default(true),
});
const PatchBundle = z.object({
  name: z.string().min(1).max(120).optional(),
  price_ngn: z.number().int().nonnegative().optional(),
  description: z.string().max(600).nullable().optional(),
  contents_label: z.string().max(120).nullable().optional(),
  badge: z.string().max(60).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  display_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

export function marketingRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("marketing.manage"));

  r.post("/bundles", async (c) => {
    const body = CreateBundle.parse(await c.req.json());
    const existing = await db
      .select({ id: bundle.id })
      .from(bundle)
      .where(eq(bundle.slug, body.slug))
      .limit(1);
    if (existing.length > 0) throw new BusinessError("conflict", "slug already in use", 409);

    const [row] = await db
      .insert(bundle)
      .values({
        slug: body.slug,
        name: body.name,
        priceNgn: body.price_ngn,
        description: body.description ?? null,
        contentsLabel: body.contents_label ?? null,
        badge: body.badge ?? null,
        imageUrl: body.image_url ?? null,
        displayOrder: body.display_order ?? 0,
        isActive: body.is_active ?? true,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert failed", 500);
    await writeAudit(db, c, {
      action: "bundle.create",
      entityType: "bundle",
      entityId: row.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/bundles/:id", async (c) => {
    const id = c.req.param("id");
    const body = PatchBundle.parse(await c.req.json());
    const [before] = await db.select().from(bundle).where(eq(bundle.id, id));
    if (!before) throw new BusinessError("not_found", "bundle not found", 404);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.price_ngn !== undefined) patch["priceNgn"] = body.price_ngn;
    if (body.description !== undefined) patch["description"] = body.description;
    if (body.contents_label !== undefined) patch["contentsLabel"] = body.contents_label;
    if (body.badge !== undefined) patch["badge"] = body.badge;
    if (body.image_url !== undefined) patch["imageUrl"] = body.image_url;
    if (body.display_order !== undefined) patch["displayOrder"] = body.display_order;
    if (body.is_active !== undefined) patch["isActive"] = body.is_active;

    const [row] = await db.update(bundle).set(patch).where(eq(bundle.id, id)).returning();
    if (!row) throw new BusinessError("internal_error", "update failed", 500);
    await writeAudit(db, c, {
      action: "bundle.update",
      entityType: "bundle",
      entityId: id,
      before,
      after: row,
    });
    return c.json({ data: row });
  });

  r.delete("/bundles/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.delete(bundle).where(eq(bundle.id, id)).returning();
    if (!row) throw new BusinessError("not_found", "bundle not found", 404);
    await writeAudit(db, c, {
      action: "bundle.delete",
      entityType: "bundle",
      entityId: id,
      before: row,
    });
    return c.json({ data: { ok: true } });
  });

  // ---------------- Leads (read-only inbox) ----------------
  r.get("/leads/enquiries", async (c) => {
    const rows = await db
      .select()
      .from(enquiryLead)
      .orderBy(desc(enquiryLead.createdAt))
      .limit(500);
    return c.json({ data: rows });
  });

  r.get("/leads/contact", async (c) => {
    const rows = await db
      .select()
      .from(contactMessage)
      .orderBy(desc(contactMessage.createdAt))
      .limit(500);
    return c.json({ data: rows });
  });

  return r;
}
