import { Hono } from "hono";
import { eq, isNull, and, desc } from "drizzle-orm";
import { z } from "zod";
import { adminUser, type DbClient } from "@ms/db";
import { CAPABILITIES } from "@ms/shared";
import { hashPassword } from "../auth/argon.js";
import { revokeAllUserSessions } from "../auth/session.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

/** Postgres foreign-key violation — raised when a hard delete is blocked by a
 *  referencing row (a sale/payment/stock entry the user recorded). */
function isForeignKeyViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23503";
}

/**
 * Owner-only admin user management. Listing returns soft-state plus last-login
 * timestamps. Invite generates a temp password the caller surfaces once and
 * the new user is expected to change immediately.
 */
const RoleEnum = z.enum(["owner", "admin", "manager", "branch_staff"]);

const CapabilityEnum = z.enum(CAPABILITIES);
const Overrides = z
  .object({ granted: z.array(CapabilityEnum).default([]), revoked: z.array(CapabilityEnum).default([]) })
  .default({ granted: [], revoked: [] });

const InviteUser = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120).optional(),
  role: RoleEnum,
  branch_id: z.string().uuid().nullable().optional(),
  password: z.string().min(12),
  permission_overrides: Overrides.optional(),
});

const PatchUser = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  role: RoleEnum.optional(),
  branch_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  permission_overrides: Overrides.optional(),
});

const ResetPassword = z.object({ password: z.string().min(12) });

