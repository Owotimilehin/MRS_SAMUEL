import Dexie, { type Table } from "dexie";

/**
 * Per-branch IndexedDB. Mirrors a slim subset of server tables, plus an
 * outbox table that drives the sync engine.
 *
 * Schema versioning: v1 is the only release so far. When you change shapes,
 * bump .version() and use .upgrade() to migrate existing devices.
 */

export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  ingredients: string[];
  is_active: boolean;
}

export interface PriceRow {
  id: string;
  product_id: string;
  price_ngn: number;
  valid_from: string;
  valid_to: string | null;
}

export interface LedgerRow {
  id: string;
  location_type: string;
  location_id: string;
  product_id: string;
  delta: number;
  source_type: string;
  source_id: string;
  recorded_at: string;
}

export interface IncomingTransferRow {
  id: string;
  transfer_number: string;
  status: string;
  updated_at: string;
}

export interface SaleRow {
  id: string;
  order_number: string;
  branch_id: string;
  channel: string;
  status: string;
  total_ngn: number;
  payment_method: string;
  created_at_local: string;
  idempotency_key: string;
}

export type OutboxStatus = "pending" | "in_flight" | "acknowledged" | "dead";

export interface OutboxRow {
  id: string;
  endpoint: string;
  method: "POST" | "PATCH";
  payload: unknown;
  depends_on?: string;
  attempt_count: number;
  next_attempt_at: number;
  last_error?: string;
  status: OutboxStatus;
  created_at_local: number;
  acknowledged_at?: number;
}

export interface ReservationRow {
  id: string;
  sale_order_id: string;
  product_id: string;
  quantity: number;
  expires_at: number;
}

export interface SyncMetaRow {
  id: "default";
  last_pull_at: string | null;
  branch_id: string | null;
}

export class BranchDB extends Dexie {
  products!: Table<ProductRow, string>;
  prices!: Table<PriceRow, string>;
  ledger!: Table<LedgerRow, string>;
  transfers!: Table<IncomingTransferRow, string>;
  sales!: Table<SaleRow, string>;
  outbox!: Table<OutboxRow, string>;
  reservations!: Table<ReservationRow, string>;
  meta!: Table<SyncMetaRow, "default">;

  constructor() {
    super("ms_branch");
    this.version(1).stores({
      products: "id, slug, category",
      prices: "id, product_id, valid_from",
      ledger: "id, [location_type+location_id+product_id], recorded_at",
      transfers: "id, status, updated_at",
      sales: "id, order_number, status, created_at_local, idempotency_key",
      outbox: "id, status, next_attempt_at, depends_on",
      reservations: "id, sale_order_id, product_id, expires_at",
      meta: "id",
    });
    // v2: index outbox.created_at_local so the queue page can `.orderBy()` it.
    // Without the index, BranchQueuePage threw "KeyPath created_at_local … is
    // not indexed" and crashed. Dexie rebuilds indexes on the version bump;
    // existing devices migrate automatically with no upgrade callback needed.
    this.version(2).stores({
      outbox: "id, status, next_attempt_at, depends_on, created_at_local",
    });
  }
}

export const local = new BranchDB();

/**
 * Compute available branch stock from local data — server ledger minus
 * active reservations. Used by the offline POS so the till can refuse
 * out-of-stock sales without a network call.
 */
export async function localAvailableForProduct(
  branchId: string,
  productId: string,
): Promise<number> {
  const ledgerRows = await local.ledger
    .where("[location_type+location_id+product_id]")
    .equals(["branch", branchId, productId])
    .toArray();
  const ledgerSum = ledgerRows.reduce((acc, r) => acc + r.delta, 0);

  const now = Date.now();
  const reservations = await local.reservations.where("product_id").equals(productId).toArray();
  const reserved = reservations
    .filter((r) => r.expires_at > now)
    .reduce((acc, r) => acc + r.quantity, 0);

  return ledgerSum - reserved;
}
