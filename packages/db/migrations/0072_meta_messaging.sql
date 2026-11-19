-- Suite spec 02: Messenger and Instagram direct messages. Additive only.
-- inbox_message: where to fetch a received file from (cleared once stored), and when the
-- customer edited or deleted the message. inbox_phone_number: webhook subscription state
-- and the last configuration problem Meta reported for the account.
-- No new foreign key: nothing here points at inbox_conversation or customer (ruling 9.2.8).
-- Undo: DROP INDEX idx_inbox_msg_media_url;
--   ALTER TABLE inbox_message DROP COLUMN media_url, DROP COLUMN edited_at, DROP COLUMN deleted_at;
--   ALTER TABLE inbox_phone_number DROP COLUMN webhook_subscribed_at, DROP COLUMN webhook_checked_at,
--     DROP COLUMN problem_code, DROP COLUMN problem_text, DROP COLUMN problem_at.

ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "media_url" text;
--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "edited_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_msg_media_url" ON "inbox_message" ("created_at")
  WHERE "media_url" IS NOT NULL AND "media_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "webhook_subscribed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "webhook_checked_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "problem_code" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "problem_text" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "problem_at" timestamptz;
