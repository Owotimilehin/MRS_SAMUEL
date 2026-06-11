-- Storefront product enrichment: per-flavour marketing content, colour palette,
-- and a reusable media library (bottle + decoration images) that products
-- reference. Backs the customer site's rich juice pages and the admin product
-- editor (palette pickers + image library). All product columns are added
-- nullable / with defaults so existing rows keep working.

CREATE TYPE "media_asset_kind" AS ENUM ('bottle', 'cluster', 'fruit', 'splash', 'leaf');

CREATE TABLE "media_asset" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"       "media_asset_kind" NOT NULL,
  "name"       text NOT NULL,
  "url"        text NOT NULL,
  "object_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_media_asset_kind" ON "media_asset" ("kind");

ALTER TABLE "product"
  ADD COLUMN "tagline"            text,
  ADD COLUMN "story"              text,
  ADD COLUMN "pairing"            text,
  ADD COLUMN "note"               text,
  ADD COLUMN "benefits"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "best_for"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "ingredient_details" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "palette"            jsonb,
  ADD COLUMN "bottle_asset_id"    uuid REFERENCES "media_asset" ("id"),
  ADD COLUMN "cluster_asset_id"   uuid REFERENCES "media_asset" ("id"),
  ADD COLUMN "fruit_asset_id"     uuid REFERENCES "media_asset" ("id");
