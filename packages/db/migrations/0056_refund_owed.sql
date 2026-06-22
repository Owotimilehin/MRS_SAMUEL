-- Tracks a refund the business owes a customer after a payment-reconciliation
-- mismatch (e.g. Payaza charged the customer but the webhook/verify never
-- confirmed it, or a duplicate charge was detected). Nullable: most orders
-- never owe a refund, so absence of a value means "no refund owed".
ALTER TABLE "sale_order" ADD COLUMN "refund_owed_ngn" integer;
