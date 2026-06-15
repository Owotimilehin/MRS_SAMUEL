import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { productVariant, type DbClient } from "@ms/db";
import { balanceByVariantAt } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";

export function stockRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  // Resolve each variantId to its can size so callers can show a per-size
  // breakdown without a second round-trip. NULL-variant (legacy no-size) rows
  // get size_ml: null.
  async function withSize(
    rows: Array<{ productId: string; variantId: string | null; balance: number }>,
  ): Promise<Array<{ product_id: string; variant_id: string | null; size_ml: number | null; balance: number }>> {
    const variantIds = [...new Set(rows.map((x) => x.variantId).filter((v): v is string => v != null))];
    const sizeById = new Map<string, number>();
    if (variantIds.length > 0) {
      const vs = await db
        .select({ id: productVariant.id, sizeMl: productVariant.sizeMl })
        .from(productVariant)
        .where(inArray(productVariant.id, variantIds));
      for (const v of vs) sizeById.set(v.id, v.sizeMl);
    }
    return rows.map((x) => ({
      product_id: x.productId,
      variant_id: x.variantId,
      size_ml: x.variantId ? (sizeById.get(x.variantId) ?? null) : null,
      balance: x.balance,
    }));
  }

  r.get("/factory/:factoryId", requireCapability("stock.read"), async (c) => {
    const rows = await balanceByVariantAt(db, {
      locationType: "factory",
      locationId: c.req.param("factoryId"),
    });
    return c.json({ data: await withSize(rows) });
  });

  r.get("/branch/:branchId", async (c) => {
    const rows = await balanceByVariantAt(db, {
      locationType: "branch",
      locationId: c.req.param("branchId"),
    });
    return c.json({ data: await withSize(rows) });
  });

  return r;
}
