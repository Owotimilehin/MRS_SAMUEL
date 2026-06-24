import { Hono } from "hono";
import { sql, eq, and, asc, isNull } from "drizzle-orm";
import { branch, bundle, subscriptionPlan, type DbClient } from "@ms/db";
import { availableAtBranch } from "@ms/domain";
import { BusinessError } from "../lib/errors.js";

type CatalogVariantRow = {
  product_id: string;
  variant_id: string;
  size_ml: number;
  sku: string;
  price_ngn: number | null;
  preorder_only: boolean;
  [key: string]: unknown;
};

type Palette = { surface: string; accent: string; text: string };
type IngredientDetail = { name: string; benefit: string };

type ProductContentRow = {
  id: string;
  name: string;
  slug: string;
  category: string;
  ingredients: string[];
  image_url: string | null;
  tagline: string | null;
  story: string | null;
  pairing: string | null;
  note: string | null;
  benefits: string[];
  best_for: string[];
  ingredient_details: IngredientDetail[];
  palette: Palette | null;
  bottle_url: string | null;
  cluster_url: string | null;
  fruit_url: string | null;
};

interface CatalogProductOut {
  id: string;
  name: string;
  slug: string;
  category: string;
  ingredients: string[];
  image_url: string | null;
  tagline: string | null;
  story: string | null;
  pairing: string | null;
  note: string | null;
  benefits: string[];
  best_for: string[];
  ingredient_details: IngredientDetail[];
  palette: Palette | null;
  bottle_url: string | null;
  cluster_url: string | null;
  fruit_url: string | null;
  price_ngn: number;
  /** Per-flavour available pool at the online-default branch. 0 when no
   *  online-default branch exists or when there is no stock. */
  available: number;
  variants: Array<{ id: string; size_ml: number; sku: string; price_ngn: number; preorder_only: boolean }>;
}

// Shared product SELECT: marketing content + colour palette + resolved media
// URLs (bottle / cluster / fruit) via the media_asset library. Used by both the
// list and the per-slug detail endpoint so they always agree on shape.
const PRODUCT_COLUMNS = sql`
  p.id, p.name, p.slug, p.category, p.ingredients, p.image_url,
  p.tagline, p.story, p.pairing, p.note,
  p.benefits, p.best_for, p.ingredient_details, p.palette,
  bot.url AS bottle_url,
  clu.url AS cluster_url,
  fru.url AS fruit_url
`;

const PRODUCT_JOINS = sql`
  FROM product p
  LEFT JOIN media_asset bot ON bot.id = p.bottle_asset_id
  LEFT JOIN media_asset clu ON clu.id = p.cluster_asset_id
  LEFT JOIN media_asset fru ON fru.id = p.fruit_asset_id
`;

/**
 * Public, unauthenticated catalog endpoints used by the customer-facing
 * marketing site. Returns only what the public should see — no internal
 * costs, no draft/retired products.
 */
