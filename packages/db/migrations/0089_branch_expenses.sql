-- Branch expenses. Additive only: one nullable column on business_expense and
-- one index. No default and no NOT NULL, so Postgres only updates the catalogue
-- (no table rewrite) and every existing row reads as null = head office.
-- Safe to run twice (IF NOT EXISTS everywhere).
--   business_expense.branch_id  the shop the money was spent at; null = head office
-- Undo: DROP INDEX "idx_business_expense_branch";
--       ALTER TABLE "business_expense" DROP COLUMN "branch_id";

ALTER TABLE "business_expense" ADD COLUMN IF NOT EXISTS "branch_id" uuid REFERENCES "branch"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_expense_branch" ON "business_expense" ("branch_id", "expense_date") WHERE "branch_id" IS NOT NULL;
