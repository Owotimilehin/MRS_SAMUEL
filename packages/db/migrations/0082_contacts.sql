-- Contacts (suite spec 14, Phase A). Additive only: new contact_* tables. No existing table is altered.
-- Undo: DROP TABLE "contact_import_row", "contact_consent", "contact_origin", "contact_import",
--   "contact_list_member", "contact_list", "contact_label_member", "contact_label", "contact_alias",
--   "contact_summary" (in that order). Nothing else depends on them.

CREATE TABLE IF NOT EXISTS "contact_summary" (
  "customer_id" uuid PRIMARY KEY REFERENCES "customer"("id") ON DELETE CASCADE,
  "name_sort" text COLLATE "C" DEFAULT '~' NOT NULL,
  "search_text" text DEFAULT '' NOT NULL,
  "phone_digits" text,
  "has_phone" boolean DEFAULT false NOT NULL,
  "has_email" boolean DEFAULT false NOT NULL,
  "has_address" boolean DEFAULT false NOT NULL,
  "address" text,
  "address_source" text CHECK ("address_source" IN ('saved','last_delivery')),
  "channels" text[] DEFAULT '{}'::text[] NOT NULL,
  "orders_count" integer DEFAULT 0 NOT NULL,
  "spent_ngn" bigint DEFAULT 0 NOT NULL,
  "first_order_at" timestamptz,
  "last_order_at" timestamptz,
  "last_order_key" timestamptz DEFAULT '-infinity' NOT NULL,
  "last_contact_at" timestamptz,
  "last_contact_key" timestamptz DEFAULT '-infinity' NOT NULL,
  "created_key" timestamptz DEFAULT now() NOT NULL,
  "wa_unreachable_at" timestamptz,
  "refreshed_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_name" ON "contact_summary" ("name_sort","customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_last_order" ON "contact_summary" ("last_order_key" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_spent" ON "contact_summary" ("spent_ngn" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_last_contact" ON "contact_summary" ("last_contact_key" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_created" ON "contact_summary" ("created_key" DESC,"customer_id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_summary_phone" ON "contact_summary" ("phone_digits");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_alias" (
  "customer_id" uuid PRIMARY KEY REFERENCES "customer"("id") ON DELETE CASCADE,
  "into_customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CHECK ("customer_id" <> "into_customer_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_alias_into" ON "contact_alias" ("into_customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_label" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "name_key" text NOT NULL UNIQUE,
  "colour" text DEFAULT 'green' NOT NULL CHECK ("colour" IN ('green','amber','red','blue','purple','grey')),
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_label_member" (
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "label_id" uuid NOT NULL REFERENCES "contact_label"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "admin_user"("id"),
  "added_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("customer_id","label_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_label_member_label" ON "contact_label_member" ("label_id","customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_list" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "name_key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('static','smart')),
  "description" text,
  "filter" jsonb,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "archived_at" timestamptz,
  CHECK (("kind" = 'smart') = ("filter" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_contact_list_name" ON "contact_list" ("name_key") WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_list_member" (
  "list_id" uuid NOT NULL REFERENCES "contact_list"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "admin_user"("id"),
  "added_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("list_id","customer_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_list_member_customer" ON "contact_list_member" ("customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_import" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "filename" text NOT NULL,
  "status" text DEFAULT 'uploaded' NOT NULL CHECK ("status" IN ('uploaded','previewed','applying','applied','failed','cancelled')),
  "headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "mapping" jsonb,
  "source_label" text,
  "customer_source" text DEFAULT 'phone' NOT NULL CHECK ("customer_source" IN ('walkup_anonymous','online','phone','whatsapp','chowdeck')),
  "consent_declared" text DEFAULT 'none' NOT NULL CHECK ("consent_declared" IN ('none','marketing_whatsapp')),
  "consent_method" text,
  "consent_wording" text,
  "consent_collected_on" date,
  "fill_blanks" boolean DEFAULT false NOT NULL,
  "label_id" uuid REFERENCES "contact_label"("id") ON DELETE SET NULL,
  "list_id" uuid REFERENCES "contact_list"("id") ON DELETE SET NULL,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "new_count" integer DEFAULT 0 NOT NULL,
  "matched_count" integer DEFAULT 0 NOT NULL,
  "rejected_count" integer DEFAULT 0 NOT NULL,
  "applied_rows" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "previewed_at" timestamptz,
  "applied_at" timestamptz,
  "rows_purged_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_import_row" (
  "import_id" uuid NOT NULL REFERENCES "contact_import"("id") ON DELETE CASCADE,
  "row_no" integer NOT NULL,
  "raw" jsonb NOT NULL,
  "name" text,
  "phone_e164" text,
  "email" text,
  "address" text,
  "notes" text,
  "outcome" text DEFAULT 'pending' NOT NULL CHECK ("outcome" IN ('pending','new','matched','rejected')),
  "reason" text,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE SET NULL,
  "filled" jsonb,
  "applied_at" timestamptz,
  PRIMARY KEY ("import_id","row_no")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_import_row_customer" ON "contact_import_row" ("customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_origin" (
  "customer_id" uuid PRIMARY KEY REFERENCES "customer"("id") ON DELETE CASCADE,
  "origin" text NOT NULL CHECK ("origin" IN ('manual','import')),
  "import_id" uuid REFERENCES "contact_import"("id") ON DELETE SET NULL,
  "source_label" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_consent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "channel" text NOT NULL CHECK ("channel" IN ('whatsapp','sms','email','phone')),
  "purpose" text NOT NULL CHECK ("purpose" IN ('marketing','service')),
  "state" text NOT NULL CHECK ("state" IN ('granted','withdrawn')),
  "method" text NOT NULL CHECK ("method" IN ('staff','import','keyword','whatsapp_setting','meta_refusal','erase_request','carried_over','merge')),
  "wording" text,
  "note" text,
  "collected_on" date,
  "recorded_by" uuid REFERENCES "admin_user"("id"),
  "import_id" uuid REFERENCES "contact_import"("id") ON DELETE SET NULL,
  "message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "confirm_state" text DEFAULT 'none' NOT NULL CHECK ("confirm_state" IN ('none','pending','sending','sent','skipped','failed')),
  "recorded_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_contact_consent_current" ON "contact_consent" ("customer_id","channel","purpose") WHERE "is_current";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_consent_history" ON "contact_consent" ("customer_id","recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_consent_state" ON "contact_consent" ("channel","purpose","state") WHERE "is_current";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_consent_confirm" ON "contact_consent" ("recorded_at") WHERE "confirm_state" = 'pending';
