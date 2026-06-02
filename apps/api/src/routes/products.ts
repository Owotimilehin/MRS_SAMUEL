import { Hono } from "hono";
import { eq, isNull, and, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { product, productPrice, productVariant, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const VariantInput = z.object({
  size_ml: z.number().int().positive(),
  sku: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  price_ngn: z.number().int().positive(),
});

const CreateProduct = z
  .object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    category: z.enum(["regular", "special", "punch"]),
    ingredients: z.array(z.string()).default([]),
    shelf_life_hours: z.number().int().positive().default(48),
    display_order: z.number().int().default(0),
    // Preferred: list each can size + price explicitly.
    variants: z.array(VariantInput).optional(),
    // Legacy single-variant shape, kept for tests and any older callers.
    size_ml: z.number().int().positive().optional(),
    initial_price_ngn: z.number().int().positive().optional(),
  })
  .refine(
    (b) => (b.variants && b.variants.length > 0) || b.initial_price_ngn != null,
    { message: "either variants[] or initial_price_ngn is required" },
  );

const PublishPrice = z.object({
  // Preferred: target a specific can size. Omitted = the smallest variant
  // (preserves the legacy single-price contract for tests and older callers).
  variant_id: z.string().uuid().optional(),
  price_ngn: z.number().int().positive(),
});

interface VariantWithPrice {
  id: string;
  size_ml: number;
  sku: string;
  is_active: boolean;
  current_price_ngn: number | null;
}

async function loadVariantsForProduct(
  db: DbClient,
  productId: string,
): Promise<VariantWithPrice[]> {
  const variants = await db
    .select()
    .from(productVariant)
    .where(and(eq(productVariant.productId, productId), isNull(productVariant.deletedAt)))
    .orderBy(asc(productVariant.sizeMl));

  const out: VariantWithPrice[] = [];
  for (const v of variants) {
    const [price] = await db
      .select()
      .from(productPrice)
      .where(and(eq(productPrice.variantId, v.id), isNull(productPrice.validTo)))
      .orderBy(desc(productPrice.validFrom))
      .limit(1);
    out.push({
      id: v.id,
      size_ml: v.sizeMl,
      sku: v.sku,
      is_active: v.isActive,
      current_price_ngn: price?.priceNgn ?? null,
    });
  }
  return out;
}

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

    const variants = await loadVariantsForProduct(db, id);
    // Legacy: "current_price_ngn" reflects the smallest variant's price — keeps
    // existing readers (public catalog, list page) working until they migrate.
    const canonical = variants.find((v) => v.current_price_ngn != null) ?? null;
    return c.json({
      data: {
        ...row,
        current_price_ngn: canonical?.current_price_ngn ?? null,
        variants,
      },
    });
  });

  r.post("/", requireCapability("products.manage"), async (c) => {
    const body = CreateProduct.parse(await c.req.json());
    const auth = c.get("auth");

    // Pre-check for a clean 422 instead of a raw 23505 surfacing as 500.
    const [dupe] = await db.select().from(product).where(eq(product.slug, body.slug));
    if (dupe) {
      throw new BusinessError("conflict", `slug "${body.slug}" already in use`, 422);
    }

    // Normalize legacy shape (size_ml + initial_price_ngn) to variants[].
    const variants =
      body.variants && body.variants.length > 0
        ? body.variants
        : [
            {
              size_ml: body.size_ml ?? 330,
              price_ngn: body.initial_price_ngn ?? 0,
            },
          ];

    // Reject duplicate sizes in one payload — saves a confused 23505 from the DB.
    const sizes = new Set<number>();
    for (const v of variants) {
      if (sizes.has(v.size_ml)) {
        throw new BusinessError(
          "validation_failed",
          `duplicate size_ml ${v.size_ml} in variants`,
          422,
        );
      }
      sizes.add(v.size_ml);
    }

    const created = await db.transaction(async (tx) => {
      // Display sizeMl on the product mirrors the smallest variant — a UI
      // convenience until product.sizeMl is dropped in a later cleanup.
      const smallestSize = Math.min(...variants.map((v) => v.size_ml));
      const [row] = await tx
        .insert(product)
        .values({
          name: body.name,
          slug: body.slug,
          category: body.category,
          ingredients: body.ingredients,
          sizeMl: smallestSize,
          shelfLifeHours: body.shelf_life_hours,
          displayOrder: body.display_order,
        })
        .returning();
      if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);

      const variantsCreated: { id: string; size_ml: number; price_ngn: number }[] = [];
      for (const v of variants) {
        const sku = "sku" in v && v.sku ? v.sku : `${body.slug}-${v.size_ml}ml`;
        const [vRow] = await tx
          .insert(productVariant)
          .values({
            productId: row.id,
            sizeMl: v.size_ml,
            sku,
          })
          .returning();
        if (!vRow) throw new BusinessError("internal_error", "variant insert failed", 500);
        await tx.insert(productPrice).values({
          productId: row.id,
          variantId: vRow.id,
          priceNgn: v.price_ngn,
          createdByUserId: auth.userId,
        });
        variantsCreated.push({ id: vRow.id, size_ml: v.size_ml, price_ngn: v.price_ngn });
      }
      return { row, variants: variantsCreated };
    });

    await writeAudit(db, c, {
      action: "product.create",
      entityType: "product",
      entityId: created.row.id,
      after: { ...created.row, variants: created.variants },
    });
    return c.json({ data: { ...created.row, variants: created.variants } }, 201);
  });

  /**
   * Publish a new price for one variant. Closes the existing price row (sets
   * valid_to=now()) and inserts a fresh row.
   */
  r.post("/:id/prices", requireCapability("prices.manage"), async (c) => {
    const id = c.req.param("id");
    const body = PublishPrice.parse(await c.req.json());
    const auth = c.get("auth");

    const [existing] = await db.select().from(product).where(eq(product.id, id));
    if (!existing) throw new BusinessError("not_found", "product not found", 404);

    let variantId = body.variant_id;
    let variantSizeMl: number | null = null;
    if (variantId) {
      const [v] = await db
        .select()
        .from(productVariant)
        .where(and(eq(productVariant.id, variantId), eq(productVariant.productId, id)));
      if (!v) {
        throw new BusinessError(
          "validation_failed",
          "variant does not belong to this product",
          422,
        );
      }
      variantSizeMl = v.sizeMl;
    } else {
      // Legacy call: default to the smallest can size.
      const [smallest] = await db
        .select()
        .from(productVariant)
        .where(and(eq(productVariant.productId, id), isNull(productVariant.deletedAt)))
        .orderBy(asc(productVariant.sizeMl))
        .limit(1);
      if (!smallest) {
        throw new BusinessError("not_found", "no variants for this product", 404);
      }
      variantId = smallest.id;
      variantSizeMl = smallest.sizeMl;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(productPrice)
        .set({ validTo: new Date() })
        .where(and(eq(productPrice.variantId, variantId!), isNull(productPrice.validTo)));
      await tx.insert(productPrice).values({
        productId: id,
        variantId: variantId!,
        priceNgn: body.price_ngn,
        createdByUserId: auth.userId,
      });
    });

    await writeAudit(db, c, {
      action: "product_price.publish",
      entityType: "product",
      entityId: id,
      after: { variant_id: variantId, size_ml: variantSizeMl, price_ngn: body.price_ngn },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
