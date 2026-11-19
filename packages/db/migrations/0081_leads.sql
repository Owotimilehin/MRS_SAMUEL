-- Leads from Meta lead forms (suite spec 13). Additive only: two new lead_* tables.
-- No existing table is altered. lead.customer_id and lead.conversation_id are ON DELETE SET NULL
-- (ruling 9.2.8), so erasing or merging a contact can never fail on these foreign keys.
-- Undo: DROP TABLE "lead", "lead_form" (in that order). Nothing else depends on them.

CREATE TABLE IF NOT EXISTS "lead_form" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "form_id" text NOT NULL UNIQUE,
  "page_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text,
  "locale" text,
  "questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "privacy_policy_url" text,
  "disclaimers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "whatsapp_consent_key" text,
  "consent_covers_whatsapp" boolean DEFAULT false NOT NULL,
  "phone_number_id" uuid REFERENCES "inbox_phone_number"("id") ON DELETE SET NULL,
  "is_enabled" boolean DEFAULT true NOT NULL,
  "backfill_requested_at" timestamptz,
  "backfill_cursor" text,
  "backfill_done_at" timestamptz,
  "backfill_count" integer DEFAULT 0 NOT NULL,
  "backfill_error" text,
  "synced_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "leadgen_id" text NOT NULL UNIQUE,
  "form_id" text NOT NULL,
  "page_id" text,
  "ad_id" text,
  "ad_name" text,
  "adset_id" text,
  "adset_name" text,
  "campaign_id" text,
  "campaign_name" text,
  "platform" text,
  "is_organic" boolean,
  "is_backfill" boolean DEFAULT false NOT NULL,
  "meta_created_at" timestamptz,
  "fetch_state" text DEFAULT 'pending' NOT NULL CHECK ("fetch_state" IN ('pending','fetched','failed','gone')),
  "fetch_attempts" integer DEFAULT 0 NOT NULL,
  "next_fetch_at" timestamptz DEFAULT now() NOT NULL,
  "fetch_error_code" text,
  "fetch_error" text,
  "answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "full_name" text,
  "phone_raw" text,
  "phone_e164" text,
  "email" text,
  "consent" jsonb,
  "whatsapp_consent" boolean DEFAULT false NOT NULL,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE SET NULL,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'new' NOT NULL CHECK ("status" IN ('new','contacted','won','lost')),
  "lost_reason" text CHECK ("lost_reason" IN ('not_interested','no_answer','wrong_number','duplicate','test','other')),
  "assignee_id" uuid REFERENCES "admin_user"("id"),
  "note" text,
  "followup_sent_at" timestamptz,
  "first_contacted_at" timestamptz,
  "closed_at" timestamptz,
  "erased_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_status_created" ON "lead" ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_form_created" ON "lead" ("form_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_customer" ON "lead" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_fetch" ON "lead" ("fetch_state","next_fetch_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_assignee" ON "lead" ("assignee_id");
