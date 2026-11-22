/**
 * Pure helpers for the Overview's sales pieces (blueprint stage 16, "Owner dashboard"):
 * the previous period of equal length, the up/down comparison, naira wording and the
 * split of takings by where the sale was made. No React, no fetch, no locale: tests beside this file.
 */
import { groupThousands } from "@ms/shared";

/** One row of GET /reports/revenue: a branch and sales channel, in whole naira. */
export interface RevenueRow {
  branch_id: string;
  channel: string;
  gross_ngn: number;
  refunds_ngn: number;
  net_ngn: number;
  orders: number;
}

/** One day of GET /reports/timeseries. */
export interface SalesDay {
  date: string;
  gross_ngn: number;
  net_ngn: number;
  orders: number;
}

/** GET /reports/chat-orders: paid orders placed from a WhatsApp chat cart. */
export interface ChatOrders {
  orders: number;
  gross_ngn: number;
}

function shift(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included. */
export function daysIn(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1
  );
}

/** The same number of days straight before the period. 15–21 Nov → 8–14 Nov; today → yesterday. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const n = daysIn(from, to);
  return { from: shift(from, -n), to: shift(from, -1) };
}

export interface Change {
  direction: "up" | "down" | "same";
  /** "+12%", "−8%", "New", "Same" */
  text: string;
}

/**
 * This period against the one before. Null when both are zero (nothing to say).
 * "New" when there was nothing before, so we never print "+∞%".
 */
export function compare(current: number, previous: number): Change | null {
  if (current === 0 && previous === 0) return null;
  if (previous <= 0)
    return current > 0 ? { direction: "up", text: "New" } : { direction: "down", text: "Down" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { direction: "same", text: "Same" };
  return pct > 0
    ? { direction: "up", text: `+${pct}%` }
    : { direction: "down", text: `−${Math.abs(pct)}%` };
}

/** "₦336,000". Whole naira, no decimals; a minus sign in front when negative. */
export function nairaFull(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? "−" : ""}₦${groupThousands(Math.abs(r))}`;
}

/** "₦336,000" below a million; "₦3.12M", "₦31.2M", "₦312M" above (three figures, trailing zeros dropped). */
export function nairaShort(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r);
  if (abs < 1_000_000) return nairaFull(r);
  const m = abs / 1_000_000;
  const decimals = m < 10 ? 2 : m < 100 ? 1 : 0;
  const text = String(Number(m.toFixed(decimals)));
  return `${r < 0 ? "−" : ""}₦${text}M`;
}

/** Axis ticks: "₦0", "₦45k", "₦1.2M". */
export function nairaTick(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `₦${Number((n / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `₦${Number((n / 1_000).toFixed(abs >= 10_000 ? 0 : 1))}k`;
  return `₦${Math.round(n)}`;
}

/** Takings (after refunds) and paid orders over every branch and channel. */
export function salesTotals(rows: RevenueRow[]): { net: number; orders: number } {
  return rows.reduce((a, r) => ({ net: a.net + r.net_ngn, orders: a.orders + r.orders }), {
    net: 0,
    orders: 0,
  });
}

export interface SalesSlice {
  key: "till" | "website" | "whatsapp" | "phone" | "chowdeck" | "other";
  label: string;
  net: number;
  orders: number;
}

const SLICE: Record<string, { key: SalesSlice["key"]; label: string }> = {
  walkup: { key: "till", label: "Shop till" },
  online: { key: "website", label: "Website" },
  whatsapp: { key: "whatsapp", label: "WhatsApp" },
  phone: { key: "phone", label: "Phone orders" },
  chowdeck_pickup: { key: "chowdeck", label: "Chowdeck" },
};

/**
 * Takings by where the sale was made, largest first, empty slices left out.
 * A cart placed from a WhatsApp chat is stored as a channel "online" order, so its value
 * is moved from "Website" to "WhatsApp" (it never makes Website negative).
 */
export function salesByChannel(
  rows: RevenueRow[],
  chat: ChatOrders | null | undefined,
): SalesSlice[] {
  const acc = new Map<SalesSlice["key"], SalesSlice>();
  const add = (key: SalesSlice["key"], label: string, net: number, orders: number) => {
    const cur = acc.get(key) ?? { key, label, net: 0, orders: 0 };
    cur.net += net;
    cur.orders += orders;
    acc.set(key, cur);
  };
  for (const r of rows) {
    const s = SLICE[r.channel] ?? { key: "other" as const, label: "Other" };
    add(s.key, s.label, r.net_ngn, r.orders);
  }
  if (chat && chat.orders > 0) {
    const web = acc.get("website") ?? {
      key: "website" as const,
      label: "Website",
      net: 0,
      orders: 0,
    };
    const net = Math.min(chat.gross_ngn, Math.max(0, web.net));
    const orders = Math.min(chat.orders, Math.max(0, web.orders));
    if (net > 0 || orders > 0) {
      add("website", "Website", -net, -orders);
      add("whatsapp", "WhatsApp", net, orders);
    }
  }
  return [...acc.values()]
    .filter((s) => s.net !== 0 || s.orders !== 0)
    .sort((a, b) => b.net - a.net);
}

/** "1 order", "12 orders". */
export function ordersText(n: number): string {
  return `${n} ${n === 1 ? "order" : "orders"}`;
}
