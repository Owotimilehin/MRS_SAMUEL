import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { branch } from "./branch.js";

export const deviceStatus = pgTable("device_status", {
  deviceId: text("device_id").primaryKey(),
  branchId: uuid("branch_id").references(() => branch.id),
  appVersion: text("app_version"),
  queueDepth: integer("queue_depth").notNull().default(0),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
});
