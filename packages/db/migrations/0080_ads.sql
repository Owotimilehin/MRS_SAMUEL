-- Ads (spec 12). Additive only: eight new ad_* tables and one trigger on ad_action_log.
-- No existing table is altered.
-- Every pointer at admin_user is ON DELETE SET NULL, and every pointer at customer,
-- inbox_conversation or sale_order is ON DELETE CASCADE (foundation ruling 9.2.8), so
-- these tables can never stop the shop deleting one of its own rows.
-- ad_action_log is append-only: the trigger below refuses every UPDATE and DELETE.
-- Safe to run twice (IF NOT EXISTS, CREATE OR REPLACE, duplicate_object caught).
-- Undo: DROP TABLE "ad_rule","ad_draft","ad_order_attribution","ad_touch","ad_action_log","ad_insight_daily","ad_campaign_cache","ad_account_link";
--       DROP FUNCTION "ad_action_log_immutable"();

CREATE TABLE IF NOT EXISTS "ad_account_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ad_account_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "currency" text NOT NULL,
  "timezone_name" text NOT NULL,
  "timezone_offset_hours_utc" numeric(5,2),
  "account_status" integer,
  "min_daily_budget_units" bigint,
  "budget_factor" integer,
  "budget_factor_confirmed_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "budget_factor_confirmed_at" timestamptz,
  "is_active" boolean DEFAULT true NOT NULL,
  "linked_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "linked_at" timestamptz DEFAULT now() NOT NULL,
  "backfilled_at" timestamptz,
  "last_synced_at" timestamptz,
  "last_error_code" text,
  "last_error_message" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_account_link_one_active" ON "ad_account_link" ("is_active") WHERE "is_active";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_campaign_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ad_account_id" text NOT NULL,
  "level" text NOT NULL CHECK ("level" IN ('campaign','adset','ad')),
  "external_id" text NOT NULL,
  "parent_external_id" text,
  "campaign_external_id" text,
  "name" text,
  "status" text,
  "effective_status" text,
  "objective" text,
  "destination_type" text,
  "daily_budget_units" bigint,
  "lifetime_budget_units" bigint,
  "start_time" timestamptz,
  "end_time" timestamptz,
  "creative" jsonb,
  "created_by_suite" boolean DEFAULT false NOT NULL,
  "gone_at" timestamptz,
  "synced_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_campaign_cache" ON "ad_campaign_cache" ("level","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_campaign_cache_account" ON "ad_campaign_cache" ("ad_account_id","level");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_insight_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ad_account_id" text NOT NULL,
  "level" text NOT NULL CHECK ("level" IN ('account','ad')),
  "external_id" text NOT NULL,
  "day" date NOT NULL,
  "day_zone" text NOT NULL,
  "currency" text NOT NULL,
  "spend" numeric(14,2) DEFAULT 0 NOT NULL,
  "impressions" bigint DEFAULT 0 NOT NULL,
  "reach" bigint,
  "clicks" bigint DEFAULT 0 NOT NULL,
  "link_clicks" bigint,
  "conversations_started" integer DEFAULT 0 NOT NULL,
  "first_replies" integer DEFAULT 0 NOT NULL,
  "meta_purchases" numeric(14,2) DEFAULT 0 NOT NULL,
  "meta_purchase_value" numeric(14,2) DEFAULT 0 NOT NULL,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "fetched_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_insight_daily" ON "ad_insight_daily" ("level","external_id","day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_insight_daily_account_day" ON "ad_insight_daily" ("ad_account_id","day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_action_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "phase" text NOT NULL CHECK ("phase" IN ('requested','result')),
  "at" timestamptz DEFAULT now() NOT NULL,
  "actor_kind" text NOT NULL CHECK ("actor_kind" IN ('person','rule','safety','system')),
  "actor_user_id" uuid,
  "actor_name" text,
  "action" text NOT NULL,
  "ad_account_id" text,
  "object_level" text,
  "object_external_id" text,
  "summary" text NOT NULL,
  "max_spend_units" bigint,
  "currency" text,
  "confirm_text" text,
  "request" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "outcome" text CHECK ("outcome" IN ('ok','refused','unknown','blocked')),
  "meta_code" text,
  "meta_message" text,
  "response" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ad_action_log_request_phase" ON "ad_action_log" ("request_id","phase");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_action_log_at" ON "ad_action_log" ("at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ad_action_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ad_action_log is append-only: rows cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TRIGGER "trg_ad_action_log_immutable" BEFORE UPDATE OR DELETE ON "ad_action_log"
  FOR EACH ROW EXECUTE FUNCTION "ad_action_log_immutable"();
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TRIGGER "trg_ad_action_log_no_truncate" BEFORE TRUNCATE ON "ad_action_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "ad_action_log_immutable"();
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_touch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_key" text NOT NULL UNIQUE,
  "channel" text NOT NULL CHECK ("channel" IN ('whatsapp','messenger','instagram')),
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "source_type" text NOT NULL,
  "ad_external_id" text,
  "post_external_id" text,
  "headline" text,
  "body" text,
  "source_url" text,
  "media_type" text,
  "ctwa_clid" text,
  "account_external_id" text,
  "sender_external_id" text,
  "touched_at" timestamptz NOT NULL,
  "reporting_blocked_at" timestamptz,
  "reporting_blocked_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_touch_customer" ON "ad_touch" ("customer_id","touched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_touch_ad" ON "ad_touch" ("ad_external_id","touched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_touch_conversation" ON "ad_touch" ("conversation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_order_attribution" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sale_order_id" uuid NOT NULL UNIQUE REFERENCES "sale_order"("id") ON DELETE CASCADE,
  "touch_id" uuid NOT NULL REFERENCES "ad_touch"("id") ON DELETE CASCADE,
  "rule" text NOT NULL,
  "order_at" timestamptz NOT NULL,
  "value_ngn" integer NOT NULL,
  "capi_status" text DEFAULT 'none' NOT NULL CHECK ("capi_status" IN ('none','queued','sending','sent','failed','unknown','skipped')),
  "capi_note" text,
  "capi_attempts" integer DEFAULT 0 NOT NULL,
  "capi_locked_at" timestamptz,
  "capi_sent_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_order_attribution_touch" ON "ad_order_attribution" ("touch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ad_order_attribution_capi" ON "ad_order_attribution" ("capi_status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_draft" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft','creating','created','failed','needs_check')),
  "spec" jsonb NOT NULL,
  "step" text DEFAULT 'start' NOT NULL CHECK ("step" IN ('start','image','campaign','adset','creative','ad','verify','done')),
  "image_hash" text,
  "campaign_external_id" text,
  "adset_external_id" text,
  "creative_external_id" text,
  "ad_external_id" text,
  "confirmed_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "confirmed_at" timestamptz,
  "confirmed_hash" text,
  "locked_at" timestamptz,
  "error_code" text,
  "error_message" text,
  "created_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "metric" text NOT NULL CHECK ("metric" IN ('cost_per_conversation')),
  "threshold" numeric(14,2) NOT NULL CHECK ("threshold" > 0),
  "currency" text NOT NULL,
  "lookback_days" integer NOT NULL CHECK ("lookback_days" IN (1,3,7)),
  "min_spend" numeric(14,2) DEFAULT 0 NOT NULL,
  "scope_campaign_external_id" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "last_evaluated_at" timestamptz,
  "last_fired_at" timestamptz
);
