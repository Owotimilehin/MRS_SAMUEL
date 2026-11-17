-- Unified inbox (WhatsApp + voice). Additive only: new enums and inbox_* tables.
-- No existing table is altered; customer rows are referenced, never changed.
-- Undo: DROP the inbox_* tables and inbox_* enums (no other table depends on them).

DO $$ BEGIN CREATE TYPE "inbox_channels" AS ENUM ('voice','whatsapp','both'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_conversation_status" AS ENUM ('open','pending','closed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_direction" AS ENUM ('in','out'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_message_status" AS ENUM ('received','queued','sent','delivered','read','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_call_outcome" AS ENUM ('in_progress','answered','missed','voicemail','after_hours','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_recording_kind" AS ENUM ('call','voicemail'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_recording_status" AS ENUM ('pending','stored','transcribed','summarised','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_ivr_action" AS ENUM ('ring_team','voicemail','play'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inbox_webhook_source" AS ENUM ('meta','twilio'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_team" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "description" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_team_member" (
  "team_id" uuid NOT NULL REFERENCES "inbox_team"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "is_lead" boolean DEFAULT false NOT NULL,
  PRIMARY KEY ("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_hours_profile" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_hours_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "inbox_hours_profile"("id") ON DELETE CASCADE,
  "weekday" integer NOT NULL CHECK ("weekday" BETWEEN 0 AND 6),
  "open_time" text NOT NULL CHECK ("open_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "close_time" text NOT NULL CHECK ("close_time" ~ '^([01][0-9]|2[0-4]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_hours_rule_profile" ON "inbox_hours_rule" ("profile_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_holiday" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid REFERENCES "inbox_hours_profile"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_ivr_menu" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "greeting_text" text NOT NULL,
  "greeting_audio_key" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_ivr_option" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "menu_id" uuid NOT NULL REFERENCES "inbox_ivr_menu"("id") ON DELETE CASCADE,
  "digit" text NOT NULL CHECK ("digit" ~ '^[0-9]$'),
  "label" text NOT NULL,
  "action" "inbox_ivr_action" NOT NULL,
  "team_id" uuid REFERENCES "inbox_team"("id"),
  "play_text" text,
  "audio_key" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_ivr_option_digit" ON "inbox_ivr_option" ("menu_id","digit");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_phone_number" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "e164" text NOT NULL UNIQUE,
  "label" text NOT NULL,
  "channels" "inbox_channels" DEFAULT 'both' NOT NULL,
  "waba_id" text,
  "wa_phone_number_id" text UNIQUE,
  "wa_status" text,
  "quality_rating" text,
  "messaging_limit" text,
  "wa_fallback_number_id" uuid REFERENCES "inbox_phone_number"("id"),
  "voice_provider" text,
  "inbound_match" text,
  "max_concurrent_calls" integer,
  "default_team_id" uuid REFERENCES "inbox_team"("id"),
  "hours_profile_id" uuid REFERENCES "inbox_hours_profile"("id"),
  "ivr_menu_id" uuid REFERENCES "inbox_ivr_menu"("id"),
  "after_hours_text" text,
  "after_hours_audio_key" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_user_number_access" (
  "user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "phone_number_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id") ON DELETE CASCADE,
  PRIMARY KEY ("user_id","phone_number_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_conversation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id"),
  "phone_number_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "team_id" uuid REFERENCES "inbox_team"("id"),
  "status" "inbox_conversation_status" DEFAULT 'open' NOT NULL,
  "assignee_id" uuid REFERENCES "admin_user"("id"),
  "labels" text[] DEFAULT '{}' NOT NULL,
  "last_inbound_wa_at" timestamptz,
  "last_activity_at" timestamptz DEFAULT now() NOT NULL,
  "last_preview" text,
  "unread_count" integer DEFAULT 0 NOT NULL,
  "first_response_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_activity" ON "inbox_conversation" ("status","last_activity_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_customer" ON "inbox_conversation" ("customer_id","phone_number_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_assignee" ON "inbox_conversation" ("assignee_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id"),
  "direction" "inbox_direction" NOT NULL,
  "type" text NOT NULL,
  "body" text,
  "media_id" text,
  "media_key" text,
  "media_mime" text,
  "media_filename" text,
  "template_name" text,
  "wa_message_id" text UNIQUE,
  "status" "inbox_message_status" NOT NULL,
  "error_code" text,
  "error_message" text,
  "sender_user_id" uuid REFERENCES "admin_user"("id"),
  "payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "delivered_at" timestamptz,
  "read_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_msg_conv" ON "inbox_message" ("conversation_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_note" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id"),
  "author_user_id" uuid NOT NULL REFERENCES "admin_user"("id"),
  "body" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_note_conv" ON "inbox_note" ("conversation_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_call" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customer"("id"),
  "phone_number_id" uuid NOT NULL REFERENCES "inbox_phone_number"("id"),
  "team_id" uuid REFERENCES "inbox_team"("id"),
  "twilio_call_sid" text NOT NULL UNIQUE,
  "direction" "inbox_direction" NOT NULL,
  "from_e164" text NOT NULL,
  "to_e164" text NOT NULL,
  "ivr_choice" text,
  "outcome" "inbox_call_outcome" DEFAULT 'in_progress' NOT NULL,
  "answered_by_user_id" uuid REFERENCES "admin_user"("id"),
  "started_by_user_id" uuid REFERENCES "admin_user"("id"),
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "answered_at" timestamptz,
  "ended_at" timestamptz,
  "duration_s" integer,
  "followup_sent_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_call_conv" ON "inbox_call" ("conversation_id","started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_call_started" ON "inbox_call" ("started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_recording" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_id" uuid NOT NULL REFERENCES "inbox_call"("id"),
  "twilio_recording_sid" text NOT NULL UNIQUE,
  "twilio_recording_url" text,
  "kind" "inbox_recording_kind" NOT NULL,
  "status" "inbox_recording_status" DEFAULT 'pending' NOT NULL,
  "storage_key" text,
  "duration_s" integer,
  "channels" integer,
  "transcript" text,
  "summary_json" jsonb,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_rec_status" ON "inbox_recording" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_template" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "waba_id" text NOT NULL,
  "name" text NOT NULL,
  "language" text NOT NULL,
  "category" text,
  "status" text NOT NULL,
  "components" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "synced_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_template" ON "inbox_template" ("waba_id","name","language");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_quick_reply" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_webhook_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" "inbox_webhook_source" NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_webhook_pending" ON "inbox_webhook_event" ("processed_at","received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_presence" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "available" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_push_token" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "token" text NOT NULL UNIQUE,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_push_user" ON "inbox_push_token" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_notify_pref" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "level" text DEFAULT 'assigned' NOT NULL
);
