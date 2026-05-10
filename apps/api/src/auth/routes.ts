import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { AuthSchemas } from "@ms/shared";
import { adminUser } from "@ms/db";
import type { DbClient } from "@ms/db";
import { verifyPassword } from "./argon.js";
import { issueAccessToken } from "./jwt.js";
import {
  createSession,
  rotateSession,
  revokeSession,
  REFRESH_TTL_DAYS,
} from "./session.js";
import { BusinessError } from "../lib/errors.js";
import { writeAudit } from "../middleware/audit.js";

const REFRESH_COOKIE = "ms_refresh";

function accessCookieOpts() {
  return {
    httpOnly: true,
    secure: (process.env.NODE_ENV ?? "development") === "production",
    sameSite: "Strict" as const,
    path: "/",
    maxAge: 60 * 15,
  };
}

function refreshCookieOpts() {
  return {
    httpOnly: true,
    secure: (process.env.NODE_ENV ?? "development") === "production",
    sameSite: "Strict" as const,
    path: "/v1/auth",
    maxAge: 60 * 60 * 24 * REFRESH_TTL_DAYS,
  };
}

export function authRoutes(db: DbClient) {
  const r = new Hono();
  const ACCESS_COOKIE = process.env.SESSION_COOKIE_NAME ?? "ms_session";

  r.post("/login", async (c) => {
    const body = AuthSchemas.LoginRequest.parse(await c.req.json());
    const rows = await db
      .select()
      .from(adminUser)
      .where(eq(adminUser.email, body.email))
      .limit(1);
    const user = rows[0];
    if (!user || !user.isActive) {
      throw new BusinessError("invalid_credentials", "invalid email or password", 401);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new BusinessError("account_locked", "account temporarily locked", 401);
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      const newCount = user.failedLoginCount + 1;
      const lockUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
      await db
        .update(adminUser)
        .set({ failedLoginCount: newCount, lockedUntil: lockUntil })
        .where(eq(adminUser.id, user.id));
      throw new BusinessError("invalid_credentials", "invalid email or password", 401);
    }
    await db
      .update(adminUser)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(adminUser.id, user.id));

    const deviceId = c.req.header("x-device-id") ?? uuid();
    const sess = await createSession(db, {
      userId: user.id,
      deviceId,
      userAgent: c.req.header("user-agent") ?? null,
      ipAddress: c.req.header("x-forwarded-for") ?? null,
    });
    const access = await issueAccessToken({
      sub: user.id,
      role: user.role,
      branch_id: user.branchId,
      device_id: deviceId,
    });
    setCookie(c, ACCESS_COOKIE, access, accessCookieOpts());
    setCookie(c, REFRESH_COOKIE, sess.refreshToken, refreshCookieOpts());
    await writeAudit(db, c, {
      action: "auth.login_success",
      entityType: "admin_user",
      entityId: user.id,
      after: { id: user.id, email: user.email, role: user.role },
    });
    return c.json(
      {
        data: {
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            branch_id: user.branchId,
          },
        },
      },
      200,
    );
  });

  r.post("/refresh", async (c) => {
    const refresh = getCookie(c, REFRESH_COOKIE);
    if (!refresh) throw new BusinessError("unauthorized", "no refresh", 401);
    const result = await rotateSession(db, refresh);
    if (!result) throw new BusinessError("unauthorized", "invalid refresh", 401);
    const access = await issueAccessToken({
      sub: result.user.id,
      role: result.user.role,
      branch_id: result.user.branchId,
      device_id: c.req.header("x-device-id") ?? uuid(),
    });
    setCookie(c, ACCESS_COOKIE, access, accessCookieOpts());
    setCookie(c, REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
    return c.json({ data: { ok: true } });
  });

  r.post("/logout", async (c) => {
    const refresh = getCookie(c, REFRESH_COOKIE);
    if (refresh) await revokeSession(db, refresh);
    deleteCookie(c, ACCESS_COOKIE, { path: "/" });
    deleteCookie(c, REFRESH_COOKIE, { path: "/v1/auth" });
    return c.body(null, 204);
  });

  return r;
}
