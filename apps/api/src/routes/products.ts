import { Hono } from "hono";
import { eq, isNull, and, desc } from "drizzle-orm";
import { z } from "zod";
import { product, productPrice, type DbClient } from "@ms/db";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const CreateProduct = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(["regular", "special", "punch"]),
  ingredients: z.array(z.string()).default([]),
  size_ml: z.number().int().positive().optional(),
  shelf_life_hours: z.number().int().positive().default(48),
  display_order: z.number().int().default(0),
  initial_price_ngn: z.number().int().positive(),
});

const PublishPrice = z.object({
  price_ngn: z.number().int().positive(),
});

export function productRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", async (c) => {
    const rows = await db.select().from(product).where(isNull(product.deletedAt));
    return c.json({ data: rows });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    if (!row) throw new BusinessError("not_found", "product not found", 404);
    const prices = await db
      .select()
      .from(productPrice)
      .where(and(eq(productPrice.productId, id), isNull(productPrice.validTo)))
      .orderBy(desc(productPrice.validFrom))
      .limit(1);
    return c.json({ data: { ...row, current_price_ngn: prices[0]?.priceNgn ?? null } });
  });

  r.post("/", requireRole("owner"), async (c) => {
    const body = CreateProduct.parse(await c.req.json());
    const auth = c.get("auth");

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(product)
        .values({
          name: body.name,
          slug: body.slug,
          category: body.category,
          ingredients: body.ingredients,
          sizeMl: body.size_ml ?? null,
          shelfLifeHours: body.shelf_life_hours,
          displayOrder: body.display_order,
        })
        .returning();
      if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);
      await tx.insert(productPrice).values({
        productId: row.id,
        priceNgn: body.initial_price_ngn,
        createdByUserId: auth.userId,
      });
      return row;
    });

    await writeAudit(db, c, {
      action: "product.create",
      entityType: "product",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  r.post("/:id/prices", requireRole("owner"), async (c) => {
    const id = c.req.param("id");
    const body = PublishPrice.parse(await c.req.json());
    const auth = c.get("auth");

    const [existing] = await db.select().from(product).where(eq(product.id, id));
    if (!existing) throw new BusinessError("not_found", "product not found", 404);

    await db.transaction(async (tx) => {
      await tx
        .update(productPrice)
        .set({ validTo: new Date() })
        .where(and(eq(productPrice.productId, id), isNull(productPrice.validTo)));
      await tx.insert(productPrice).values({
        productId: id,
        priceNgn: body.price_ngn,
        createdByUserId: auth.userId,
      });
    });

    await writeAudit(db, c, {
      action: "product_price.publish",
      entityType: "product",
      entityId: id,
      after: { price_ngn: body.price_ngn },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
