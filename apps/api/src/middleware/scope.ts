import type { MiddlewareHandler } from "hono";
import { BusinessError } from "../lib/errors.js";

/**
 * Branch scope. Owners, admins and managers act on any branch. Branch staff
 * (anyone carrying a branch_id) can act only on their own branch.
 * Must run AFTER requireAuth(). This is orthogonal to capabilities, which
 * decide WHAT an action is; this decides WHICH branch it may touch.
 */
export function requireBranchScope(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new BusinessError("unauthorized", "auth required", 401);

    if (auth.role === "owner" || auth.role === "admin" || auth.role === "manager") {
      return next();
    }

    if (!auth.branchId) throw new BusinessError("forbidden", "user has no branch", 403);
    const pathBranchId = c.req.param("branchId");
    if (pathBranchId && pathBranchId !== auth.branchId) {
      throw new BusinessError("forbidden", "branch scope mismatch", 403);
    }
    return next();
  };
}
