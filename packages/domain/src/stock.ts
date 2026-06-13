import { sql, and, eq } from "drizzle-orm";
import { stockLedger, type DbExecutor } from "@ms/db";

/**
 * Per-variant balance at a location. Returns one row per `(productId, variantId)`
 * bucket, so legacy NULL-variant rows form their own bucket and never merge with
 * sized rows. Balances are >= 0 (the per-variant trigger guarantees it).
 */
export async function balanceByVariantAt(
  db: DbExecutor,
  opts: { locationType: "factory" | "branch"; locationId: string; productId?: string },
): Promise<Array<{ productId: string; variantId: string | null; balance: number }>> {
  const where = [
    eq(stockLedger.locationType, opts.locationType),
    eq(stockLedger.locationId, opts.locationId),
  ];
  if (opts.productId) where.push(eq(stockLedger.productId, opts.productId));

  const rows = await db
    .select({
      productId: stockLedger.productId,
      variantId: stockLedger.variantId,
      balance: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)`.as("balance"),
    })
    .from(stockLedger)
    .where(and(...where))
    .groupBy(stockLedger.productId, stockLedger.variantId);

  return rows.map((r) => ({
    productId: r.productId,
    variantId: r.variantId,
    balance: Number(r.balance),
  }));
}

/**
 * Per-flavour roll-up (sum across all sizes incl. the NULL bucket). Kept for
 * callers that only need a flavour total (e.g. transfers, which are still
 * flavour-grain in Phase 1).
 */
export async function balanceAt(
  db: DbExecutor,
  opts: { locationType: "factory" | "branch"; locationId: string; productId?: string },
): Promise<Record<string, number>> {
  const rows = await balanceByVariantAt(db, opts);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.productId] = (out[r.productId] ?? 0) + r.balance;
  return out;
}

/**
 * Check whether the factory has enough of each requested product to dispatch
 * a transfer. Returns ok=true OR a list of insufficient lines.
 *
 * MUST be called inside the same transaction that subsequently writes the
 * dispatch ledger rows — otherwise a concurrent dispatch could race.
 */
export async function checkFactoryStockAvailable(
  db: DbExecutor,
  factoryId: string,
  items: { productId: string; quantity: number }[],
): Promise<
  | { ok: true }
  | {
      ok: false;
      insufficient: { productId: string; available: number; requested: number }[];
    }
> {
  const balances = await balanceAt(db, { locationType: "factory", locationId: factoryId });
  const insufficient = items
    .map((it) => ({
      productId: it.productId,
      available: balances[it.productId] ?? 0,
      requested: it.quantity,
    }))
    .filter((x) => x.available < x.requested);
  return insufficient.length === 0 ? { ok: true } : { ok: false, insufficient };
}

/**
 * Mint the next transfer number from the postgres sequence created in
 * migration 0009. Format: TRF-{YYYY}-{NNNNN}
 *
 * Must be called inside the dispatch transaction so the number is bound
 * to the same row that uses it.
 */
export async function nextTransferNumber(db: DbExecutor): Promise<string> {
  const rows = await db.execute<{ nextval: string | number }>(
    sql`SELECT nextval('stock_transfer_seq') AS nextval`,
  );
  const value = rows[0]?.["nextval"];
  if (value === undefined) {
    throw new Error("stock_transfer_seq returned no value");
  }
  const seq = String(value).padStart(5, "0");
  const year = new Date().getFullYear();
  return `TRF-${year}-${seq}`;
}
