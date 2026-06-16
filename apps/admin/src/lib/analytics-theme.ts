// Shared visual language for the Analytics charts so every chart reads as one
// family and matches the Juice Skin. Colours are pulled from the brand palette
// (deep greens → orange → gold), with formatters for ₦ axes/tooltips.

/** Ordered colour sequence for categorical series (channels, categories, …). */
export const SERIES_COLORS = [
  "#1f7a44", // brand green
  "#e85d1c", // brand orange
  "#f6b545", // gold
  "#2c8a4e", // light green
  "#c0286a", // ruby
  "#6b4ea8", // grape
  "#3a9e6a", // mint
  "#d98a04", // turmeric
];

export const COLOR_REVENUE = "#1f7a44";
export const COLOR_ORDERS = "#e85d1c";
export const COLOR_GRID = "rgba(20,40,24,0.08)";
export const COLOR_AXIS = "#5f6f63";

export const colorAt = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length]!;

/** Full naira amount, e.g. ₦1,250,000. */
export function ngn(n: number): string {
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}

/** Compact naira for axis ticks, e.g. ₦1.2M, ₦340k, ₦0. */
export function ngnCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `₦${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `₦${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `₦${Math.round(n)}`;
}

/** "Jun 8" style label from an ISO date (YYYY-MM-DD). */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-NG", { month: "short", day: "numeric" });
}

export const CHANNEL_LABEL: Record<string, string> = {
  walkup: "Walk-up",
  whatsapp: "WhatsApp",
  chowdeck_pickup: "Chowdeck",
  online: "Online",
  web: "Web",
};
export const channelLabel = (c: string): string =>
  CHANNEL_LABEL[c] ?? c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
