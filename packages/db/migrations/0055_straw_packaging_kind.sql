-- Straws become a first-class POS-consumed packaging kind (tracked-only, like
-- bags). ONLY add the enum value here. Postgres rejects using a freshly added
-- enum value inside the same transaction ("unsafe use of new value"), and
-- Drizzle runs ALL pending migrations in one transaction — so the "Straw"
-- material row is created by seed.ts (dev) and by the owner via the packaging
-- page (prod), never in a migration.
ALTER TYPE "packaging_material_kind" ADD VALUE IF NOT EXISTS 'straw';
