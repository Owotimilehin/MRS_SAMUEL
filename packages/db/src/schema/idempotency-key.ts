import { pgTable, uuid, text, integer, timestamp, jsonb, primaryKey } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";

export const idempotencyKey = pgTable("idempotency_key", {
  key: uuid("key").notNull(),
  userId: uuid("user_id").references(() => adminUser.id),
  endpoint: text("endpoint").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  status: text("status").notNull().default("in_progress"), // in_progress | done
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
}, (t) => ({ pk: primaryKey({ columns: [t.key] }) }));
