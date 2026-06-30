-- variance_loss: durable record of genuine stock write-offs (bottles + retail
-- value). Written when an owner settles a transfer variance as "loss" or a
-- shift close counts short. Valued at the variant's retail price, snapshotted
-- so later price changes don't rewrite loss history.
CREATE TYPE "variance_loss_source" AS ENUM('transfer', 'shift_close');

CREATE TABLE "variance_loss" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" "variance_loss_source" NOT NULL,
  "source_id" uuid NOT NULL,
  "branch_id" uuid NOT NULL REFERENCES "branch"("id"),
  "product_id" uuid NOT NULL REFERENCES "product"("id"),
  "variant_id" uuid REFERENCES "product_variant"("id"),
  "size_ml" integer,
  "quantity" integer NOT NULL,
  "unit_price_ngn" integer NOT NULL,
  "value_ngn" integer NOT NULL,
  "reason" text,
  "recorded_by_user_id" uuid REFERENCES "admin_user"("id"),
  "occurred_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "idx_variance_loss_occurred" ON "variance_loss" ("occurred_at");
CREATE INDEX "idx_variance_loss_branch_occurred" ON "variance_loss" ("branch_id","occurred_at");

-- New ledger source for owner-settled transfer variance. Only ADD the value
-- here; Postgres rejects USING a freshly added enum value in the same
-- transaction, and Drizzle runs all pending migrations in one transaction.
-- This value is used only at runtime (transfer settlement), never in a migration.
ALTER TYPE "ledger_source_type" ADD VALUE IF NOT EXISTS 'transfer_variance_settlement';
