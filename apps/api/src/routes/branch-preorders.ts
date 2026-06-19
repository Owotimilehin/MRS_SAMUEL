import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { requireAuth, requireAnyCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { BusinessError } from "../lib/errors.js";
import { listOpenPreorders, fulfilPreorderTx } from "./preorder-shared.js";

/**
 * Till-facing preorder queue, mounted at /v1/branches/:branchId/preorders.
 * Gated on pos.sell (so a branch_staff till operator qualifies) and locked to
 * the path branch — a till can only see and fulfil ITS OWN branch's preorders.
 */
export function branchPreorderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  r.get("/", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const data = await listOpenPreorders(db, { branchId });
    return c.json({ data });
  });

  r.patch("/:id/fulfil", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
    const branchId = c.req.param("branchId");
    const id = c.req.param("id");
    if (!branchId || !id) throw new BusinessError("validation_failed", "branchId and id required", 400);
    const data = await fulfilPreorderTx(db, c, { id, branchId });
    return c.json({ data });
  });

  return r;
}
