-- Tasks and reminders (suite spec 15). Additive only: three nullable columns on
-- inbox_conversation (snooze), one partial index, one new table inbox_reminder.
-- The reply-time target needs no column: it lives in app_settings under key
-- 'inbox_reply_target'. Safe to run twice (IF NOT EXISTS everywhere).
--   inbox_conversation.snoozed_until  when a snoozed chat comes back; null = not snoozed
--   inbox_conversation.snoozed_by     who snoozed it
--   inbox_conversation.woke_at        when a snooze ended by time; cleared when someone opens the chat
--   inbox_reminder                    "call back Friday": a note, a due time, who it is for
-- Undo: DROP TABLE "inbox_reminder";
--       DROP INDEX "idx_inbox_conv_snoozed";
--       ALTER TABLE "inbox_conversation" DROP COLUMN "snoozed_until", DROP COLUMN "snoozed_by", DROP COLUMN "woke_at";

ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "snoozed_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "woke_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_snoozed" ON "inbox_conversation" ("snoozed_until") WHERE "snoozed_until" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_reminder" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "note" text NOT NULL,
  "due_at" timestamptz NOT NULL,
  "assignee_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "notified_at" timestamptz,
  "done_at" timestamptz,
  "done_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_reminder_assignee_open" ON "inbox_reminder" ("assignee_id","due_at") WHERE "done_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_reminder_to_alert" ON "inbox_reminder" ("due_at") WHERE "done_at" IS NULL AND "notified_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_reminder_conversation" ON "inbox_reminder" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_reminder_customer" ON "inbox_reminder" ("customer_id");
