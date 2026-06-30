import { isDeliveryOrder, type OrderJourneyInput } from "./order-journey.js";

export type FulfilActionKind = "produce" | "advance" | "none";
export interface FulfilAction {
  kind: FulfilActionKind;
  label: string;
}

/**
 * The single next fulfilment action for an online order, shared by the owner and
 * branch detail pages so they never drift. A preorder that has not been produced
 * yet needs the produce step (calls the preorder fulfil endpoint); everything
 * else uses the channel-aware advance transition.
 */
export function nextFulfilAction(
  o: OrderJourneyInput & { producedAt?: string | null },
): FulfilAction {
  if (o.isPreorder && !o.producedAt && o.status === "paid") {
    return { kind: "produce", label: "Fulfil & produce" };
  }
  const delivery = isDeliveryOrder(o);
  if (o.status === "paid") {
    return { kind: "advance", label: delivery ? "Mark out for delivery" : "Mark ready for pickup" };
  }
  if (o.status === "out_for_delivery") return { kind: "advance", label: "Mark delivered" };
  if (o.status === "handed_over") return { kind: "advance", label: "Mark collected" };
  return { kind: "none", label: "" };
}
