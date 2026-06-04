CREATE TYPE "business_expense_category" AS ENUM (
  'raw_materials','packaging','utilities','transport','salaries',
  'rent','marketing','equipment','regulatory','other_with_note'
);

CREATE TABLE "business_expense" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "expense_date"          date NOT NULL,
  "category_code"         "business_expense_category" NOT NULL,
  "amount_ngn"            integer NOT NULL,
  "vendor_name"           text,
  "description"           text,
  "reason_note"           text,
  "receipt_url"           text,
  "recorded_by_user_id"   uuid REFERENCES "admin_user"("id"),
  "deleted_at"            timestamptz,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_business_expense_date"      ON "business_expense" ("expense_date");
CREATE INDEX "idx_business_expense_category"  ON "business_expense" ("category_code");
CREATE INDEX "idx_business_expense_deleted"   ON "business_expense" ("deleted_at");
