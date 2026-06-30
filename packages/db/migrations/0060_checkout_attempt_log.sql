CREATE TABLE IF NOT EXISTS "checkout_attempt_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" text NOT NULL,
  "stage" text NOT NULL,
  "status" text NOT NULL,
  "order_number" text,
  "customer_name" text,
  "customer_phone" text,
  "customer_email" text,
  "delivery_address" text,
  "delivery_state" text,
  "delivery_window" text,
  "scheduled_for" timestamp with time zone,
  "items_json" jsonb,
  "total_ngn" integer,
  "error_message" text,
  "response_json" jsonb,
  "user_agent" text,
  "ip_address" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_checkout_log_attempt" ON "checkout_attempt_log" ("attempt_id");
CREATE INDEX IF NOT EXISTS "idx_checkout_log_created" ON "checkout_attempt_log" ("created_at");
