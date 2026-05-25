import { Hono } from "hono";
import { eq, isNull, and, desc } from "drizzle-orm";
import { z } from "zod";
import { adminUser, type DbClient } from "@ms/db";
import { hashPassword } from "../auth/argon.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

/**
 * Owner-only admin user management. Listing returns soft-state plus last-login
 * timestamps. Invite generates a temp password the caller surfaces once and
 * the new user is expected to change immediately.
 */
const RoleEnum = z.enum(["owner", "factory_dispatcher", "branch_manager", "branch_staff"]);

const InviteUser = z.object({
  email: z.string().email(),
  role: RoleEnum,
  branch_id: z.string().uuid().nullable().optional(),
  password: z.string().min(12),
});

const PatchUser = z.object({
  role: RoleEnum.optional(),
  branch_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
});

const ResetPassword = z.object({ password: z.string().min(12) });

export function adminUserRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireRole("owner"));

  r.get("/", async (c) => {
    const rows = await db
      .select({
        id: adminUser.id,
        email: adminUser.email,
        phone: adminUser.phone,
        role: adminUser.role,
        branchId: adminUser.branchId,
        isActive: adminUser.isActive,
        failedLoginCount: adminUser.failedLoginCount,
        lockedUntil: adminUser.lockedUntil,
        lastLoginAt: adminUser.lastLoginAt,
        createdAt: adminUser.createdAt,
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
        passwordHash,
        role: body.role,
        branchId: body.branch_id ?? null,
      })
      .returning({
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
        branchId: adminUser.branchId,
        isActive: adminUser.isActive,
        createdAt: adminUser.createdAt,
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
    const [before] = await db.select().from(adminUser).where(eq(adminUser.id, id));
    if (!before) throw new BusinessError("not_found", "user not found", 404);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.role !== undefined) patch["role"] = body.role;
    if (body.branch_id !== undefined) patch["branchId"] = body.branch_id;
    if (body.is_active !== undefined) {
      patch["isActive"] = body.is_active;
      if (body.is_active) {
        patch["failedLoginCount"] = 0;
        patch["lockedUntil"] = null;
      }
    }
    const [row] = await db
      .update(adminUser)
      .set(patch)
      .where(and(eq(adminUser.id, id), isNull(adminUser.deletedAt)))
      .returning();
    if (!row) throw new BusinessError("internal_error", "update failed", 500);
    await writeAudit(db, c, {
      action: "admin_user.update",
      entityType: "admin_user",
      entityId: id,
      before,
      after: row,
    });
    return c.json({ data: row });
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

  return r;
}
