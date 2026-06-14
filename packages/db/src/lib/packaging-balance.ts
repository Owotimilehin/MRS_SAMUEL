import { eq, and, sql } from "drizzle-orm";
import type { DbExecutor } from "../client.js";
import { packagingStockLedger } from "../schema/packaging-stock-ledger.js";

export interface PackagingLocation {
  locationType: "factory" | "branch";
  locationId: string;
}

/**
 * Current balance of one material at one location (factory or branch).
 * Bottles live at factories; bags can live at either.
 */
export async function packagingBalanceAt(
  db: DbExecutor,
  loc: PackagingLocation,
  materialId: string,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`COALESCE(SUM(${packagingStockLedger.delta}), 0)::int` })
    .from(packagingStockLedger)
    .where(
      and(
        eq(packagingStockLedger.locationType, loc.locationType),
        eq(packagingStockLedger.locationId, loc.locationId),
        eq(packagingStockLedger.packagingMaterialId, materialId),
      ),
    );
  return Number(row?.balance ?? 0);
}
