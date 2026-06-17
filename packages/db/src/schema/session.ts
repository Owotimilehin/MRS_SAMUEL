import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";

export const session = pgTable("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => adminUser.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  deviceId: text("device_id").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // Set when a token is revoked specifically BY ROTATION (not logout/forced
  // revoke). A rotated token stays usable for a short grace window so a lost
  // refresh response or a second tab doesn't get logged out. Null = never
  // rotated, so a logout / forced revoke gets no grace.
  rotatedAt: timestamp("rotated_at", { withTimezone: true })
});
