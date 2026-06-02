import { Hono } from "hono";
import type { DbClient } from "@ms/db";
import { balanceAt } from "@ms/domain";
import { requireAuth } from "../middleware/auth.js";

/**
 * Read-only stock balance endpoints. Returns a map of product_id -> qty.
 * Owner can hit any location; future scope work will restrict branch users
 * to their own branch.
 */
export function stockRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  // TODO(capability): gate with requireCapability("stock.adjust") when a stock-adjust mutation endpoint exists

  r.get("/factory/:factoryId", async (c) => {
    const balances = await balanceAt(db, {
      locationType: "factory",
      locationId: c.req.param("factoryId"),
    });
    return c.json({ data: balances });
  });

  r.get("/branch/:branchId", async (c) => {
    const balances = await balanceAt(db, {
      locationType: "branch",
      locationId: c.req.param("branchId"),
    });
    return c.json({ data: balances });
  });

  return r;
}
