/**
 * Plain-English view of outbox rows the server turned down ("dead" rows).
 *
 * A sale rung up offline is two outbox rows: a Confirm (POST …/sales, row id =
 * sale id) and a Pay (PATCH …/sales/{saleId}/pay). If either is rejected the
 * customer has still paid but the sale is not fully on the system, so the till
 * must make that loud. These helpers are pure so they can be unit-tested.
 */

export interface FailureRowLike {
  id: string;
  endpoint: string;
  method: string;
  status: string;
  last_error?: string;
  last_error_status?: number;
}

const PAY_PATH = /\/sales\/([0-9a-f-]{36})\/pay$/i;
const CONFIRM_PATH = /\/branches\/[^/]+\/sales$/;

/** The sale id an outbox row belongs to, or null when it isn't a till sale. */
export function saleIdForOutboxRow(row: Pick<FailureRowLike, "id" | "endpoint" | "method">): string | null {
  if (row.method === "POST" && CONFIRM_PATH.test(row.endpoint)) return row.id;
  if (row.method === "PATCH") {
    const m = PAY_PATH.exec(row.endpoint);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * How many distinct SALES are stuck (a sale whose Confirm and Pay both failed
 * counts once), and how many other changes (shift counts etc.) failed.
 */
export function countFailures(rows: FailureRowLike[]): { sales: number; other: number } {
  const sales = new Set<string>();
  let other = 0;
  for (const r of rows) {
    if (r.status !== "dead") continue;
    const saleId = saleIdForOutboxRow(r);
    if (saleId) sales.add(saleId);
    else other += 1;
  }
  return { sales: sales.size, other };
}

/**
 * Turn the server's rejection into something a cashier can act on. Matches the
 * messages the API sends today (see apps/api/src/routes/sales.ts); anything
 * unknown falls back to a generic line plus the raw message so nothing is hidden.
 */
export function plainFailureReason(lastError: string | undefined, httpStatus?: number): string {
  const msg = (lastError ?? "").trim();
  const m = msg.toLowerCase();
  if (m.includes("insufficient stock")) return "Not enough stock on the system for this sale.";
  if (m.includes("open a shift") || m.includes("shift")) return "The shift was closed before this sale was sent.";
  if (m.includes("cannot pay from cancelled")) return "This sale was cancelled on the system, so the payment couldn't be added.";
  if (m.startsWith("cannot pay from")) return "The system already has this sale in a different state, so the payment couldn't be added.";
  if (m.includes("sale not found")) return "The system has no record of this sale, so the payment couldn't be added.";
  if (m.includes("no price")) return "A flavour or size in this sale has no price on the system.";
  if (m.includes("variant") || m.includes("no variant")) return "A flavour or size in this sale is no longer on the menu.";
  if (m.includes("only create preorders") || m.includes("only pay preorders") || m.includes("insufficient role") || httpStatus === 403) {
    return "This login isn't allowed to record this kind of sale. Ask a manager.";
  }
  if (m.includes("scheduled_delivery_at")) return "This preorder is missing a delivery date.";
  if (/^http 5\d\d$/.test(m)) return "The server kept failing after many tries.";
  return msg ? `The system turned this down: ${msg}` : "The system turned this down.";
}
