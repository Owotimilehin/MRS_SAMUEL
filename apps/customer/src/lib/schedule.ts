export type DeliveryWindow = "morning" | "afternoon" | "evening";

export interface WindowDef {
  id: DeliveryWindow;
  label: string;
  hour24: number;
}

// Each window maps to a single fixed Lagos time so the API receives one
// `scheduled_delivery_at` instant.
export const WINDOWS: WindowDef[] = [
  { id: "morning", label: "Morning · 9am–12pm", hour24: 10 },
  { id: "afternoon", label: "Afternoon · 12–4pm", hour24: 14 },
  { id: "evening", label: "Evening · 4–7pm", hour24: 17 },
];

// Lagos (Africa/Lagos) is UTC+1 year-round with no DST, so a literal +01:00
// offset is exact and needs no timezone library.
export function scheduledIso(date: string, window: DeliveryWindow): string {
  const w = WINDOWS.find((x) => x.id === window);
  if (!w) throw new Error(`unknown delivery window: ${window}`);
  const hh = String(w.hour24).padStart(2, "0");
  return `${date}T${hh}:00:00+01:00`;
}

export function isWindowAvailable(
  date: string,
  window: DeliveryWindow,
  now: Date = new Date(),
): boolean {
  return Date.parse(scheduledIso(date, window)) > now.getTime();
}
