-- Suite spec 01: channel accounts and customer identities.
-- Additive. inbox_phone_number gains kind/external_id/page_external_id/external_name and
-- its e164 becomes nullable (a Page or an Instagram account has no phone number).
-- New table inbox_identity. inbox_conversation gains channel + identity_id; inbox_message
-- gains channel. Back-fills WhatsApp identities from messages already received.
-- No customer row is created, changed or deleted.
-- inbox_identity.customer_id is ON DELETE CASCADE (foundation ruling 9.2.8: tables that
-- point at customer declare CASCADE or SET NULL).
-- Undo: DROP INDEX idx_inbox_conv_channel; ALTER TABLE inbox_message DROP COLUMN channel;
--   ALTER TABLE inbox_conversation DROP COLUMN identity_id, DROP COLUMN channel;
--   DROP TABLE inbox_identity; DROP INDEX uq_inbox_number_kind_external;
--   ALTER TABLE inbox_phone_number DROP CONSTRAINT inbox_phone_number_shape_chk,
--     DROP COLUMN external_name, DROP COLUMN page_external_id, DROP COLUMN external_id, DROP COLUMN kind;
--   (delete non-phone rows first) ALTER TABLE inbox_phone_number ALTER COLUMN e164 SET NOT NULL.

ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'phone' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "external_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "page_external_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ADD COLUMN IF NOT EXISTS "external_name" text;
--> statement-breakpoint
ALTER TABLE "inbox_phone_number" ALTER COLUMN "e164" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inbox_phone_number" ADD CONSTRAINT "inbox_phone_number_shape_chk" CHECK (
    ("kind" = 'phone' AND "e164" IS NOT NULL)
    OR ("kind" <> 'phone' AND "external_id" IS NOT NULL AND "page_external_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_number_kind_external"
  ON "inbox_phone_number" ("kind","external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_identity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "channel" text NOT NULL CHECK ("channel" IN ('whatsapp','messenger','instagram')),
  "account_external_id" text NOT NULL,
  "external_id" text NOT NULL,
  "display_name" text,
  "username" text,
  "profile_pic_url" text,
  "profile_fetched_at" timestamptz,
  "last_seen_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_identity"
  ON "inbox_identity" ("channel","account_external_id","external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_identity_customer" ON "inbox_identity" ("customer_id");
--> statement-breakpoint
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "identity_id" uuid REFERENCES "inbox_identity"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_channel" ON "inbox_conversation" ("channel","status","last_activity_at");
--> statement-breakpoint
COMMENT ON COLUMN "inbox_message"."wa_message_id" IS 'Provider message id for every channel: WhatsApp wamid…, Messenger and Instagram mid… (foundation D3). Do not rename.';
--> statement-breakpoint
COMMENT ON COLUMN "inbox_conversation"."last_inbound_wa_at" IS 'When the customer last wrote on this conversation''s channel; drives the 24-hour reply window on all channels (foundation D4). Do not rename.';
--> statement-breakpoint
-- Back-fill 1: one WhatsApp identity per sender number that has actually written to us.
-- The customer is the one the most recent such message's conversation belongs to today,
-- so contacts merged in the past keep their merge.
INSERT INTO "inbox_identity" ("customer_id","channel","account_external_id","external_id","created_at","last_seen_at")
SELECT DISTINCT ON (m."payload"->>'from')
  c."customer_id", 'whatsapp', 'global', m."payload"->>'from', m."created_at", m."created_at"
FROM "inbox_message" m
JOIN "inbox_conversation" c ON c."id" = m."conversation_id"
WHERE m."direction" = 'in' AND m."payload"->>'from' ~ '^[0-9]{8,15}$'
ORDER BY m."payload"->>'from', m."created_at" DESC
ON CONFLICT ("channel","account_external_id","external_id") DO NOTHING;
--> statement-breakpoint
-- Back-fill 2: each conversation remembers who it is with (the last number that wrote in it).
UPDATE "inbox_conversation" c
SET "identity_id" = i."id"
FROM (
  SELECT DISTINCT ON (m."conversation_id") m."conversation_id", m."payload"->>'from' AS wa_id
  FROM "inbox_message" m
  WHERE m."direction" = 'in' AND m."payload"->>'from' ~ '^[0-9]{8,15}$'
  ORDER BY m."conversation_id", m."created_at" DESC
) last
JOIN "inbox_identity" i
  ON i."channel" = 'whatsapp' AND i."account_external_id" = 'global' AND i."external_id" = last.wa_id
WHERE c."id" = last."conversation_id" AND c."identity_id" IS NULL;
