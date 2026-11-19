-- Statistics from Meta, one row per figure per day (suite spec 11). Additive only: two new tables.
-- insight_metric_daily.account_id points at inbox_phone_number with ON DELETE SET NULL (ruling 9.2.8):
-- the figures stay, keyed by account_key, if the channel account row is ever removed. Nothing here
-- points at inbox_conversation, customer or admin_user.
-- Undo: DROP TABLE "insight_metric_daily"; DROP TABLE "insight_subject"; (nothing else refers to them).

CREATE TABLE IF NOT EXISTS "insight_metric_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('facebook_page','facebook_post','instagram_account','instagram_media','whatsapp','whatsapp_template')),
  "account_key" text NOT NULL,
  "account_id" uuid REFERENCES "inbox_phone_number"("id") ON DELETE SET NULL,
  "subject_id" text DEFAULT '' NOT NULL,
  "metric" text NOT NULL,
  "day" date NOT NULL,
  "day_zone" text NOT NULL,
  "breakdown" text DEFAULT '' NOT NULL,
  "value" numeric(20,4) NOT NULL,
  "is_running_total" boolean DEFAULT false NOT NULL,
  "fetched_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_insight_metric_daily" ON "insight_metric_daily" ("source","account_key","subject_id","metric","day","breakdown");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_insight_metric_day" ON "insight_metric_daily" ("source","metric","day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_insight_metric_subject" ON "insight_metric_daily" ("source","subject_id") WHERE "subject_id" <> '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insight_subject" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('facebook_post','instagram_media','whatsapp_template')),
  "account_key" text NOT NULL,
  "subject_id" text NOT NULL,
  "kind" text,
  "title" text,
  "permalink" text,
  "published_at" timestamptz,
  "gone_at" timestamptz,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_insight_subject" ON "insight_subject" ("source","subject_id");
