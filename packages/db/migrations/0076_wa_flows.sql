-- WhatsApp Flows (in-chat forms; suite spec 07). Additive only: two new tables.
-- wa_flow: one row per form version created at Meta. wa_flow_response: one row per completed form.
-- wa_flow_response follows its message and its conversation (ON DELETE CASCADE) and forgets the
-- request message and the form version if they go (ON DELETE SET NULL), so erasing a contact can
-- never fail on these keys (foundation ruling 9.2.8). The admin_user references are plain:
-- staff are deactivated, never deleted, as with every other created_by column in the inbox tables.
-- No key material and no token secret is stored in either table.
-- Undo: DROP TABLE wa_flow_response; DROP TABLE wa_flow;

CREATE TABLE IF NOT EXISTS "wa_flow" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "waba_id" text NOT NULL,
  "key" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "meta_flow_id" text,
  "meta_name" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "uses_endpoint" boolean DEFAULT false NOT NULL,
  "json_version" text,
  "uploaded_hash" text,
  "published_hash" text,
  "validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_error" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "published_by" uuid REFERENCES "admin_user"("id"),
  "published_at" timestamptz,
  "retired_at" timestamptz,
  "synced_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wa_flow_key_version" ON "wa_flow" ("waba_id","key","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wa_flow_meta_id" ON "wa_flow" ("meta_flow_id") WHERE "meta_flow_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wa_flow_response" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL UNIQUE REFERENCES "inbox_message"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "request_message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "flow_id" uuid REFERENCES "wa_flow"("id") ON DELETE SET NULL,
  "flow_key" text NOT NULL,
  "flow_token" text,
  "data" jsonb NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "handled_by" uuid REFERENCES "admin_user"("id"),
  "handled_at" timestamptz,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wa_flow_response_conv" ON "wa_flow_response" ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wa_flow_response_key" ON "wa_flow_response" ("flow_key","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wa_flow_response_slot" ON "wa_flow_response" (("data"->>'day'),("data"->>'slot')) WHERE "flow_key" = 'delivery_slot';
