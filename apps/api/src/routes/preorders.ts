import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { listOpenPreorders, fulfilPreorderTx } from "./preorder-shared.js";

export function preorderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", requireCapability("orders.manage"), async (c) => {
    const branchId = c.req.query("branch_id");
    const data = await listOpenPreorders(db, branchId ? { branchId } : {});
    return c.json({ data });
  });

  r.patch("/:id/fulfil", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const data = await fulfilPreorderTx(db, c, { id });
    return c.json({ data });
  });

  return r;
}
