/**
 * Short receipt codes customers can quote at the counter.
 *
 * A till sale's client-generated UUID IS the server's sale id, so a code made
 * from it can always be found later: `R-` + the first 8 hex characters,
 * upper-cased ("R-1A2B3C4D"). It is printed on the receipt while the sale has
 * no server SO-… number yet; the branch Sales search accepts either form.
 *
 * Keep in step with apps/api/src/lib/receipt-code.ts (the server side).
 */

const RECEIPT_CODE = /^R-?([0-9a-f]{8})$/i;
const ORDER_TERM = /^[A-Za-z0-9-]{1,32}$/;

/** "R-1A2B3C4D" for sale id "1a2b3c4d-…". */
export function receiptCodeFromSaleId(saleId: string): string {
  return `R-${saleId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** Lower-case 8-hex id prefix for a receipt code, or null if it isn't one. */
export function parseReceiptCode(input: string): string | null {
  const m = RECEIPT_CODE.exec(input.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * True when the text is something the Sales search will accept: a receipt
 * code or an order number / tail of one (letters, digits, dashes).
 */
export function isValidSalesSearch(input: string): boolean {
  const q = input.trim();
  return q.length > 0 && (parseReceiptCode(q) !== null || ORDER_TERM.test(q));
}

/** A real server order number (SO-2026-00123), as opposed to a till placeholder. */
export function isServerOrderNumber(orderNumber: string | null | undefined): boolean {
  return !!orderNumber && /^SO-/i.test(orderNumber);
}
