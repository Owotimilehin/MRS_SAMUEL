import { isDeliveryOrder, type OrderJourneyInput } from "./order-journey.js";

export type OrderActionId =
  | "recheck_payment"
  | "accept_paid"
  | "produce"
  | "book_rider"
  | "advance"
  | "rebook_rider"
  | "force_delivered"
  | "mark_refunded"
  | "cancel_refund";

export interface OrderActionButton {
  id: OrderActionId;
  label: string;
}

export interface OrderActions {
  primary: OrderActionButton | null;
  secondary: OrderActionButton[];
  danger: OrderActionButton[];
}

export interface OrderActionsInput extends OrderJourneyInput {
  producedAt?: string | null;
  refundOwedNgn?: number | null;
}

const LIVE_RIDE = new Set(["searching_rider", "assigned", "picked_up", "in_transit"]);
const FAILED_RIDE = new Set(["failed", "cancelled"]);
const SETTLED = new Set(["paid", "out_for_delivery", "handed_over", "delivered"]);

/**
 * The single source of truth for what an admin can do on an online order,
 * shared by the owner + branch detail pages so they never drift. Returns
 * every *applicable* action for the order's current state; the pages filter
 * by capability (`orders.manage` / `orders.accept_payment` / `pos.sell`).
 * Deliberately capability-free so it stays a pure, exhaustively-tested unit.
 */
export function deriveOrderActions(o: OrderActionsInput): OrderActions {
  const secondary: OrderActionButton[] = [];
  const danger: OrderActionButton[] = [];
  let primary: OrderActionButton | null = null;

  const status = o.status;
  const terminal = status === "delivered" || status === "cancelled";
  const delivery = isDeliveryOrder(o);
  const rideStatus = o.delivery?.status ?? null;
  const rideLive = rideStatus != null && LIVE_RIDE.has(rideStatus);
  const rideFailed = rideStatus != null && FAILED_RIDE.has(rideStatus);
  const unsettled = status === "confirmed" || status === "reconcile_needed";

  // Refund owed is orthogonal to status.
  if ((o.refundOwedNgn ?? 0) > 0) {
    secondary.push({ id: "mark_refunded", label: "Mark refunded" });
  }

  if (terminal) {
    return { primary, secondary, danger };
  }

  // Cancel & refund — pre-dispatch only.
  if (unsettled || status === "paid") {
    danger.push({ id: "cancel_refund", label: "Cancel & mark refund owed" });
  }

  // ── Primary CTA priority (first match wins) ──
  if (unsettled) {
    primary = { id: "recheck_payment", label: "↻ Re-check payment" };
    secondary.push({ id: "accept_paid", label: "Accept as paid" });
    return { primary, secondary, danger };
  }

  if (rideFailed) {
    primary = { id: "rebook_rider", label: "↻ Re-book rider" };
    return { primary, secondary, danger };
  }

  if (o.isPreorder && !o.producedAt && status === "paid") {
    primary = { id: "produce", label: "Fulfil & produce" };
    return { primary, secondary, danger };
  }

  if (status === "paid") {
    if (!delivery) {
      primary = { id: "advance", label: "Mark ready for pickup" };
    } else if (rideLive) {
      primary = null; // webhook/poller drives the transition
    } else {
      primary = { id: "book_rider", label: "Book rider" };
      secondary.push({ id: "advance", label: "Mark out for delivery" });
    }
    return { primary, secondary, danger };
  }

  if (status === "out_for_delivery") {
    if (!rideLive) primary = { id: "advance", label: "Mark delivered" };
    secondary.push({ id: "force_delivered", label: "Force delivered (fallback)" });
    return { primary, secondary, danger };
  }

  if (status === "handed_over") {
    primary = { id: "advance", label: "Mark collected" };
    return { primary, secondary, danger };
  }

  return { primary, secondary, danger };
}
