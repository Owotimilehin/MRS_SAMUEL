import { api } from "./api.js";
import { resyncStock } from "../sync/engine.js";

/**
 * Owner-only stock correction, shared by the Inventory page and the till.
 *
 * Both surfaces post the SAME audited, reason-required `/inventory/adjust`
 * mutation — the only thing this helper fixes is the scope: a branch. After the
 * server records the adjustment (an `adjustment` ledger row + audit + Telegram),
 * we resync the till's authoritative on-hand snapshot wholesale so availability
 * reflects server truth immediately and can never drift (no optimistic patch).
 */

export interface AdjustReason {
  value: string;
  label: string;
}

/** The fixed reason taxonomy the server's AdjustBody enum accepts. */
export const REASONS: AdjustReason[] = [
  { value: "physical_recount", label: "Physical recount" },
  { value: "damaged", label: "Damaged" },
  { value: "spoilage", label: "Spoilage" },
  { value: "theft", label: "Theft / loss" },
  { value: "found", label: "Found extra" },
  { value: "opening_balance", label: "Opening balance" },
  { value: "other_with_note", label: "Other (specify)" },
];

export interface AdjustBranchStockInput {
  branchId: string;
  productId: string;
  /** null targets the legacy untyped (variant-less) pool, mirroring the server. */
  variantId: string | null;
  newQuantity: number;
  reasonCode: string;
  reasonNote?: string;
}

/**
 * Set a branch's on-hand for one flavour+size to an absolute new count. Throws
 * a friendly Error if the till is offline (a correction must hit the server to
 * be authoritative — reads stay offline, only editing needs a connection). The
 * `api` call uses `silentError` so the caller renders its own inline message
 * (e.g. the would-go-negative case) instead of a redundant toast.
 */
export async function adjustBranchStock(input: AdjustBranchStockInput): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("You're offline — connect to the internet to edit stock.");
  }
  const note = input.reasonNote?.trim();
  await api(
    "/inventory/adjust",
    {
      method: "POST",
      body: JSON.stringify({
        location_type: "branch",
        location_id: input.branchId,
        reason_code: input.reasonCode,
        ...(note ? { reason_note: note } : {}),
        items: [
          {
            product_id: input.productId,
            variant_id: input.variantId,
            new_quantity: input.newQuantity,
          },
        ],
      }),
    },
    { silentError: true },
  );
  // Pull a fresh authoritative snapshot so the till's live availability updates.
  await resyncStock(input.branchId);
}
