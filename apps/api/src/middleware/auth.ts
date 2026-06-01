import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyAccessToken, type AccessPayload } from "../auth/jwt.js";
import { BusinessError } from "../lib/errors.js";
import type { Capability } from "@ms/shared";

export interface AuthContext {
  userId: string;
  role: AccessPayload["role"];
  capabilities: Capability[];
  branchId: string | null;
  deviceId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
    requestId: string;
  }
}

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const cookieName = process.env.SESSION_COOKIE_NAME ?? "ms_session";
    const token = getCookie(c, cookieName);
    if (!token) throw new BusinessError("unauthorized", "missing session", 401);
    try {
      const payload = await verifyAccessToken(token);
      c.set("auth", {
        userId: payload.sub,
        role: payload.role,
        capabilities: payload.capabilities ?? [],
        branchId: payload.branch_id,
        deviceId: payload.device_id,
      });
    } catch {
      throw new BusinessError("unauthorized", "invalid session", 401);
    }
    await next();
  };
}

/** Pass only if the caller holds the named capability. Must run after requireAuth(). */
export function requireCapability(cap: Capability): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || !auth.capabilities.includes(cap)) {
      throw new BusinessError("forbidden", `missing capability: ${cap}`, 403);
    }
    await next();
  };
}

/** Pass if the caller holds at least one of the named capabilities. */
export function requireAnyCapability(...caps: Capability[]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || !caps.some((cap) => auth.capabilities.includes(cap))) {
      throw new BusinessError("forbidden", "missing capability", 403);
    }
    await next();
  };
}

/** @deprecated kept for any remaining callers; prefer requireCapability. */
export function requireRole(...roles: AccessPayload["role"][]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || !roles.includes(auth.role)) {
      throw new BusinessError("forbidden", "insufficient role", 403);
    }
    await next();
  };
}
