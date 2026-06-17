import { eq, and, isNull, gte, gt, or } from "drizzle-orm";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import type { DbClient } from "@ms/db";
import { session, adminUser } from "@ms/db";

export const REFRESH_TTL_DAYS = 30;
const REFRESH_BYTES = 48;

/**
 * Grace window after a rotation during which the OLD refresh token still works.
 * Tolerates a lost refresh response, a backgrounded PWA, or a second tab racing
 * the refresh — any of which would otherwise orphan the client and force a
 * re-login. Only rotation-revoked tokens get this grace; logout / forced revoke
 * (which leave `rotatedAt` null) are immediate.
 */
const ROTATION_GRACE_MS = 60_000;

export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(REFRESH_BYTES).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

export async function createSession(
  db: DbClient,
  opts: {
    userId: string;
    deviceId: string;
    userAgent: string | null;
    ipAddress: string | null;
  },
): Promise<{ refreshToken: string; sessionId: string; expiresAt: Date }> {
  const { token, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
  const id = uuid();
  await db.insert(session).values({
    id,
    userId: opts.userId,
    refreshTokenHash: hash,
    deviceId: opts.deviceId,
    userAgent: opts.userAgent,
    ipAddress: opts.ipAddress,
    expiresAt,
  });
  return { refreshToken: token, sessionId: id, expiresAt };
}

export async function rotateSession(
  db: DbClient,
  oldRefreshToken: string,
): Promise<
  | {
      user: typeof adminUser.$inferSelect;
      refreshToken: string;
      sessionId: string;
      expiresAt: Date;
    }
  | null
> {
  const oldHash = crypto.createHash("sha256").update(oldRefreshToken).digest("hex");
  const graceThreshold = new Date(Date.now() - ROTATION_GRACE_MS);
  const rows = await db
    .select()
    .from(session)
    .where(
      and(
        eq(session.refreshTokenHash, oldHash),
        gte(session.expiresAt, new Date()),
        // Accept a live token OR one that was rotated within the grace window.
        // Logout/forced-revoke rows have `rotatedAt` null, so they never match
        // the grace branch — they stay immediately dead.
        or(isNull(session.revokedAt), gt(session.rotatedAt, graceThreshold)),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const userRows = await db.select().from(adminUser).where(eq(adminUser.id, row.userId)).limit(1);
  const user = userRows[0];
  if (!user || !user.isActive) return null;

  const now = new Date();
  await db.update(session).set({ revokedAt: now, rotatedAt: now }).where(eq(session.id, row.id));
  const created = await createSession(db, {
    userId: user.id,
    deviceId: row.deviceId,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
  });
  return { user, ...created };
}

export async function revokeSession(db: DbClient, refreshToken: string): Promise<void> {
  const hash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await db
    .update(session)
    .set({ revokedAt: new Date() })
    .where(eq(session.refreshTokenHash, hash));
}

/**
 * Revoke every live session for a user, forcing their next request to fail the
 * refresh and bounce to login. Used when an owner changes a user's role or
 * permissions (so the new capabilities take effect on re-login rather than
 * lingering in the old 15-minute access token) and when a user is deactivated
 * or soft-deleted. Returns the number of sessions revoked.
 */
export async function revokeAllUserSessions(db: DbClient, userId: string): Promise<number> {
  const revoked = await db
    .update(session)
    .set({ revokedAt: new Date() })
    .where(and(eq(session.userId, userId), isNull(session.revokedAt)))
    .returning({ id: session.id });
  return revoked.length;
}
