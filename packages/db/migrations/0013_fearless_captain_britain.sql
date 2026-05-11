DO $$ BEGIN
 CREATE TYPE "public"."return_disposition" AS ENUM('restocked', 'wasted', 'replaced');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."return_reason_category" AS ENUM('changed_mind', 'wrong_flavor', 'wrong_item', 'quality_issue', 'damaged_on_arrival', 'delivery_failed', 'other_with_note');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."return_refund_method" AS ENUM('cash', 'card_reversal', 'transfer', 'store_credit', 'replacement', 'glovo_external', 'chowdeck_external', 'none');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."return_status" AS ENUM('draft', 'pending_approval', 'completed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_ngn" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_number" text NOT NULL,
	"original_sale_order_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" "return_status" DEFAULT 'draft' NOT NULL,
	"reason_category" "return_reason_category" NOT NULL,
	"reason_note" text,
	"refund_method" "return_refund_method" NOT NULL,
	"refund_amount_ngn" integer NOT NULL,
	"created_by_user_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"idempotency_key" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_return_return_number_unique" UNIQUE("return_number"),
	CONSTRAINT "sale_return_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_return_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_return_id" uuid NOT NULL,
	"sale_order_item_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_returned" integer NOT NULL,
	"unit_refund_ngn" integer NOT NULL,
	"disposition" "return_disposition" NOT NULL,
	"photo_urls" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_credit" ADD CONSTRAINT "customer_credit_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_original_sale_order_id_sale_order_id_fk" FOREIGN KEY ("original_sale_order_id") REFERENCES "public"."sale_order"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_created_by_user_id_admin_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_approved_by_user_id_admin_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_sale_return_id_sale_return_id_fk" FOREIGN KEY ("sale_return_id") REFERENCES "public"."sale_return"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_sale_order_item_id_sale_order_item_id_fk" FOREIGN KEY ("sale_order_item_id") REFERENCES "public"."sale_order_item"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_return_item" ADD CONSTRAINT "sale_return_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
