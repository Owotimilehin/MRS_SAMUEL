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
  // Bottle image shown on the till's flavour card. Synced from product.imageUrl;
  // older devices may lack it until the next pull rewrites the row.
  image_url?: string | null;
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

/**
 * Authoritative current on-hand for one flavour+size at the branch, as last
 * pulled from the server (`SUM(delta)` over the server ledger). Replaced
 * wholesale on every successful pull, so a server-side correction or wipe
 * always propagates here — the till never accumulates phantom stock. The
 * offline POS reads availability from this snapshot MINUS its own un-synced
 * optimistic sale rows, never by replaying a growing local ledger.
 */
export interface StockRow {
  // `${product_id}::${variant_id ?? ""}` — one row per flavour+size pool.
  id: string;
  product_id: string;
  // null = the legacy "untyped" pool not yet assigned to a size; counts toward
  // any size, mirroring the ledger's untyped handling.
  variant_id: string | null;
  qty: number;
  synced_at: string;
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
  opened_today?: boolean;
}

export interface ShiftOpenMarkerRow {
  // `${branch_id}::${business_date}`
  id: string;
  branch_id: string;
  business_date: string;
  opened_at: string;
}

/**
 * One row per branch: tracks whether this device believes there is currently
 * an open shift. Written by fileLocalShiftOpen / fileLocalShiftClose and
 * mirrored from the server's open_shift in each /sync/pull response so that
 * a newly-installed device or a second till heals without a manual action.
 */
export interface CurrentShiftRow {
  /** Primary key: the branch id. */
  branchId: string;
  /** Server-assigned shift id, present once a shift has been acknowledged. */
  shiftLocalId?: string;
  /** ISO timestamp when the shift was opened (local or server). */
  openedAt?: string;
  status: "open" | "closed";
}

export class BranchDB extends Dexie {
  products!: Table<ProductRow, string>;
  variants!: Table<VariantRow, string>;
  prices!: Table<PriceRow, string>;
  ledger!: Table<LedgerRow, string>;
  stock!: Table<StockRow, string>;
  transfers!: Table<IncomingTransferRow, string>;
  sales!: Table<SaleRow, string>;
  outbox!: Table<OutboxRow, string>;
  reservations!: Table<ReservationRow, string>;
  meta!: Table<SyncMetaRow, "default">;
  shiftOpenMarker!: Table<ShiftOpenMarkerRow, string>;
  currentShift!: Table<CurrentShiftRow, string>;

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
    // v4: availability now derives from a server-authoritative `stock` snapshot
    // (replaced wholesale each pull), not from replaying the local ledger. Add
    // the snapshot store, and one-time-heal existing tills: clear the old
    // accumulated server ledger rows (these could hold phantom stock a
    // server-side wipe/correction never reached — see the 130-in-stock bug) and
    // reset the pull cursor so the next sync re-fetches a full snapshot. The
    // ledger now only ever holds the till's own un-synced optimistic sale rows.
    this.version(4)
      .stores({
        stock: "id, product_id",
      })
      .upgrade(async (tx) => {
        await tx.table("ledger").clear();
        const meta = await tx.table("meta").get("default");
        if (meta) await tx.table("meta").put({ ...meta, last_pull_at: null });
      });
    // v5: open-gate marker. Records, per (branch, business_date), that an
    // opening count was filed ON THIS DEVICE — unlocks the till offline and
    // survives logout (only "Refresh app" / local.delete() clears it).
    this.version(5).stores({
      shiftOpenMarker: "id, branch_id, business_date",
    });
    // v6: currentShift table. One row per branchId tracking open/closed state.
    // Populated by fileLocalShiftOpen / fileLocalShiftClose and mirrored from
    // the server's open_shift in each /sync/pull so second devices heal. No
    // destructive clears — existing data is unaffected; new rows are created
    // lazily on the next open/close or pull.
    this.version(6).stores({
      currentShift: "branchId",
    });
  }
}

export const local = new BranchDB();

/** Sum the till's own un-synced optimistic sale rows for a product (negative). */
async function optimisticDeltaForProduct(
  branchId: string,
  productId: string,
): Promise<{ sized: Map<string, number>; untyped: number; total: number }> {
  const rows = await local.ledger
    .where("[location_type+location_id+product_id]")
    .equals(["branch", branchId, productId])
    .toArray();
  const sized = new Map<string, number>();
  let untyped = 0;
  let total = 0;
  for (const r of rows) {
    total += r.delta;
    if (r.variant_id == null) untyped += r.delta;
    else sized.set(r.variant_id, (sized.get(r.variant_id) ?? 0) + r.delta);
  }
  return { sized, untyped, total };
}

async function reservedForProduct(productId: string): Promise<number> {
  const now = Date.now();
  const reservations = await local.reservations.where("product_id").equals(productId).toArray();
  return reservations.filter((r) => r.expires_at > now).reduce((acc, r) => acc + r.quantity, 0);
}

/**
 * Compute available branch stock for the offline POS:
 *   server snapshot (authoritative on-hand) + this till's un-synced optimistic
 *   sale rows (negative) − active reservations.
 * The snapshot is overwritten wholesale on every pull, so this self-heals after
 * any server-side correction/wipe; the only local rows left in the ledger are
 * the till's own sales that the server hasn't acknowledged yet.
 */
export async function localAvailableForProduct(
  branchId: string,
  productId: string,
): Promise<number> {
  const snapRows = await local.stock.where("product_id").equals(productId).toArray();
  const snapshot = snapRows.reduce((acc, r) => acc + r.qty, 0);
  const { total: optimistic } = await optimisticDeltaForProduct(branchId, productId);
  const reserved = await reservedForProduct(productId);
  return snapshot + optimistic - reserved;
}

/**
 * Available stock for ONE can size at a branch. Size-tagged snapshot for the
 * chosen variant, PLUS the product's untyped (variant-less) pool — that legacy
 * stock isn't assigned to a size yet, so it stays available to any size until
 * reconciled. A flavour whose stock is fully size-tagged is enforced per size:
 * e.g. 96 on 330ml and 0 on 650ml means 650ml shows 0 and can't be sold. The
 * till's own un-synced optimistic sale rows are layered on top.
 */
export async function localAvailableForVariant(
  branchId: string,
  productId: string,
  variantId: string,
): Promise<number> {
  const snapRows = await local.stock.where("product_id").equals(productId).toArray();
  const snapSized = snapRows
    .filter((r) => r.variant_id === variantId)
    .reduce((acc, r) => acc + r.qty, 0);
  const snapUntyped = snapRows
    .filter((r) => r.variant_id == null)
    .reduce((acc, r) => acc + r.qty, 0);

  const opt = await optimisticDeltaForProduct(branchId, productId);
  // Reservations are per-flavour today, so they reduce the untyped pool side.
  const reserved = await reservedForProduct(productId);

  return snapSized + snapUntyped + (opt.sized.get(variantId) ?? 0) + opt.untyped - reserved;
}
