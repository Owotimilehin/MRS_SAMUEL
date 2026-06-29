import { lineTarget, type DeliveryWindow } from "@ms/shared";
import type { Size } from "@/lib/visuals";

const LAGOS_OFFSET_MS = 3_600_000; // UTC+1, no DST
const WINDOW_LABEL: Record<DeliveryWindow, string> = {
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
};

const sizeToMl = (size: Size): number => parseInt(size, 10);

function lagosDateStr(d: Date): string {
  const l = new Date(d.getTime() + LAGOS_OFFSET_MS);
  const y = l.getUTCFullYear();
  const m = String(l.getUTCMonth() + 1).padStart(2, "0");
  const day = String(l.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * An order is "immediate" — it goes out today as soon as possible, so there is
 * no window to pick — when its computed schedule lands today (Lagos) with no
 * fixed window. A fixed window means a preorder/scheduled slot; a future date
 * means it can't go out today. Both keep the schedule picker/line.
 */
export function isImmediateSchedule(
  sched: { date: string; fixedWindow?: DeliveryWindow },
  now: Date = new Date(),
): boolean {
  return !sched.fixedWindow && sched.date === lagosDateStr(now);
}

/**
 * Reassuring delivery promise for a size given its on-hand count. Out-of-stock
 * items are NOT framed as "preorder / made to order / days away" — they still
 * arrive fast (a stocked-out 650ml is "today, evening"; 330ml is "tomorrow").
 */
export function deliveryPromise(size: Size, available: number, now: Date = new Date()): string {
  const inStock = available > 0;
  const t = lineTarget(now, { sizeMl: sizeToMl(size), inStock });

  const today = lagosDateStr(now);
  const tomorrow = lagosDateStr(new Date(now.getTime() + 86_400_000));
  let day: string;
  if (t.date === today) day = "today";
  else if (t.date === tomorrow) day = "tomorrow";
  else {
    day = new Date(`${t.date}T12:00:00+01:00`).toLocaleDateString("en-NG", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "Africa/Lagos",
    });
  }

  const win = t.fixedWindow ? ` (${WINDOW_LABEL[t.fixedWindow]})` : "";
  return `Get it ${day}${inStock ? "" : win}`;
}

/** Real branch stock count line, e.g. "12 in stock". Null when out of stock. */
export function stockCountLabel(available: number): string | null {
  return available > 0 ? `${available} in stock` : null;
}
