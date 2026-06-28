// packages/shared/src/delivery-schedule.ts
export type DeliveryWindow = "morning" | "afternoon" | "evening";
export interface LineKind { sizeMl: number; inStock: boolean }

const LAGOS_OFFSET_MS = 3_600_000; // UTC+1, no DST
export const WINDOWS: Record<DeliveryWindow, { startHour: number; anchorHour: number }> = {
  morning: { startHour: 8, anchorHour: 9 },
  afternoon: { startHour: 12, anchorHour: 14 },
  evening: { startHour: 16, anchorHour: 18 },
};
const ORDER: DeliveryWindow[] = ["morning", "afternoon", "evening"];

interface LagosParts { dateStr: string; dow: number; hour: number }
function lagos(now: Date): LagosParts {
  const l = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const y = l.getUTCFullYear();
  const m = String(l.getUTCMonth() + 1).padStart(2, "0");
  const d = String(l.getUTCDate()).padStart(2, "0");
  return { dateStr: `${y}-${m}-${d}`, dow: l.getUTCDay(), hour: l.getUTCHours() };
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00+01:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return lagos(d).dateStr;
}
function dowOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00+01:00`).getUTCDay();
}

/** Windows offered on a given day-of-week (Sunday = 0 excludes morning). */
export function availableWindows(dow: number): DeliveryWindow[] {
  return dow === 0 ? ["afternoon", "evening"] : [...ORDER];
}
function remainingToday(p: LagosParts): DeliveryWindow[] {
  return availableWindows(p.dow).filter((w) => p.hour < WINDOWS[w].startHour);
}

export function lineTarget(now: Date, line: LineKind): {
  date: string; fixedWindow?: DeliveryWindow; selectableWindows: DeliveryWindow[];
} {
  const p = lagos(now);
  const isLarge = line.sizeMl >= 500;
  if (line.inStock) {
    const rem = remainingToday(p);
    if (rem.length) return { date: p.dateStr, selectableWindows: rem };
    const nd = addDays(p.dateStr, 1);
    return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
  }
  // preorder
  if (p.dow === 0) { // Sunday override: OOS -> Monday
    const nd = addDays(p.dateStr, 1);
    if (isLarge) return { date: nd, fixedWindow: "evening", selectableWindows: [] };
    return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
  }
  if (isLarge) {
    const eveningAhead = p.hour < WINDOWS.evening.startHour;
    const date = eveningAhead ? p.dateStr : addDays(p.dateStr, 1);
    return { date, fixedWindow: "evening", selectableWindows: [] };
  }
  const nd = addDays(p.dateStr, 1); // 330
  return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
}

export function orderSchedule(now: Date, lines: LineKind[]): {
  date: string; fixedWindow?: DeliveryWindow; selectableWindows: DeliveryWindow[];
} {
  if (lines.length === 0) {
    const p = lagos(now);
    const rem = remainingToday(p);
    if (rem.length) return { date: p.dateStr, selectableWindows: rem };
    const nd = addDays(p.dateStr, 1);
    return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
  }
  const targets = lines.map((l) => lineTarget(now, l));
  const finalDate = targets.map((t) => t.date).sort().at(-1)!;
  const onFinal = targets.filter((t) => t.date === finalDate);
  if (onFinal.some((t) => t.fixedWindow === "evening")) {
    return { date: finalDate, fixedWindow: "evening", selectableWindows: [] };
  }
  const todayStr = lagos(now).dateStr;
  const windows = finalDate === todayStr ? remainingToday(lagos(now)) : availableWindows(dowOf(finalDate));
  return { date: finalDate, selectableWindows: windows };
}

export function scheduledIso(date: string, window: DeliveryWindow): string {
  const hh = String(WINDOWS[window].anchorHour).padStart(2, "0");
  return `${date}T${hh}:00:00+01:00`;
}
