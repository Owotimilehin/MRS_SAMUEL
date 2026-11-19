-- Catalogue sync and selling in WhatsApp chat (suite spec 08). Additive only: four new
-- catalogue_* tables. No existing table is altered.
-- Foreign keys (foundation ruling 9.2.8): catalogue_chat_order.conversation_id and .customer_id are
-- ON DELETE CASCADE (the contact erase route deletes conversations; the merge route re-points both
-- columns first). Every pointer at sale_order, admin_user, product and product_variant is
-- ON DELETE SET NULL, so nothing here can ever stop the shop deleting one of its own rows.
-- Undo: DROP TABLE "catalogue_chat_order", "catalogue_item_sync", "catalogue_batch",
-- "catalogue_link" (in that order). Nothing else depends on them.

CREATE TABLE IF NOT EXISTS "catalogue_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "catalog_id" text NOT NULL UNIQUE,
  "name" text,
  "waba_id" text,
  "whatsapp_connected" boolean DEFAULT false NOT NULL,
  "is_cart_enabled" boolean,
  "is_catalog_visible" boolean,
  "sync_enabled" boolean DEFAULT false NOT NULL,
  "ask_fulfilment_auto" boolean DEFAULT false NOT NULL,
  "order_updates_enabled" boolean DEFAULT false NOT NULL,
  "sync_requested_at" timestamptz,
  "sync_request_reason" text,
  "full_sync_requested_at" timestamptz,
  "last_sync_at" timestamptz,
  "last_reconcile_at" timestamptz,
  "problem_kind" text CHECK ("problem_kind" IN ('config','temporary')),
  "problem_code" text,
  "problem_message" text,
  "problem_at" timestamptz,
  "created_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_catalogue_link_single" ON "catalogue_link" ((true));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_batch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "catalogue_link"("id") ON DELETE CASCADE,
  "handle" text,
  "kind" text NOT NULL CHECK ("kind" IN ('changes','full','reconcile')),
  "item_count" integer NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL CHECK ("state" IN ('queued','open','finished','failed','lost')),
  "errors_total" integer,
  "checks" integer DEFAULT 0 NOT NULL,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "sent_at" timestamptz,
  "finished_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_batch_state" ON "catalogue_batch" ("state","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_item_sync" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "catalogue_link"("id") ON DELETE CASCADE,
  "retailer_id" text NOT NULL,
  "variant_id" uuid REFERENCES "product_variant"("id") ON DELETE SET NULL,
  "product_id" uuid REFERENCES "product"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "desired" jsonb,
  "desired_hash" text,
  "pushed_hash" text,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending','sent','live','rejected','blocked','removed')),
  "blocked_reason" text,
  "review_status" text,
  "problem_code" text,
  "problem_message" text,
  "batch_id" uuid REFERENCES "catalogue_batch"("id") ON DELETE SET NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "pushed_at" timestamptz,
  "checked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_catalogue_item_retailer" ON "catalogue_item_sync" ("link_id","retailer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_item_state" ON "catalogue_item_sync" ("link_id","state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_chat_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "wa_message_id" text NOT NULL UNIQUE,
  "catalog_id" text,
  "cart" jsonb NOT NULL,
  "cart_note" text,
  "state" text DEFAULT 'new' NOT NULL CHECK ("state" IN ('new','asked','awaiting_address','ready','placed','cancelled')),
  "fulfilment" text CHECK ("fulfilment" IN ('delivery','pickup')),
  "address" text,
  "next_prompt" text CHECK ("next_prompt" IN ('fulfilment','address','received')),
  "prompt_attempts" integer DEFAULT 0 NOT NULL,
  "idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
  "sale_order_id" uuid UNIQUE REFERENCES "sale_order"("id") ON DELETE SET NULL,
  "placed_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "payment_link_sent_at" timestamptz,
  "last_notified_status" text,
  "notify_attempts" integer DEFAULT 0 NOT NULL,
  "problem" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_chat_order_conv" ON "catalogue_chat_order" ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_chat_order_open" ON "catalogue_chat_order" ("state","updated_at");
