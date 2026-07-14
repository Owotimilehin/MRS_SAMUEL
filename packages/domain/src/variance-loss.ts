import { eq, and, desc, isNull } from "drizzle-orm";
import { varianceLoss, productPrice, type DbExecutor } from "@ms/db";

/** Pure: money value of a loss (bottles * retail price). */
export function computeLossValue(quantity: number, unitPriceNgn: number): number {
  return quantity * unitPriceNgn;
}

export interface RecordVarianceLossInput {
  source: "transfer" | "shift_close" | "shift_open";
  sourceId: string;
  branchId: string;
  productId: string;
  variantId: string | null;
  sizeMl: number | null;
  quantity: number; // bottles lost, positive
  reason: string | null;
  recordedByUserId: string;
}

/**
 * Snapshot the variant's current retail price and insert one variance_loss row.
 * Price is captured at record time so later price changes don't rewrite history.
 */
export async function recordVarianceLoss(
  tx: DbExecutor,
  input: RecordVarianceLossInput,
): Promise<{ id: string; valueNgn: number }> {
  // Retail price for valuation: by variant when the loss is variant-specific,
  // else the product's active price (product-level transfers carry no variant).
  // Active = valid_to IS NULL, most recent valid_from.
  const priceCond = input.variantId
    ? eq(productPrice.variantId, input.variantId)
    : eq(productPrice.productId, input.productId);
  const [p] = await tx
    .select({ priceNgn: productPrice.priceNgn })
    .from(productPrice)
    .where(and(priceCond, isNull(productPrice.validTo)))
    .orderBy(desc(productPrice.validFrom))
    .limit(1);
  const unitPriceNgn = p?.priceNgn ?? 0;
  const valueNgn = computeLossValue(input.quantity, unitPriceNgn);
  const [row] = await tx
    .insert(varianceLoss)
    .values({
      source: input.source,
      sourceId: input.sourceId,
      branchId: input.branchId,
      productId: input.productId,
      variantId: input.variantId,
      sizeMl: input.sizeMl,
      quantity: input.quantity,
      unitPriceNgn,
      valueNgn,
      reason: input.reason,
      recordedByUserId: input.recordedByUserId,
    })
    .returning({ id: varianceLoss.id });
  if (!row) throw new Error("variance_loss insert returned no row");
  return { id: row.id, valueNgn };
}
