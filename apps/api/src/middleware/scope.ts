import type { MiddlewareHandler } from "hono";
import { BusinessError } from "../lib/errors.js";

/**
 * Allow the request to proceed if the caller's role can act on the branch
 * referenced by the URL parameter `branchId`. Owners can act on any branch;
 * branch_manager and branch_staff can act only on the branch attached to
 * their session.
 *
 * Must run AFTER requireAuth().
 */
export function requireBranchScope(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new BusinessError("unauthorized", "auth required", 401);

    const pathBranchId = c.req.param("branchId");

    if (auth.role === "owner") return next();

    if (auth.role === "branch_manager" || auth.role === "branch_staff") {
      if (!auth.branchId) throw new BusinessError("forbidden", "user has no branch", 403);
      if (pathBranchId && pathBranchId !== auth.branchId) {
        throw new BusinessError("forbidden", "branch scope mismatch", 403);
      }
      return next();
    }

    throw new BusinessError("forbidden", "branch scope not granted", 403);
  };
}

/**
 * Allow the request to proceed if the caller can act on the factory.
 * Owners and factory_dispatcher pass. Everyone else is rejected.
 *
 * Must run AFTER requireAuth().
 */
export function requireFactoryRole(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new BusinessError("unauthorized", "auth required", 401);
    if (auth.role !== "owner" && auth.role !== "factory_dispatcher") {
      throw new BusinessError("forbidden", "factory role required", 403);
    }
    return next();
  };
}
