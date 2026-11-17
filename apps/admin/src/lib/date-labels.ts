// Plain-English labels for the computer-style dates the API and date inputs use
// ("2026-11", "2026-11-17"). Formatted in UTC from the parts, so the label never
// drifts a day or a month with the viewer's time zone.

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** "2026-11" → "November 2026". Anything else is returned unchanged. */
export function monthLabel(ym: string | null | undefined): string {
  if (!ym) return "—";
  const m = MONTH_RE.exec(ym);
  if (!m) return ym;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "2026-11-17" → "17 Nov 2026". Anything else is returned unchanged. */
export function dayLabel(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const m = DAY_RE.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "17 Nov 2026 – 18 Nov 2026", or just the one date when both ends match. */
export function dayRangeLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to && from === to) return dayLabel(from);
  return `${dayLabel(from)} – ${dayLabel(to)}`;
}
