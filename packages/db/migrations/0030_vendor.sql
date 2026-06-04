CREATE TABLE "vendor" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"         text NOT NULL,
  "phone"        text,
  "email"        text,
  "notes"        text,
  "deleted_at"   timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "idx_vendor_name"    ON "vendor" ("name");
CREATE INDEX "idx_vendor_deleted" ON "vendor" ("deleted_at");

ALTER TABLE "business_expense"
  ADD COLUMN "vendor_id" uuid REFERENCES "vendor"("id");
