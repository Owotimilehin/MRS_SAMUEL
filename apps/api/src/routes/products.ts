import { Hono } from "hono";
import { eq, isNull, and, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { product, productPrice, productVariant, bottleMaterialIdForSize, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { looksLikeBareId } from "@ms/shared";

const VariantInput = z.object({
  size_ml: z.number().int().positive(),
  sku: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  price_ngn: z.number().int().positive(),
});

const HEX = /^#[0-9a-fA-F]{6}$/;
const PaletteInput = z.object({
  surface: z.string().regex(HEX),
  accent: z.string().regex(HEX),
  text: z.string().regex(HEX),
});
const IngredientDetailInput = z.object({
  name: z.string().min(1),
  benefit: z.string().min(1),
});

// Storefront marketing content + colour + media-library references. All
// optional so a bare product (name/slug/category/price) still creates cleanly;
// the admin editor fills these in for the rich customer juice pages.
const ContentFields = {
  image_url: z.string().min(1).optional(),
  tagline: z.string().optional(),
  story: z.string().optional(),
  pairing: z.string().optional(),
  note: z.string().optional(),
  benefits: z.array(z.string()).optional(),
  best_for: z.array(z.string()).optional(),
  ingredient_details: z.array(IngredientDetailInput).optional(),
  palette: PaletteInput.nullable().optional(),
  bottle_asset_id: z.string().uuid().nullable().optional(),
  cluster_asset_id: z.string().uuid().nullable().optional(),
  fruit_asset_id: z.string().uuid().nullable().optional(),
};

const CreateProduct = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((v) => !looksLikeBareId(v), {
        message: "name looks like an ID, not a flavour name",
      }),
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
    ...ContentFields,
  })
  .refine(
    (b) => (b.variants && b.variants.length > 0) || b.initial_price_ngn != null,
    { message: "either variants[] or initial_price_ngn is required" },
  );

// PATCH payload: edit product attributes + content. Variants/prices are managed
// by the dedicated /prices endpoint, so they're intentionally absent here.
const UpdateProduct = z.object({
  name: z
    .string()
    .min(1)
    .refine((v) => !looksLikeBareId(v), {
      message: "name looks like an ID, not a flavour name",
    })
    .optional(),
  category: z.enum(["regular", "special", "punch"]).optional(),
  ingredients: z.array(z.string()).optional(),
  shelf_life_hours: z.number().int().positive().optional(),
  display_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
  ...ContentFields,
});

// Map the snake_case content fields from a parsed payload onto the Drizzle
// product columns. Only keys actually present are returned (so PATCH leaves
// untouched columns alone).
function contentToColumns(b: Record<string, unknown>): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  if ("image_url" in b) cols.imageUrl = b.image_url;
  if ("tagline" in b) cols.tagline = b.tagline;
  if ("story" in b) cols.story = b.story;
  if ("pairing" in b) cols.pairing = b.pairing;
  if ("note" in b) cols.note = b.note;
  if ("benefits" in b) cols.benefits = b.benefits;
  if ("best_for" in b) cols.bestFor = b.best_for;
  if ("ingredient_details" in b) cols.ingredientDetails = b.ingredient_details;
  if ("palette" in b) cols.palette = b.palette;
  if ("bottle_asset_id" in b) cols.bottleAssetId = b.bottle_asset_id;
  if ("cluster_asset_id" in b) cols.clusterAssetId = b.cluster_asset_id;
  if ("fruit_asset_id" in b) cols.fruitAssetId = b.fruit_asset_id;
  return cols;
}

