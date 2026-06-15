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

export interface VariantRow {
  id: string;
  product_id: string;
  size_ml: number;
  sku: string;
  is_active: boolean;
  // Always made-to-order: this size is sold as a prepaid preorder on any channel
  // (the till never blocks it on stock). Older devices may lack the field until
  // the next pull rewrites the row — read a missing value as false.
  preorder_only?: boolean;
}

export interface PriceRow {
  id: string;
  product_id: string;
  // The exact can size this price applies to. Older devices may carry rows
  // without it (legacy product-level pricing); the till treats a null variant
  // price as the product's fallback.
  variant_id: string | null;
  size_ml: number | null;
  price_ngn: number;
  valid_from: string;
  valid_to: string | null;
}

export interface LedgerRow {
  id: string;
  location_type: string;
  location_id: string;
  product_id: string;
  // The exact can size this movement applies to. Older rows (and legacy
  // opening balances) carry null — an "untyped" pool that counts toward any
  // size until it's reconciled to a specific variant.
  variant_id?: string | null;
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
  variants!: Table<VariantRow, string>;
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
    // v3: the till is now variant-aware. Add a `variants` mirror and index
    // prices by variant_id so a size selection maps to the right price. Dexie
    // adds the new store + index on the bump; existing price rows are missing
    // `variant_id`/`size_ml` until the next pull rewrites them, which is safe —
    // the till falls back to product-level pricing for legacy rows.
    this.version(3).stores({
      variants: "id, product_id, size_ml",
      prices: "id, product_id, variant_id, valid_from",
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

/**
 * Available stock for ONE can size at a branch. Size-tagged ledger rows for the
 * chosen variant, PLUS the product's untyped (variant-less) pool — that legacy
 * stock isn't assigned to a size yet, so it stays available to any size until
 * reconciled. A flavour whose stock is fully size-tagged is now enforced per
 * size: e.g. 96 on 330ml and 0 on 650ml means 650ml shows 0 and can't be sold.
 */
export async function localAvailableForVariant(
  branchId: string,
  productId: string,
  variantId: string,
): Promise<number> {
  const rows = await local.ledger
    .where("[location_type+location_id+product_id]")
    .equals(["branch", branchId, productId])
    .toArray();
  const sized = rows
    .filter((r) => r.variant_id === variantId)
    .reduce((acc, r) => acc + r.delta, 0);
  const untyped = rows
    .filter((r) => r.variant_id == null)
    .reduce((acc, r) => acc + r.delta, 0);

  const now = Date.now();
  const reservations = await local.reservations.where("product_id").equals(productId).toArray();
  // Reservations are per-flavour today, so they reduce the untyped pool side.
  const reserved = reservations
    .filter((r) => r.expires_at > now)
    .reduce((acc, r) => acc + r.quantity, 0);

  return sized + untyped - reserved;
}
