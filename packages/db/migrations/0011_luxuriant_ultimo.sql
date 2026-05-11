DO $$ BEGIN
 CREATE TYPE "public"."customer_source" AS ENUM('walkup_anonymous', 'online', 'phone', 'glovo', 'chowdeck');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."payment_method" AS ENUM('cash', 'card', 'transfer', 'glovo_external', 'chowdeck_external', 'replacement');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sale_channel" AS ENUM('walkup', 'online', 'phone', 'glovo_pickup', 'chowdeck_pickup');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sale_status" AS ENUM('draft', 'confirmed', 'paid', 'handed_over', 'delivered', 'failed', 'cancelled', 'reconcile_needed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"phone" text,
	"email" text,
	"default_address" text,
	"source" "customer_source" DEFAULT 'walkup_anonymous' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"channel" "sale_channel" NOT NULL,
	"customer_id" uuid,
	"status" "sale_status" DEFAULT 'draft' NOT NULL,
	"subtotal_ngn" integer NOT NULL,
	"delivery_fee_ngn" integer DEFAULT 0 NOT NULL,
	"total_ngn" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at_local" timestamp with time zone NOT NULL,
	"created_by_user_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"external_reference" text,
	"notes" text,
	"cancel_reason" text,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_order_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "sale_order_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_order_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_price_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_ngn" integer NOT NULL,
	"line_total_ngn" integer NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_order_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_ngn" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"processor" text,
	"processor_reference" text,
	"paid_at" timestamp with time zone,
	"collected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_order_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_created_by_user_id_admin_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_cancelled_by_user_id_admin_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order_item" ADD CONSTRAINT "sale_order_item_sale_order_id_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order_item" ADD CONSTRAINT "sale_order_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sale_order_item" ADD CONSTRAINT "sale_order_item_product_price_id_product_price_id_fk" FOREIGN KEY ("product_price_id") REFERENCES "public"."product_price"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment" ADD CONSTRAINT "payment_sale_order_id_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment" ADD CONSTRAINT "payment_collected_by_user_id_admin_user_id_fk" FOREIGN KEY ("collected_by_user_id") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_sale_order_id_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_order"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reservation_branch_product" ON "stock_reservation" USING btree ("branch_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reservation_expires" ON "stock_reservation" USING btree ("expires_at");