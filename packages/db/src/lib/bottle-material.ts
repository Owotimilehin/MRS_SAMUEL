import { eq, isNotNull, and, asc } from "drizzle-orm";
import type { DbExecutor } from "../client.js";
import { packagingMaterial } from "../schema/packaging-material.js";

/**
 * Returns the packaging_material id for the bottle of a given size, or null if
 * none exists. Bottles are the sized materials; matches on size_ml, lowest id
 * wins if duplicates exist. Accepts a transaction or the base client.
 */
export async function bottleMaterialIdForSize(
  db: DbExecutor,
  sizeMl: number,
): Promise<string | null> {
  const rows = await db
    .select({ id: packagingMaterial.id })
    .from(packagingMaterial)
    .where(and(eq(packagingMaterial.sizeMl, sizeMl), isNotNull(packagingMaterial.sizeMl)))
    .orderBy(asc(packagingMaterial.id))
    .limit(1);
  return rows[0]?.id ?? null;
}
