-- Template authoring: drafts and Meta review tracking on inbox_template (suite spec 06).
-- Additive only: new nullable columns and two indexes. No existing column changes.
-- The unique index uq_inbox_template (waba_id, name, language) is untouched and
-- still holds: a draft is a row with status 'DRAFT' under the same key.
-- The three admin_user references are plain (no ON DELETE): staff are deactivated, never deleted,
-- as with every other created_by column in the inbox tables.
-- Undo: DROP INDEX uq_inbox_template_meta_id, idx_inbox_template_status;
--       ALTER TABLE inbox_template DROP COLUMN for each column below.

ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "meta_template_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "parameter_format" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "quality_score" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "rejected_reason" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "review_info" jsonb;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "correct_category" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "previous_category" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "category_change_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "draft" jsonb;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "draft_updated_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "draft_updated_by" uuid REFERENCES "admin_user"("id");
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "admin_user"("id");
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "submitted_by" uuid REFERENCES "admin_user"("id");
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "meta_edit_times" jsonb;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "inbox_template" ADD COLUMN IF NOT EXISTS "starter_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_template_meta_id" ON "inbox_template" ("meta_template_id") WHERE "meta_template_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_template_status" ON "inbox_template" ("status");
