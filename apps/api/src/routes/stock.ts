import { Hono } from "hono";
import type { DbClient } from "@ms/db";
import { balanceByVariantAt } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";

export function stockRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/factory/:factoryId", requireCapability("stock.read"), async (c) => {
    const rows = await balanceByVariantAt(db, {
      locationType: "factory",
      locationId: c.req.param("factoryId"),
    });
    return c.json({
      data: rows.map((x) => ({
        product_id: x.productId,
        variant_id: x.variantId,
        balance: x.balance,
      })),
    });
  });

  r.get("/branch/:branchId", async (c) => {
    const rows = await balanceByVariantAt(db, {
      locationType: "branch",
      locationId: c.req.param("branchId"),
    });
    return c.json({
      data: rows.map((x) => ({
        product_id: x.productId,
        variant_id: x.variantId,
        balance: x.balance,
      })),
    });
  });

  return r;
}
