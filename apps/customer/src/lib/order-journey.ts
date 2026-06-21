export type Track = "live" | "scheduled" | "coordinated";
export type StepState = "done" | "current" | "upcoming";
export interface JourneyStep { key: string; label: string; state: StepState; at?: string }
export interface Journey {
  track: Track;
  steps: JourneyStep[];
  currentStep: JourneyStep;
  methodLabel: string;
  isPreorder: boolean;
  special: "none" | "payment_hold" | "reconcile" | "cancelled";
}
export interface TrackingOrderLike {
  status: string;
  payment_status: string;
  is_preorder: boolean;
  scheduled_delivery_at: string | null;
  delivery_state: string | null;
  paid_at: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  delivery: { status: string } | null;
}

const OTW_STATUSES = new Set(["picked_up", "in_transit", "out_for_delivery"]);

function pickTrack(o: TrackingOrderLike): Track {
  if (o.delivery_state && o.delivery_state !== "Lagos") return "coordinated";
  if (o.scheduled_delivery_at) return "scheduled";
  if (o.delivery) return "live";
  return "coordinated";
}

function midStep(track: Track): { key: string; label: string } {
  if (track === "scheduled") return { key: "scheduled", label: "Scheduled" };
  if (track === "live") return { key: "preparing", label: "Preparing" };
  return { key: "arranging", label: "Arranging + WhatsApp" };
}

function otwStep(track: Track): { key: string; label: string } {
  if (track === "scheduled") return { key: "out_for_delivery", label: "Out for delivery" };
  return { key: "on_the_way", label: "On the way" };
}

export function deriveJourney(o: TrackingOrderLike): Journey {
  const track = pickTrack(o);
  const special: Journey["special"] =
    o.status === "confirmed" ? "payment_hold"
    : o.status === "reconcile_needed" ? "reconcile"
    : o.status === "cancelled" ? "cancelled"
    : "none";

  const paidDone = o.payment_status === "paid";
  const otwDone = !!o.out_for_delivery_at || OTW_STATUSES.has(o.delivery?.status ?? "");
  const deliveredDone = o.status === "delivered";

  const mid = midStep(track);
  const otw = otwStep(track);
  const midLabel = o.is_preorder && mid.key !== "scheduled" ? "In production 🥤" : mid.label;

  const raw: Array<{ key: string; label: string; done: boolean; at?: string }> = [
    { key: "placed", label: "Placed", done: true, at: undefined },
    { key: "paid", label: "Paid", done: paidDone, at: o.paid_at ?? undefined },
    { key: mid.key, label: midLabel, done: otwDone || deliveredDone },
    { key: otw.key, label: otw.label, done: deliveredDone, at: o.out_for_delivery_at ?? undefined },
    { key: "delivered", label: "Delivered", done: deliveredDone, at: o.delivered_at ?? undefined },
  ];

  let currentAssigned = false;
  const steps: JourneyStep[] = raw.map((s) => {
    let state: StepState;
    if (s.done) state = "done";
    else if (!currentAssigned) { state = "current"; currentAssigned = true; }
    else state = "upcoming";
    return s.at ? { key: s.key, label: s.label, state, at: s.at } : { key: s.key, label: s.label, state };
  });
  const currentStep = steps.find((s) => s.state === "current") ?? steps[steps.length - 1]!;

  const methodLabel =
    track === "live" ? "Live rider"
    : track === "scheduled" ? "Scheduled delivery"
    : o.delivery_state && o.delivery_state !== "Lagos"
      ? `We'll arrange delivery to ${o.delivery_state}`
      : "We'll arrange your delivery";

  return { track, steps, currentStep, methodLabel, isPreorder: o.is_preorder, special };
}
