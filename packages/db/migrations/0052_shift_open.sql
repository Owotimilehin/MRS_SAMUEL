CREATE TABLE "shift_open" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "branch_id" uuid NOT NULL REFERENCES "branch"("id"),
  "business_date" date NOT NULL,
  "opened_by_user_id" uuid REFERENCES "admin_user"("id"),
  "opened_at" timestamptz,
  "notes" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "shift_open_branch_id_business_date_unique" UNIQUE("branch_id","business_date")
);

CREATE TABLE "shift_open_stock_count" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shift_open_id" uuid NOT NULL REFERENCES "shift_open"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "product"("id"),
  "system_quantity" integer NOT NULL,
  "counted_quantity" integer NOT NULL,
  "variance" integer NOT NULL,
  "variance_reason" text
);
