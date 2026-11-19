-- Chat set-up for Messenger and Instagram (suite spec 04). Additive only: one new table.
-- Each row is one version of the set-up for one channel account: the draft, or a publish attempt.
-- account_id points at inbox_phone_number with ON DELETE CASCADE (ruling 9.2.8); nothing here points at
-- inbox_conversation or customer.
-- Undo: DROP TABLE channel_chat_setup;

CREATE TABLE IF NOT EXISTS "channel_chat_setup" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('draft','pushing','live','failed','unknown','superseded')),
  "config" jsonb NOT NULL,
  "live_before" jsonb,
  "live_after" jsonb,
  "steps" jsonb,
  "error_code" text,
  "error_message" text,
  "created_by_user_id" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "pushed_by_user_id" uuid REFERENCES "admin_user"("id"),
  "pushed_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_channel_chat_setup_version" ON "channel_chat_setup" ("account_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_channel_chat_setup_draft" ON "channel_chat_setup" ("account_id") WHERE "status" = 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_chat_setup_pushed" ON "channel_chat_setup" ("account_id","pushed_at" DESC);
