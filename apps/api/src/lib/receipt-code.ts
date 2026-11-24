/**
 * Short receipt codes customers can quote at the counter.
 *
 * Every till sale gets a client-generated UUID that becomes the server's
 * sale_order.id. Before it syncs, the till has no SO-… order number, so the
 * receipt shows `R-` + the first 8 hex characters of that UUID instead
 * (e.g. "R-1A2B3C4D"). The branch Sales search accepts either form.
 *
 * Keep in step with apps/admin/src/lib/receipt-code.ts (the till side).
 */

const RECEIPT_CODE = /^R-?([0-9a-f]{8})$/i;
// Order numbers look like SO-2026-00123. Staff may type the whole thing or
// just the tail ("00123", "123"). Letters, digits and dashes only, so no LIKE
// wildcard (% or _) or quote can ever reach the query.
const ORDER_TERM = /^[A-Za-z0-9-]{1,32}$/;

export type SalesSearch =
  | { kind: "receipt"; idPrefix: string }
  | { kind: "order"; term: string };

/** Lower-case 8-hex id prefix for a receipt code like "R-1A2B3C4D", else null. */
export function parseReceiptCode(input: string): string | null {
  const m = RECEIPT_CODE.exec(input.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Classify a Sales-screen search. Returns null when the text is neither a
 * valid receipt code nor an order-number-shaped term (the route answers 400
 * rather than guessing).
 */
export function parseSalesSearch(raw: string): SalesSearch | null {
  const q = raw.trim();
  if (!q) return null;
  const idPrefix = parseReceiptCode(q);
  if (idPrefix) return { kind: "receipt", idPrefix };
  if (ORDER_TERM.test(q)) return { kind: "order", term: q };
  return null;
}
