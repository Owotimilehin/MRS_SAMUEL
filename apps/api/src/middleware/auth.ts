import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyAccessToken, type AccessPayload } from "../auth/jwt.js";
import { BusinessError } from "../lib/errors.js";

export interface AuthContext {
  userId: string;
  role: AccessPayload["role"];
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
        branchId: payload.branch_id,
        deviceId: payload.device_id,
      });
    } catch {
      throw new BusinessError("unauthorized", "invalid session", 401);
    }
    await next();
  };
}

export function requireRole(...roles: AccessPayload["role"][]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || !roles.includes(auth.role)) {
      throw new BusinessError("forbidden", "insufficient role", 403);
    }
    await next();
  };
}
