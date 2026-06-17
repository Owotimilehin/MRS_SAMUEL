import { pgTable, uuid, text, timestamp, boolean, pgEnum, integer, jsonb } from "drizzle-orm/pg-core";

export const adminRole = pgEnum("admin_role", ["owner", "admin", "manager", "branch_staff"]);

export const adminUser = pgTable("admin_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  role: adminRole("role").notNull(),
  branchId: uuid("branch_id"),
  permissionOverrides: jsonb("permission_overrides")
    .notNull()
    .default({ granted: [], revoked: [] })
    .$type<{ granted: string[]; revoked: string[] }>(),
  isActive: boolean("is_active").notNull().default(true),
  mfaSecret: text("mfa_secret"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
