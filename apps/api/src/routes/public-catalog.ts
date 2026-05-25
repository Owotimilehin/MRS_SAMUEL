import { Hono } from "hono";
import { sql, eq, and, isNull } from "drizzle-orm";
import { branch, type DbClient } from "@ms/db";

type CatalogVariantRow = {
  product_id: string;
  variant_id: string;
  size_ml: number;
  sku: string;
  price_ngn: number | null;
  [key: string]: unknown;
};

interface CatalogProductOut {
  id: string;
  name: string;
  slug: string;
  category: string;
  ingredients: string[];
  image_url: string | null;
  price_ngn: number;
  variants: Array<{ id: string; size_ml: number; sku: string; price_ngn: number }>;
}

/**
 * Public, unauthenticated catalog endpoints used by the customer-facing
 * marketing site. Returns only what the public should see — no internal
 * costs, no draft/retired products.
 */
export function publicCatalogRoutes(db: DbClient) {
  const r = new Hono();

  r.get("/products", async (c) => {
    // Pull every active variant + its current price in one query, then group
    // by product on the way out. The legacy `price_ngn` field on the product
    // row stays — it's the smallest-variant price (the headline "from" price).
    const productRows = await db.execute<{
      id: string;
      name: string;
      slug: string;
      category: string;
      ingredients: string[];
      image_url: string | null;
    }>(sql`
      SELECT p.id, p.name, p.slug, p.category, p.ingredients, p.image_url
      FROM product p
      WHERE p.deleted_at IS NULL AND p.is_active = TRUE
      ORDER BY p.display_order ASC
    `);

    const variantRows = await db.execute<CatalogVariantRow>(sql`
      SELECT pv.product_id,
             pv.id   AS variant_id,
             pv.size_ml,
             pv.sku,
             pp.price_ngn
      FROM product_variant pv
      LEFT JOIN product_price pp
        ON pp.variant_id = pv.id AND pp.valid_to IS NULL
      WHERE pv.deleted_at IS NULL AND pv.is_active = TRUE
      ORDER BY pv.product_id, pv.size_ml ASC
    `);

    const byProduct = new Map<string, Array<CatalogProductOut["variants"][number]>>();
    for (const v of variantRows) {
      if (v.price_ngn == null) continue; // unpriced variants are hidden from the public site
      const list = byProduct.get(v.product_id) ?? [];
      list.push({ id: v.variant_id, size_ml: v.size_ml, sku: v.sku, price_ngn: v.price_ngn });
      byProduct.set(v.product_id, list);
    }

    const out: CatalogProductOut[] = [];
    for (const p of productRows) {
      const variants = byProduct.get(p.id) ?? [];
      if (variants.length === 0) continue; // a product with no priced variants is not sellable
      out.push({
        id: p.id,
        name: p.name,
        slug: p.slug,
        category: p.category,
        ingredients: p.ingredients,
        image_url: p.image_url,
        price_ngn: variants[0]!.price_ngn, // smallest size (ORDER BY size_ml ASC)
        variants,
      });
    }
    return c.json({ data: out });
  });

  r.get("/branches", async (c) => {
    const rows = await db
      .select({
        id: branch.id,
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        delivery_zones: branch.deliveryZones,
        opens_at: branch.opensAt,
        closes_at: branch.closesAt,
      })
      .from(branch)
      .where(and(eq(branch.isActive, true), isNull(branch.deletedAt)));
    return c.json({ data: rows });
  });

  r.get("/zones", async (c) => {
    const rows = await db
      .select({
        id: branch.id,
        name: branch.name,
        zones: branch.deliveryZones,
      })
      .from(branch)
      .where(and(eq(branch.isActive, true), isNull(branch.deletedAt)));
    const zones = rows.flatMap((b) =>
      b.zones.map((z) => ({
        branch_id: b.id,
        branch_name: b.name,
        name: z.name,
        fee_ngn: z.fee_ngn,
      })),
    );
    return c.json({ data: zones });
  });

  return r;
}
