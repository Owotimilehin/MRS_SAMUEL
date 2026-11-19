-- Publishing posts to Facebook and Instagram (suite spec 09). Additive only: two new tables.
-- A post is written once and sent to one row per network in social_post_target.
-- Ruling 9.2.8: every column that points at admin_user or inbox_phone_number is ON DELETE SET NULL,
-- so removing a person or a channel account never fails on these tables and never deletes the record
-- of a post that went out. Nothing here points at inbox_conversation or customer.
-- Undo: DROP TABLE "social_post_target"; DROP TABLE "social_post"; (nothing else refers to them).

CREATE TABLE IF NOT EXISTS "social_post" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('text','link','photo','album','video','story')),
  "caption" text DEFAULT '' NOT NULL,
  "link_url" text,
  "media" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft','scheduled','publishing','published','partly_published','failed','needs_check','missed')),
  "scheduled_at" timestamptz,
  "status_note" text,
  "approved_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "approved_at" timestamptz,
  "approved_hash" text,
  "caption_source" text DEFAULT 'person' NOT NULL,
  "created_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_status_sched" ON "social_post" ("status","scheduled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_created" ON "social_post" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_post_target" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "post_id" uuid NOT NULL REFERENCES "social_post"("id") ON DELETE CASCADE,
  "account_id" uuid REFERENCES "inbox_phone_number"("id") ON DELETE SET NULL,
  "network" text NOT NULL CHECK ("network" IN ('facebook','instagram')),
  "caption_override" text,
  "status" text DEFAULT 'pending' NOT NULL CHECK ("status" IN ('pending','publishing','published','failed','unknown','removed')),
  "step" text DEFAULT 'start' NOT NULL CHECK ("step" IN ('start','media','container','wait','publish','done')),
  "container_id" text,
  "child_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "external_id" text,
  "external_kind" text,
  "permalink" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "reconcile_checks" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "wait_started_at" timestamptz,
  "locked_at" timestamptz,
  "error_code" text,
  "error_subcode" text,
  "error_message" text,
  "published_at" timestamptz,
  "removed_at" timestamptz,
  "removed_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_post_target_account" ON "social_post_target" ("post_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_social_post_target_external" ON "social_post_target" ("network","external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_social_post_target_due" ON "social_post_target" ("status","next_attempt_at");