export function publicCatalogRoutes(db: DbClient) {
  const r = new Hono();

  // Pull every active variant + its current price for the given product ids,
  // grouped by product. Unpriced variants are dropped (not sellable).
  async function variantsByProduct(productIds: string[]) {
    const byProduct = new Map<string, Array<CatalogProductOut["variants"][number]>>();
    if (productIds.length === 0) return byProduct;
    const variantRows = await db.execute<CatalogVariantRow>(sql`
      SELECT pv.product_id,
             pv.id   AS variant_id,
             pv.size_ml,
             pv.sku,
             pv.preorder_only,
             pp.price_ngn
      FROM product_variant pv
      LEFT JOIN product_price pp
        ON pp.variant_id = pv.id AND pp.valid_to IS NULL
      WHERE pv.deleted_at IS NULL AND pv.is_active = TRUE
        AND pv.product_id IN ${sql`(${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})`}
      ORDER BY pv.product_id, pv.size_ml ASC
    `);
    for (const v of variantRows) {
      if (v.price_ngn == null) continue; // unpriced variants are hidden from the public site
      const list = byProduct.get(v.product_id) ?? [];
      list.push({ id: v.variant_id, size_ml: v.size_ml, sku: v.sku, price_ngn: v.price_ngn, preorder_only: v.preorder_only });
      byProduct.set(v.product_id, list);
    }
    return byProduct;
  }

  function toOut(p: ProductContentRow, variants: CatalogProductOut["variants"], available = 0): CatalogProductOut {
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      category: p.category,
      ingredients: p.ingredients,
      image_url: p.image_url,
      tagline: p.tagline,
      story: p.story,
      pairing: p.pairing,
      note: p.note,
      benefits: p.benefits ?? [],
      best_for: p.best_for ?? [],
      ingredient_details: p.ingredient_details ?? [],
      palette: p.palette,
      bottle_url: p.bottle_url,
      cluster_url: p.cluster_url,
      fruit_url: p.fruit_url,
      price_ngn: variants[0]!.price_ngn, // smallest size (ORDER BY size_ml ASC)
      available,
      variants,
    };
  }

  /** Resolve the single online-default branch id once per request. Returns null when none is set. */
  async function onlineDefaultBranchId(): Promise<string | null> {
    const [row] = await db
      .select({ id: branch.id })
      .from(branch)
      .where(eq(branch.isOnlineDefault, true))
      .limit(1);
    return row?.id ?? null;
  }

  r.get("/products", async (c) => {
    const productRows = await db.execute<ProductContentRow>(sql`
      SELECT ${PRODUCT_COLUMNS}
      ${PRODUCT_JOINS}
      WHERE p.deleted_at IS NULL AND p.is_active = TRUE
      ORDER BY p.display_order ASC
    `);

    const byProduct = await variantsByProduct(productRows.map((p) => p.id));

    // Resolve the online-default branch once for the whole list.
    const branchId = await onlineDefaultBranchId();

    const out: CatalogProductOut[] = [];
    for (const p of productRows) {
      const variants = byProduct.get(p.id) ?? [];
      if (variants.length === 0) continue; // a product with no priced variants is not sellable
      const available = branchId
        ? await availableAtBranch(db, { branchId, productId: p.id })
        : 0;
      out.push(toOut(p, variants, available));
    }
    return c.json({ data: out });
  });

  r.get("/products/:slug", async (c) => {
    const slug = c.req.param("slug");
    const rows = await db.execute<ProductContentRow>(sql`
      SELECT ${PRODUCT_COLUMNS}
      ${PRODUCT_JOINS}
      WHERE p.slug = ${slug} AND p.deleted_at IS NULL AND p.is_active = TRUE
      LIMIT 1
    `);
    const p = rows[0];
    if (!p) throw new BusinessError("not_found", "product not found", 404);
    const byProduct = await variantsByProduct([p.id]);
    const variants = byProduct.get(p.id) ?? [];
    if (variants.length === 0) {
      throw new BusinessError("not_found", "product not available", 404);
    }
    const branchId = await onlineDefaultBranchId();
    const available = branchId
      ? await availableAtBranch(db, { branchId, productId: p.id })
      : 0;
    return c.json({ data: toOut(p, variants, available) });
  });

  r.get("/branches", async (c) => {
    const rows = await db
      .select({
        id: branch.id,
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        delivery_zones: branch.deliveryZones,
        is_online_default: branch.isOnlineDefault,
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

  // Product bundles / gift boxes shown on the shop page (read-only; the order
  // CTA is WhatsApp — bundles are not part of the stock/order pipeline yet).
  r.get("/bundles", async (c) => {
    const rows = await db
      .select()
      .from(bundle)
      .where(eq(bundle.isActive, true))
      .orderBy(asc(bundle.displayOrder));
    return c.json({
      data: rows.map((b) => ({
        id: b.id,
        slug: b.slug,
        name: b.name,
        price_ngn: b.priceNgn,
        description: b.description,
        contents_label: b.contentsLabel,
        badge: b.badge,
        image_url: b.imageUrl,
      })),
    });
  });

  // Subscription plans shown on the subscription page (read-only; CTA is WhatsApp
  // plus a lead POST to /v1/public/subscriptions).
  r.get("/subscription-plans", async (c) => {
    const rows = await db
      .select()
      .from(subscriptionPlan)
      .where(eq(subscriptionPlan.isActive, true))
      .orderBy(asc(subscriptionPlan.displayOrder));
    return c.json({
      data: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        price_ngn: p.priceNgn,
        period: p.period,
        bottles_label: p.bottlesLabel,
        description: p.description,
        perks: p.perks,
        popular: p.popular,
      })),
    });
  });

  return r;
}