const RetireVariant = z.object({ is_active: z.boolean() });

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
  bottle_material_id: string | null;
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
      bottle_material_id: v.bottleMaterialId ?? null,
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
          ...contentToColumns(body),
        })
        .returning();
      if (!row) throw new BusinessError("internal_error", "insert returned no rows", 500);

      const variantsCreated: { id: string; size_ml: number; price_ngn: number }[] = [];
      for (const v of variants) {
        const sku = "sku" in v && v.sku ? v.sku : `${body.slug}-${v.size_ml}ml`;
        const bottleMaterialId = await bottleMaterialIdForSize(tx, v.size_ml);
        const [vRow] = await tx
          .insert(productVariant)
          .values({
            productId: row.id,
            sizeMl: v.size_ml,
            sku,
            bottleMaterialId: bottleMaterialId ?? null,
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
   * Update product attributes + storefront content (palette, media refs,
   * marketing copy). Variants/prices go through /:id/prices.
   */
  r.patch("/:id", requireCapability("products.manage"), async (c) => {
    const id = c.req.param("id");
    const body = UpdateProduct.parse(await c.req.json());

    const [existing] = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    if (!existing) throw new BusinessError("not_found", "product not found", 404);

    const updates: Record<string, unknown> = { ...contentToColumns(body) };
    if (body.name !== undefined) updates.name = body.name;
    if (body.category !== undefined) updates.category = body.category;
    if (body.ingredients !== undefined) updates.ingredients = body.ingredients;
    if (body.shelf_life_hours !== undefined) updates.shelfLifeHours = body.shelf_life_hours;
    if (body.display_order !== undefined) updates.displayOrder = body.display_order;
    if (body.is_active !== undefined) updates.isActive = body.is_active;

    if (Object.keys(updates).length === 0) {
      return c.json({ data: existing });
    }
    updates.updatedAt = new Date();

    const [row] = await db
      .update(product)
      .set(updates)
      .where(eq(product.id, id))
      .returning();

    await writeAudit(db, c, {
      action: "product.update",
      entityType: "product",
      entityId: id,
      before: existing,
      after: row,
    });
    return c.json({ data: row });
  });

  /**
   * Retire a flavour. Soft-delete (sets deleted_at) so historical sale_order
   * rows that reference the product stay intact — the catalog and admin lists
   * both filter on deleted_at IS NULL, so it vanishes from every live view.
   * To bring a seasonal flavour back, PATCH is_active instead of deleting.
   */
  r.delete("/:id", requireCapability("products.manage"), async (c) => {
    const id = c.req.param("id");
    const [existing] = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    if (!existing) throw new BusinessError("not_found", "product not found", 404);

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(product)
        .set({ deletedAt: now, isActive: false, updatedAt: now })
        .where(eq(product.id, id));
      // Retire its variants too, so they can't be sold or re-priced.
      await tx
        .update(productVariant)
        .set({ deletedAt: now, isActive: false })
        .where(and(eq(productVariant.productId, id), isNull(productVariant.deletedAt)));
    });

    await writeAudit(db, c, {
      action: "product.delete",
      entityType: "product",
      entityId: id,
      before: existing,
    });
    return c.json({ data: { ok: true } });
  });

  /**
   * Add a new size (variant) to a flavour that already exists, with its initial
   * price. Mirrors the variant-creation loop in POST /: resolve the bottle
   * material for the size, insert the variant, publish the first price. The
   * (product, size) pair is uniquely constrained (ignoring deleted_at), so a
   * pre-existing size — active or retired — is rejected with a friendly 422
   * rather than a raw 23505.
   */
  r.post("/:id/variants", requireCapability("products.manage"), async (c) => {
    const id = c.req.param("id");
    const body = VariantInput.parse(await c.req.json());
    const auth = c.get("auth");

    const [existing] = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    if (!existing) throw new BusinessError("not_found", "product not found", 404);

    const created = await db.transaction(async (tx) => {
      // The (product, size) pair is uniquely constrained across deleted rows,
      // so a clash can be in one of three states:
      //   • active            → genuine duplicate, reject.
      //   • retired           → visible in the admin list with a Restore button, reject with that hint.
      //   • soft-deleted      → hidden from the admin list AND rejected by the Restore
      //                         endpoint (both filter deleted_at IS NULL). Sending the
      //                         owner to Restore is a dead end, so resurrect it here.
      const [clash] = await tx
        .select({ id: productVariant.id, isActive: productVariant.isActive, deletedAt: productVariant.deletedAt })
        .from(productVariant)
        .where(and(eq(productVariant.productId, id), eq(productVariant.sizeMl, body.size_ml)));
      if (clash && !clash.deletedAt) {
        const hint = clash.isActive ? "" : " — it's retired; use Restore instead";
        throw new BusinessError(
          "validation_failed",
          `${existing.name} already has a ${body.size_ml}ml size${hint}`,
          422,
        );
      }

      if (clash) {
        // Resurrect the soft-deleted size: clear deleted_at, reactivate, and
        // republish the price the owner just entered. Any stale open price row
        // is closed first so the variant keeps exactly one live price.
        const [vRow] = await tx
          .update(productVariant)
          .set({ deletedAt: null, isActive: true, updatedAt: new Date() })
          .where(eq(productVariant.id, clash.id))
          .returning();
        if (!vRow) throw new BusinessError("internal_error", "variant resurrect failed", 500);
        await tx
          .update(productPrice)
          .set({ validTo: new Date() })
          .where(and(eq(productPrice.variantId, clash.id), isNull(productPrice.validTo)));
        await tx.insert(productPrice).values({
          productId: id,
          variantId: clash.id,
          priceNgn: body.price_ngn,
          createdByUserId: auth.userId,
        });
        return { id: vRow.id, size_ml: vRow.sizeMl, price_ngn: body.price_ngn, is_active: vRow.isActive };
      }

      const sku = body.sku ?? `${existing.slug}-${body.size_ml}ml`;
      const bottleMaterialId = await bottleMaterialIdForSize(tx, body.size_ml);
      const [vRow] = await tx
        .insert(productVariant)
        .values({
          productId: id,
          sizeMl: body.size_ml,
          sku,
          bottleMaterialId: bottleMaterialId ?? null,
        })
        .returning();
      if (!vRow) throw new BusinessError("internal_error", "variant insert failed", 500);
      await tx.insert(productPrice).values({
        productId: id,
        variantId: vRow.id,
        priceNgn: body.price_ngn,
        createdByUserId: auth.userId,
      });
      return { id: vRow.id, size_ml: vRow.sizeMl, price_ngn: body.price_ngn, is_active: vRow.isActive };
    });

    await writeAudit(db, c, {
      action: "product_variant.create",
      entityType: "product_variant",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
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

  /**
   * Retire (is_active=false) or restore (is_active=true) a single size of a
   * flavour. The public catalog filters is_active=TRUE, so retiring hides the
   * size from the storefront at once; the POS sync filters only deleted_at, so
   * the till can still ring it up (customer-only scope, by design). Reversible:
   * the size stays in the admin "Cans & prices" list, marked Retired.
   */
  r.patch("/:id/variants/:variantId", requireCapability("products.manage"), async (c) => {
    const id = c.req.param("id");
    const variantId = c.req.param("variantId");
    const body = RetireVariant.parse(await c.req.json());

    const [existingProduct] = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    if (!existingProduct) throw new BusinessError("not_found", "product not found", 404);

    const [variant] = await db
      .select()
      .from(productVariant)
      .where(
        and(
          eq(productVariant.id, variantId),
          eq(productVariant.productId, id),
          isNull(productVariant.deletedAt),
        ),
      );
    if (!variant) {
      throw new BusinessError("validation_failed", "variant does not belong to this product", 422);
    }

    // Lock the product row so two concurrent retires on the same flavour can't
    // both pass the last-active-size guard and empty its storefront presence —
    // the guard read and the update must be a single serialized check-then-act.
    const updated = await db.transaction(async (tx) => {
      await tx.select({ id: product.id }).from(product).where(eq(product.id, id)).for("update");

      // Last-active-size guard: the size tool must never empty a flavour's
      // storefront presence — that's what "Deactivate flavour" is for.
      if (body.is_active === false) {
        const active = await tx
          .select({ id: productVariant.id })
          .from(productVariant)
          .where(
            and(
              eq(productVariant.productId, id),
              eq(productVariant.isActive, true),
              isNull(productVariant.deletedAt),
            ),
          );
        const remaining = active.filter((v) => v.id !== variantId);
        if (remaining.length === 0) {
          throw new BusinessError(
            "validation_failed",
            "This is the only active size; retiring it would remove the whole flavour from the storefront. Use Deactivate flavour instead.",
            422,
          );
        }
      }

      const [row] = await tx
        .update(productVariant)
        .set({ isActive: body.is_active, updatedAt: new Date() })
        .where(eq(productVariant.id, variantId))
        .returning();
      if (!row) throw new BusinessError("internal_error", "variant update failed", 500);
      return row;
    });

    await writeAudit(db, c, {
      action: body.is_active ? "product_variant.restore" : "product_variant.retire",
      entityType: "product_variant",
      entityId: variantId,
      before: { is_active: variant.isActive },
      after: { is_active: body.is_active },
    });

    return c.json({ data: { id: updated.id, size_ml: updated.sizeMl, is_active: updated.isActive } });
  });

  return r;
}
