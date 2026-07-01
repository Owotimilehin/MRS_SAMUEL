ALTER TABLE "payment" ADD COLUMN "fee_ngn" integer;
ALTER TABLE "payment" ADD COLUMN "gross_ngn" integer;
ALTER TABLE "payment" ADD COLUMN "net_ngn" integer;
ALTER TABLE "payment" ADD COLUMN "raw_breakdown" jsonb;
ALTER TABLE "sale_order" ADD COLUMN "fee_shortfall_ngn" integer;