export function adminUserRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("users.manage"));

  // Count owners who can still actually sign in. Guards every path that could
  // strip the business of its last owner (delete, demote, disable) so it can
  // never lock itself out of user management.
  async function activeOwnerCount(): Promise<number> {
    const rows = await db
      .select({ id: adminUser.id })
      .from(adminUser)
      .where(and(eq(adminUser.role, "owner"), eq(adminUser.isActive, true), isNull(adminUser.deletedAt)));
    return rows.length;
  }

  r.get("/", async (c) => {
    const rows = await db
      .select({
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        phone: adminUser.phone,
        role: adminUser.role,
        branchId: adminUser.branchId,
        isActive: adminUser.isActive,
        failedLoginCount: adminUser.failedLoginCount,
        lockedUntil: adminUser.lockedUntil,
        lastLoginAt: adminUser.lastLoginAt,
        createdAt: adminUser.createdAt,
        permissionOverrides: adminUser.permissionOverrides,
      })
      .from(adminUser)
      .where(isNull(adminUser.deletedAt))
      .orderBy(desc(adminUser.createdAt));
    return c.json({ data: rows });
  });

  r.post("/", async (c) => {
    const body = InviteUser.parse(await c.req.json());
    const existing = await db
      .select({ id: adminUser.id })
      .from(adminUser)
      .where(eq(adminUser.email, body.email))
      .limit(1);
    if (existing.length > 0) {
      throw new BusinessError("conflict", "email already in use", 409);
    }
    const passwordHash = await hashPassword(body.password);
    const [row] = await db
      .insert(adminUser)
      .values({
        email: body.email,
        name: body.name ?? null,
        passwordHash,
        role: body.role,
        branchId: body.branch_id ?? null,
        permissionOverrides: body.permission_overrides ?? { granted: [], revoked: [] },
      })
      .returning({
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
        branchId: adminUser.branchId,
        isActive: adminUser.isActive,
        createdAt: adminUser.createdAt,
        permissionOverrides: adminUser.permissionOverrides,
      });
    if (!row) throw new BusinessError("internal_error", "insert failed", 500);
    await writeAudit(db, c, {
      action: "admin_user.invite",
      entityType: "admin_user",
      entityId: row.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = PatchUser.parse(await c.req.json());
    const [before] = await db
      .select()
      .from(adminUser)
      .where(and(eq(adminUser.id, id), isNull(adminUser.deletedAt)));
    if (!before) throw new BusinessError("not_found", "user not found", 404);

    // Never let the last active owner be demoted or disabled.
    const demotingLastOwner =
      before.role === "owner" && body.role !== undefined && body.role !== "owner";
    const disablingLastOwner =
      before.role === "owner" && body.is_active === false;
    if ((demotingLastOwner || disablingLastOwner) && (await activeOwnerCount()) <= 1) {
      throw new BusinessError("conflict", "can't remove the last active owner", 409);
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.role !== undefined) patch["role"] = body.role;
    if (body.branch_id !== undefined) patch["branchId"] = body.branch_id;
    if (body.is_active !== undefined) {
      patch["isActive"] = body.is_active;
      if (body.is_active) {
        patch["failedLoginCount"] = 0;
        patch["lockedUntil"] = null;
      }
    }
    if (body.permission_overrides !== undefined) {
      patch["permissionOverrides"] = body.permission_overrides;
    }
    const [row] = await db
      .update(adminUser)
      .set(patch)
      .where(and(eq(adminUser.id, id), isNull(adminUser.deletedAt)))
      .returning();
    if (!row) throw new BusinessError("internal_error", "update failed", 500);

    // A role/permission change only lives in the user's 15-minute access token.
    // Revoke their sessions so the new capabilities take effect on next sign-in
    // instead of silently lagging (the "granted access but it didn't work" bug).
    // Disabling a user likewise kicks them out immediately.
    let sessionsRevoked = 0;
    if (
      body.role !== undefined ||
      body.permission_overrides !== undefined ||
      body.is_active === false
    ) {
      sessionsRevoked = await revokeAllUserSessions(db, id);
    }

    await writeAudit(db, c, {
      action: "admin_user.update",
      entityType: "admin_user",
      entityId: id,
      before,
      after: row,
    });
    return c.json({ data: row, meta: { sessionsRevoked } });
  });

  r.patch("/:id/reset-password", async (c) => {
    const id = c.req.param("id");
    const body = ResetPassword.parse(await c.req.json());
    const [before] = await db.select().from(adminUser).where(eq(adminUser.id, id));
    if (!before) throw new BusinessError("not_found", "user not found", 404);
    const passwordHash = await hashPassword(body.password);
    await db
      .update(adminUser)
      .set({
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(adminUser.id, id));
    await writeAudit(db, c, {
      action: "admin_user.reset_password",
      entityType: "admin_user",
      entityId: id,
    });
    return c.json({ data: { ok: true } });
  });

  // Delete a user. We try a true row delete first; Postgres blocks it (FK
  // restrict) when the user has recorded any sale / payment / stock move /
  // close / production run / expense, in which case we soft-delete instead so
  // the financial and audit history stays intact. Either way the account is
  // gone from the list and can no longer sign in. Response `mode` tells the UI
  // which happened.
  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const actor = c.get("auth");
    if (actor.userId === id) {
      throw new BusinessError("conflict", "you can't delete your own account", 409);
    }
    const [before] = await db
      .select()
      .from(adminUser)
      .where(and(eq(adminUser.id, id), isNull(adminUser.deletedAt)));
    if (!before) throw new BusinessError("not_found", "user not found", 404);
    if (before.role === "owner" && (await activeOwnerCount()) <= 1) {
      throw new BusinessError("conflict", "can't delete the last active owner", 409);
    }

    let mode: "hard" | "soft";
    try {
      // Sessions cascade-delete with the row; blog/branch references null out.
      const deleted = await db
        .delete(adminUser)
        .where(eq(adminUser.id, id))
        .returning({ id: adminUser.id });
      if (deleted.length === 0) throw new BusinessError("not_found", "user not found", 404);
      mode = "hard";
    } catch (e) {
      if (e instanceof BusinessError) throw e;
      if (!isForeignKeyViolation(e)) throw e;
      // Has history → soft delete. Kill sessions, deactivate, hide, and release
      // the email (suffix it) so the same address can be invited again later.
      await revokeAllUserSessions(db, id);
      await db
        .update(adminUser)
        .set({
          deletedAt: new Date(),
          isActive: false,
          email: `${before.email}.deleted-${Date.now()}`,
          updatedAt: new Date(),
        })
        .where(eq(adminUser.id, id));
      mode = "soft";
    }

    await writeAudit(db, c, {
      action: mode === "hard" ? "admin_user.delete" : "admin_user.soft_delete",
      entityType: "admin_user",
      entityId: id,
      before,
    });
    return c.json({ data: { id, mode } });
  });

  return r;
}
