import { Hono } from "hono";
import { sql, eq, and, isNull } from "drizzle-orm";
import { branch, type DbClient } from "@ms/db";

/**
 * Public, unauthenticated catalog endpoints used by the customer-facing
 * marketing site. Returns only what the public should see — no internal
 * costs, no draft/retired products.
 */
export function publicCatalogRoutes(db: DbClient) {
  const r = new Hono();

  r.get("/products", async (c) => {
    const rows = await db.execute<{
      id: string;
      name: string;
      slug: string;
      category: string;
      ingredients: string[];
      image_url: string | null;
      price_ngn: number;
    }>(sql`
      SELECT p.id, p.name, p.slug, p.category, p.ingredients, p.image_url,
             (SELECT pp.price_ngn FROM product_price pp
              WHERE pp.product_id = p.id AND pp.valid_to IS NULL
              ORDER BY pp.valid_from DESC LIMIT 1) AS price_ngn
      FROM product p
      WHERE p.deleted_at IS NULL AND p.is_active = TRUE
      ORDER BY p.display_order ASC
    `);
    return c.json({ data: Array.from(rows) });
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
