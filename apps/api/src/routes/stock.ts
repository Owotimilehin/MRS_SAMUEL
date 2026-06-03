import { Hono } from "hono";
import type { DbClient } from "@ms/db";
import { balanceAt } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";

export function stockRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/factory/:factoryId", requireCapability("stock.read"), async (c) => {
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
