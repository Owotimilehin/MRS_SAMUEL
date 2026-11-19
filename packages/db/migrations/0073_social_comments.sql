-- Comments on Facebook Page posts and Instagram posts (suite spec 03).
-- Additive only: four new social_* tables. No existing table is altered.
-- Safe to run twice: every statement is CREATE ... IF NOT EXISTS.
-- social_comment.conversation_id is ON DELETE SET NULL (foundation ruling 9.2.8), so erasing or
-- merging a contact's inbox history never fails on it. Nothing here points at customer.
-- social_comment_rule is for the optional Phase B (keyword rules); nothing reads it yet and every
-- rule is created switched off (is_active DEFAULT false).
-- Undo: DROP TABLE social_comment_rule; DROP TABLE social_comment;
--       DROP TABLE social_post_ref; DROP TABLE social_comment_account;

CREATE TABLE IF NOT EXISTS "social_comment_account" (
  "account_id" uuid PRIMARY KEY REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  "backfill_started_at" timestamptz,
  "backfilled_at" timestamptz,
  "last_polled_at" timestamptz,
  "paused_until" timestamptz,
  "last_error_code" text,
  "last_error" text,
  "last_error_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_post_ref" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "network" text NOT NULL CHECK ("network" IN ('facebook','instagram')),
  "external_id" text NOT NULL,
  "message" text,
  "permalink_url" text,
  "picture_url" text,
  "media_type" text,
  "is_ad" boolean DEFAULT false NOT NULL,
  "posted_at" timestamptz,
  "remote_comment_count" integer,
  "remote_updated_at" timestamptz,
  "fetched_at" timestamptz,
  "fetch_attempts" integer DEFAULT 0 NOT NULL,
  "fetch_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_post_ref_ext" ON "social_post_ref" ("network","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_ref_account" ON "social_post_ref" ("account_id","posted_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_comment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "social_post_ref"("id"),
  "account_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "network" text NOT NULL CHECK ("network" IN ('facebook','instagram')),
  "external_id" text,
  "parent_external_id" text,
  "root_id" uuid REFERENCES "social_comment"("id"),
  "kind" text DEFAULT 'comment' NOT NULL CHECK ("kind" IN ('comment','live','mention')),
  "author_external_id" text,
  "author_name" text,
  "author_username" text,
  "from_business" boolean DEFAULT false NOT NULL,
  "sent_by_user_id" uuid REFERENCES "admin_user"("id"),
  "message" text,
  "attachment_url" text,
  "status" text DEFAULT 'visible' NOT NULL CHECK ("status" IN ('visible','hidden','deleted')),
  "hidden_source" text CHECK ("hidden_source" IN ('suite','outside')),
  "status_changed_at" timestamptz,
  "edited_at" timestamptz,
  "send_status" text CHECK ("send_status" IN ('queued','sent','failed','unknown')),
  "error_code" text,
  "error_message" text,
  "liked_by_business" boolean DEFAULT false NOT NULL,
  "like_count" integer,
  "needs_fetch" boolean DEFAULT false NOT NULL,
  "work_state" text DEFAULT 'open' NOT NULL CHECK ("work_state" IN ('open','done')),
  "assignee_id" uuid REFERENCES "admin_user"("id"),
  "unread_count" integer DEFAULT 0 NOT NULL,
  "last_activity_at" timestamptz DEFAULT now() NOT NULL,
  "last_preview" text,
  "done_by_user_id" uuid REFERENCES "admin_user"("id"),
  "done_at" timestamptz,
  "refreshed_at" timestamptz,
  "private_reply_status" text CHECK ("private_reply_status" IN ('queued','sent','failed','unknown')),
  "private_reply_body" text,
  "private_reply_message_id" text,
  "private_reply_by_user_id" uuid REFERENCES "admin_user"("id"),
  "private_reply_at" timestamptz,
  "private_reply_error_code" text,
  "private_reply_error" text,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE SET NULL,
  "commented_at" timestamptz NOT NULL,
  "payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_comment_ext" ON "social_comment" ("network","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_threads" ON "social_comment" ("work_state","last_activity_at" DESC) WHERE "root_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_root" ON "social_comment" ("root_id","commented_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_post" ON "social_comment" ("post_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_comment_fetch" ON "social_comment" ("created_at") WHERE "needs_fetch";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_comment_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  "keyword" text NOT NULL,
  "match" text DEFAULT 'contains' NOT NULL CHECK ("match" IN ('contains','exact')),
  "reply_text" text NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "activated_by_user_id" uuid REFERENCES "admin_user"("id"),
  "activated_at" timestamptz,
  "sent_count" integer DEFAULT 0 NOT NULL,
  "last_sent_at" timestamptz,
  "created_by_user_id" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
