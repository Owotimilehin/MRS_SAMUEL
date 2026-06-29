/**
 * Owner/branch order-detail journey model.
 *
 * Turns an order's status into a compact, ordered timeline so staff can see at a
 * glance where an order is — the admin-side counterpart to the customer /track
 * page's deriveJourney. Kept as a pure, unit-tested helper so both admin detail
 * pages render the same thing without drift.
 *
 * Fulfilment paths (mirrors the server /advance transition map):
 *   delivery:  placed → paid → preparing → out_for_delivery → delivered
 *   pickup:    placed → paid → ready (handed_over) → collected (delivered)
 */

export type StepState = "done" | "current" | "upcoming";
export type FulfilmentTrack = "delivery" | "pickup";
export type JourneySpecial = "none" | "payment_hold" | "reconcile" | "cancelled";

export interface JourneyStep {
  key: string;
  label: string;
  state: StepState;
}

export interface OrderJourney {
  track: FulfilmentTrack;
  steps: JourneyStep[];
  /** Friendly label for the step the order is sitting on right now. */
  currentLabel: string;
  special: JourneySpecial;
}

export interface OrderJourneyInput {
  status: string;
  channel: string;
  isPreorder?: boolean | null;
  producedAt?: string | null;
  scheduledDeliveryAt?: string | null;
  deliveryState?: string | null;
  deliveryAddressFormatted?: string | null;
  deliveryFeeNgn?: number | null;
  delivery?: { status: string } | null;
}

export function isDeliveryOrder(o: OrderJourneyInput): boolean {
  return !!(
    o.deliveryAddressFormatted ||
    o.deliveryState ||
    (o.deliveryFeeNgn ?? 0) > 0 ||
    o.delivery
  );
}

export function deriveOrderJourney(o: OrderJourneyInput): OrderJourney {
  const track: FulfilmentTrack = isDeliveryOrder(o) ? "delivery" : "pickup";

  const special: JourneySpecial =
    o.status === "cancelled"
      ? "cancelled"
      : o.status === "confirmed"
        ? "payment_hold"
        : o.status === "reconcile_needed"
          ? "reconcile"
          : "none";

  // Payment is settled once the order has reached paid or any later fulfilment
  // state. confirmed / reconcile_needed / failed mean it is NOT yet settled.
  const paidDone = ["paid", "out_for_delivery", "handed_over", "delivered"].includes(o.status);
  const statusPastProduction =
    track === "delivery"
      ? ["out_for_delivery", "delivered"].includes(o.status)
      : ["handed_over", "delivered"].includes(o.status);
  // For a preorder the middle "production" step is only done once produced_at is
  // stamped (a paid-but-unproduced preorder is still being made). Non-preorders
  // keep the status-only rule.
  const dispatchedDone = o.isPreorder
    ? !!o.producedAt || statusPastProduction
    : statusPastProduction;
  const finishedDone = o.status === "delivered";

  // Middle step label depends on the path + scheduling/preorder context.
  let midLabel: string;
  if (track === "pickup") {
    midLabel = "Ready for pickup";
  } else if (o.scheduledDeliveryAt) {
    midLabel = "Scheduled";
  } else if (o.isPreorder) {
    midLabel = "In production";
  } else {
    midLabel = "Preparing";
  }

  const lastLabel = track === "pickup" ? "Collected" : "Delivered";
  const dispatchLabel = track === "delivery" ? "Out for delivery" : "Handed over";

  const raw: Array<{ key: string; label: string; done: boolean }> = [
    { key: "placed", label: "Placed", done: true },
    { key: "paid", label: "Paid", done: paidDone },
    { key: "mid", label: midLabel, done: dispatchedDone },
    { key: "dispatched", label: dispatchLabel, done: finishedDone },
    { key: "done", label: lastLabel, done: finishedDone },
  ];

  // For pickup the dispatch + final steps collapse (handed_over IS "ready",
  // delivered IS "collected"), so drop the redundant fourth step.
  const trimmed = track === "pickup" ? raw.filter((s) => s.key !== "dispatched") : raw;

  let currentAssigned = false;
  const steps: JourneyStep[] = trimmed.map((s) => {
    let state: StepState;
    if (s.done) {
      state = "done";
    } else if (!currentAssigned && special !== "cancelled") {
      state = "current";
      currentAssigned = true;
    } else {
      state = "upcoming";
    }
    return { key: s.key, label: s.label, state };
  });

  const current = steps.find((s) => s.state === "current");
  const currentLabel =
    special === "cancelled"
      ? "Cancelled"
      : special === "payment_hold"
        ? "Awaiting payment"
        : special === "reconcile"
          ? "Payment needs review"
          : (current?.label ?? lastLabel);

  return { track, steps, currentLabel, special };
}
