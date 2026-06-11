import { pgTable, uuid, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";

/**
 * Reusable image library for the storefront. Bottles and decoration PNGs are
 * uploaded once (or seeded from the existing renders) and referenced by many
 * products — see product.bottleAssetId / clusterAssetId / fruitAssetId.
 *
 * `url` is what the storefront renders. For seeded local assets it is a
 * relative path under the customer app's /media/ (origin-independent, so the
 * value is portable across dev/prod); for admin uploads it is the absolute R2
 * URL and `objectKey` is the R2 key.
 */
export const mediaAssetKind = pgEnum("media_asset_kind", [
  "bottle",
  "cluster",
  "fruit",
  "splash",
  "leaf",
]);

export const mediaAsset = pgTable(
  "media_asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: mediaAssetKind("kind").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    objectKey: text("object_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxKind: index("idx_media_asset_kind").on(t.kind),
  }),
);
