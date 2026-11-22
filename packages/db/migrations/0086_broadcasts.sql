-- Broadcasts (suite spec 14, Phase B). Additive only: new broadcast_* tables. No existing table is altered.
-- Undo: DROP TABLE "broadcast_event", "broadcast_recipient", "broadcast" (in that order).

CREATE TABLE IF NOT EXISTS "broadcast" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft','scheduled','sending','paused','stopped','done','cancelled')),
  "stop_reason" text,
  "stop_detail" text,
  "phone_number_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "template_id" uuid REFERENCES "inbox_template"("id") ON DELETE SET NULL,
  "template_name" text,
  "template_language" text,
  "template_category" text,
  "list_id" uuid REFERENCES "contact_list"("id") ON DELETE SET NULL,
  "list_name" text,
  "blanks" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "header_media_key" text,
  "header_media_mime" text,
  "header_media_id" text,
  "header_media_uploaded_at" timestamptz,
  "route" text DEFAULT 'cloud' NOT NULL CHECK ("route" IN ('cloud','mm')),
  "fingerprint" text,
  "test_fingerprint" text,
  "test_to" text,
  "test_message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "test_sent_at" timestamptz,
  "scheduled_at" timestamptz,
  "confirmed_by" uuid REFERENCES "admin_user"("id"),
  "confirmed_at" timestamptz,
  "confirmed_count" integer,
  "attribution_days" integer DEFAULT 7 NOT NULL,
  "warmup_until" timestamptz,
  "wait_until" timestamptz,
  "temp_errors" integer DEFAULT 0 NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_status" ON "broadcast" ("status","scheduled_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_recipient" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "broadcast_id" uuid NOT NULL REFERENCES "broadcast"("id") ON DELETE CASCADE,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE SET NULL,
  "to_wa" text,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending','skipped','sending','sent','delivered','read','failed','unknown')),
  "skip_reason" text,
  "values" jsonb,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz,
  "claimed_at" timestamptz,
  "message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "wa_message_id" text,
  "error_code" text,
  "error_text" text,
  "sent_at" timestamptz,
  "delivered_at" timestamptz,
  "read_at" timestamptz,
  "failed_at" timestamptz,
  "replied_at" timestamptz,
  "opted_out_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_broadcast_recipient_customer" ON "broadcast_recipient" ("broadcast_id","customer_id") WHERE "customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_broadcast_recipient_number" ON "broadcast_recipient" ("broadcast_id","to_wa") WHERE "to_wa" IS NOT NULL AND "state" <> 'skipped';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipient_work" ON "broadcast_recipient" ("broadcast_id","state","next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipient_customer" ON "broadcast_recipient" ("customer_id","sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipient_message" ON "broadcast_recipient" ("message_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "broadcast_id" uuid NOT NULL REFERENCES "broadcast"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "detail" text,
  "user_id" uuid REFERENCES "admin_user"("id"),
  "at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_event" ON "broadcast_event" ("broadcast_id","at");
