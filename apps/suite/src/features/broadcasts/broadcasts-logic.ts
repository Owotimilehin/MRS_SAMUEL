/** Pure wording and decisions for the Broadcasts screens (suite spec 14, 7.8 to 7.10). */
import {
  SKIP_REASONS,
  groupThousands,
  skipReasonText,
  stopReasonText,
  type BroadcastAudience,
  type BroadcastCounts,
  type BroadcastDetail,
  type BroadcastStatus,
  type BroadcastWaiting,
} from "@ms/shared";

export type Tone = "accent" | "success" | "warning" | "danger" | "ink";

/** Lagos is UTC+1 all year. */
const LAGOS_MS = 60 * 60_000;

/** "Fri 20 Nov, 14:05" in Lagos time. */
export function lagosWhen(isoText: string | null | undefined): string {
  if (!isoText) return "—";
  const t = Date.parse(isoText);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A "datetime-local" value typed as Lagos time ("2026-11-21T10:00") to an ISO time; null when it is not a time. */
export function lagosInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const t = Date.parse(`${value}:00+01:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The other way: an ISO time as a "datetime-local" value in Lagos time. */
export function isoToLagosInput(isoText: string | null | undefined): string {
  if (!isoText) return "";
  const t = Date.parse(isoText);
  if (Number.isNaN(t)) return "";
  return new Date(t + LAGOS_MS).toISOString().slice(0, 16);
}

/** 7.8: the status pill. */
export function statusPill(status: BroadcastStatus, scheduledAt: string | null): { label: string; tone: Tone } {
  switch (status) {
    case "draft":
      return { label: "Draft", tone: "ink" };
    case "scheduled":
      return { label: `Scheduled for ${lagosWhen(scheduledAt)}`, tone: "accent" };
    case "sending":
      return { label: "Sending", tone: "accent" };
    case "paused":
      return { label: "Paused", tone: "warning" };
    case "stopped":
      return { label: "Stopped", tone: "danger" };
    case "done":
      return { label: "Finished", tone: "success" };
    case "cancelled":
      return { label: "Cancelled", tone: "ink" };
  }
}

/** 7.8: "<sent> sent · <delivered> delivered · <read> read · <failed> failed". */
export function countsLine(c: Pick<BroadcastCounts, "sent" | "delivered" | "read" | "failed">): string {
  return `${groupThousands(c.sent)} sent · ${groupThousands(c.delivered)} delivered · ${groupThousands(c.read)} read · ${groupThousands(c.failed)} failed`;
}

/** 7.10: the red banner when the system stopped a broadcast, with what to do. */
export function stopBanner(reason: string | null, detail: string | null): { title: string; detail: string | null; todo: string } {
  const todo: Record<string, string> = {
    switched_off: "Switch broadcasts on in Broadcast settings, then press Resume.",
    quality: "Wait until the number's quality is back to normal, then press Resume.",
    template: "Check the template under Templates and forms. Resume once WhatsApp has approved it again.",
    account: "Open WhatsApp Manager to see why. Tes clears the block once it is fixed.",
    payment: "Fix the payment method in Meta Business Settings, then press Resume.",
    config: "Tell Tes. Nothing more goes out until it is fixed and someone presses Resume.",
    blanks: "Cancel this broadcast and make a new one with the blanks filled in.",
    failure_spike: "Check why messages were failing (below) before pressing Resume.",
    optout_spike: "Think about the message and the list before sending any more.",
    meta_busy: "Wait a while, then press Resume.",
    media_expired: "Cancel this broadcast and make a new one.",
    too_long: "Cancel this broadcast and make a smaller one.",
  };
  return { title: `Stopped: ${stopReasonText(reason)}`, detail, todo: todo[reason ?? ""] ?? "Press Resume when it is safe to continue." };
}

/** 7.10: the grey banner while a sending broadcast is waiting. */
export function waitingBanner(waiting: BroadcastWaiting, sendFrom: string): string | null {
  switch (waiting) {
    case "hours":
      return `Waiting for ${sendFrom}. Broadcasts only go out in the daytime.`;
    case "limit":
      return "Today's WhatsApp limit is used. It continues tomorrow.";
    case "warmup":
      return "Sent the first 20. Checking how they land before sending the rest (about 10 minutes).";
    case "slow_down":
      return "WhatsApp asked us to slow down. Sending continues in a few minutes.";
    default:
      return null;
  }
}

/** 7.9: the headline of the audience panel. */
export function audienceHeadline(a: Pick<BroadcastAudience, "counts">): string {
  const n = a.counts.will_send;
  return `${groupThousands(n)} of ${groupThousands(a.counts.list)} ${a.counts.list === 1 ? "person" : "people"} will get this message.`;
}

/** 7.9: one line per skip reason with its count, in the documented order. */
export function reasonLines(skipped: Record<string, number>, gapDays: number): { reason: string; count: number; text: string }[] {
  return SKIP_REASONS.filter((r) => (skipped[r] ?? 0) > 0).map((r) => ({
    reason: r,
    count: skipped[r]!,
    text: `${groupThousands(skipped[r]!)} · ${skipReasonText(r, gapDays)}`,
  }));
}

/** 7.9: how long it takes at the WhatsApp limit. */
export function estimateLine(perDay: number, days: number): string {
  return `Your WhatsApp limit lets you start ${groupThousands(perDay)} new conversations a day. This will take about ${days} day${days === 1 ? "" : "s"}.`;
}

/** The confirm box accepts only the exact number of people, typed as digits (commas and spaces allowed). */
export function confirmCountOk(typed: string, n: number): boolean {
  const digits = typed.replace(/[\s,]/g, "");
  return /^\d+$/.test(digits) && Number(digits) === n && n > 0;
}

/** 7.9: what the test panel says. */
export function testLine(test: BroadcastDetail["test"]): { text: string; tone: Tone } | null {
  if (!test) return null;
  if (test.status === "failed") return { text: "The test did not go. Check the number and send it again.", tone: "danger" };
  if (!test.matches) return { text: "You changed the message after the test. Send a new test.", tone: "warning" };
  if (!test.fresh) return { text: "The last test was more than a day ago. Send a new test.", tone: "warning" };
  if (test.status === "delivered" || test.status === "read") return { text: "Test delivered.", tone: "success" };
  return { text: `Test sent to ${test.to ?? "your number"}. Check your phone, then come back.`, tone: "success" };
}

/** Whether the last test covers the message as it stands (R44). */
export function testOk(test: BroadcastDetail["test"]): boolean {
  return !!test && test.matches && test.fresh && test.status !== "failed";
}

export interface ReviewState {
  enabled: boolean;
  nameOk: boolean;
  listChosen: boolean;
  templateOk: boolean;
  blanksOk: boolean;
  pictureOk: boolean;
  audience: Pick<BroadcastAudience, "counts" | "estimate"> | null;
  test: BroadcastDetail["test"];
  when: "now" | "scheduled";
  scheduleProblem: string | null;
}

/** 7.9: why "Review and send" is disabled, first reason first; null when it may be pressed. */
export function reviewBlocker(s: ReviewState): string | null {
  if (!s.nameOk) return "Give the broadcast a name.";
  if (!s.listChosen) return "Pick a list.";
  if (!s.templateOk) return "Pick a template that can be used.";
  if (!s.blanksOk) return "Fill in every blank.";
  if (!s.pictureOk) return "Add the picture.";
  if (!s.audience) return "Checking who will get it…";
  if (s.audience.counts.will_send < 1) return "Nobody on this list can be sent this message.";
  if (s.audience.estimate.days > 14) return `This would take ${s.audience.estimate.days > 900 ? "more than 14" : s.audience.estimate.days} days at your current WhatsApp limit. Choose a smaller list.`;
  if (!testOk(s.test)) return s.test && !s.test.matches ? "You changed the message after the test. Send a new test." : "Send a test first.";
  if (s.when === "scheduled" && s.scheduleProblem) return s.scheduleProblem;
  if (!s.enabled) return "Broadcasts are switched off.";
  return null;
}

/** "45%" of a total; "—" when there is nothing to divide by. */
export function shareOf(n: number, of: number): string {
  if (of <= 0) return "—";
  return `${Math.round((n / of) * 100)}%`;
}

/** 7.10 tiles, each with its share: of Sent, except Left out (of the list). */
export function resultTiles(c: BroadcastCounts & { list: number }): { key: string; label: string; value: number; share: string; help?: string }[] {
  return [
    { key: "sent", label: "Sent", value: c.sent, share: shareOf(c.sent, c.list - c.skipped) },
    { key: "delivered", label: "Delivered", value: c.delivered, share: shareOf(c.delivered, c.sent) },
    { key: "read", label: "Read", value: c.read, share: shareOf(c.read, c.sent) },
    { key: "replied", label: "Replied", value: c.replied, share: shareOf(c.replied, c.sent) },
    { key: "failed", label: "Failed", value: c.failed, share: shareOf(c.failed, c.sent + c.failed) },
    { key: "opted_out", label: "Asked to stop", value: c.opted_out, share: shareOf(c.opted_out, c.sent) },
    {
      key: "unknown",
      label: "Not confirmed",
      value: c.unknown,
      share: shareOf(c.unknown, c.sent + c.unknown),
      help: "We did not hear back from WhatsApp for these. They may have arrived. We do not send again.",
    },
    { key: "skipped", label: "Left out", value: c.skipped, share: shareOf(c.skipped, c.list) },
  ];
}

/** 7.10: the orders line. */
export function ordersLine(o: { days: number; people: number; orders: number; total_ngn: number }): string {
  return `${groupThousands(o.people)} of the people who got this ordered within ${o.days} days: ${groupThousands(o.orders)} order${o.orders === 1 ? "" : "s"}, ₦${groupThousands(o.total_ngn)}.`;
}

/** 7.10: the "What happened" line for an event. */
export function eventLine(e: { kind: string; detail: string | null; by_name: string | null }): string {
  const by = e.by_name ? ` by ${e.by_name}` : "";
  switch (e.kind) {
    case "confirmed":
      return `Confirmed${by}${e.detail ? ` (${e.detail})` : ""}`;
    case "started":
      return "Started";
    case "paused":
      return `Paused${by}`;
    case "resumed":
      return `Resumed${by}`;
    case "stopped":
      return `Stopped: ${stopReasonText((e.detail ?? "").split(":")[0] ?? null)}`;
    case "cancelled":
      return `Cancelled${by}`;
    case "finished":
      return "Finished";
    case "waiting_hours":
      return "Waiting for sending hours";
    case "waiting_limit":
      return "Waiting: today's WhatsApp limit was used";
    case "warmup":
      return "Sent the first 20, checking how they land";
    case "test":
      return `Test sent${by}`;
    default:
      return e.kind;
  }
}

/** The confirm dialog's sentence about when (7.9). */
export function whenText(when: "now" | "scheduled", scheduledAt: string | null): string {
  return when === "now" ? "now" : `on ${lagosWhen(scheduledAt)}`;
}

/** The plain words for a recipient's result. */
export const RESULT_LABEL: Record<string, string> = {
  pending: "Waiting",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  unknown: "Not confirmed",
  skipped: "Left out",
};

/** Quality rating in plain words (7.9 settings). */
export function qualityText(q: string | null | undefined): string {
  switch ((q ?? "").toUpperCase()) {
    case "GREEN":
      return "High";
    case "YELLOW":
      return "Medium";
    case "RED":
      return "Low";
    default:
      return "Not rated yet";
  }
}

/** Meta's marketing route in plain words (7.9 settings). */
export function mmText(mm: "ELIGIBLE" | "ONBOARDED" | null): string {
  return mm === "ONBOARDED" ? "On" : mm === "ELIGIBLE" ? "Available, not switched on" : "Not available yet";
}
