// Pure helpers for the owner overview (routes/owner/dashboard.tsx), kept out of
// the component so they can be unit-tested.

import { ngn } from "./format.js";

/** Lagos is UTC+1 all year (no DST). */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function lagosNow(now: Date): Date {
  // A Date whose UTC fields read as Lagos wall-clock time.
  return new Date(now.getTime() + LAGOS_OFFSET_MS);
}

export function lagosDate(now: Date = new Date()): string {
  return lagosNow(now).toISOString().slice(0, 10);
}

export function lagosDaysAgo(n: number, now: Date = new Date()): string {
  return lagosDate(new Date(now.getTime() - n * 86_400_000));
}

/** Monday of the current Lagos week. */
export function lagosWeekStart(now: Date = new Date()): string {
  const l = lagosNow(now);
  const dow = (l.getUTCDay() + 6) % 7; // 0 = Monday
  l.setUTCDate(l.getUTCDate() - dow);
  return l.toISOString().slice(0, 10);
}

export function lagosMonthStart(now: Date = new Date()): string {
  return `${lagosDate(now).slice(0, 7)}-01`;
}

export function greeting(now: Date = new Date()): string {
  const h = lagosNow(now).getUTCHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** "Monday, 23 November · 3:40pm" in Lagos time. */
export function heroStamp(now: Date = new Date()): string {
  const day = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Africa/Lagos",
  });
  const time = now
    .toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Lagos" })
    .replace(/\s/g, "")
    .toLowerCase();
  return `${day} · ${time}`;
}

/** ₦962,600 → ₦963k; ₦1,250,000 → ₦1.3m. For axis labels only. */
export function ngnShort(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1_000_000) return `${sign}₦${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}m`;
  if (a >= 1_000) return `${sign}₦${Math.round(a / 1_000)}k`;
  return `${sign}₦${a}`;
}

// ── Needs you now ──────────────────────────────────────────────────────────

export type NeedTone = "bad" | "warn" | "or" | "leaf";

export interface NeedItem {
  key: string;
  tone: NeedTone;
  title: string;
  detail: string;
  action: string;
  to: string;
}

export interface ReviewData {
  pending_closes?: Array<{
    id: string;
    branch_name: string | null;
    business_date: string;
    variance_ngn: number;
  }>;
  transfer_variances: Array<{ id: string; transferNumber: string; status: string }>;
  return_approvals: Array<{
    id: string;
    originalSaleOrderNumber: string | null;
    refundAmountNgn: number;
  }>;
  payment_attention?: Array<{ id: string; order_number: string; total_ngn: number }>;
}

export interface OverviewData {
  stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
  fulfilment: {
    pos_orders_today: number;
    online_orders_today: number;
    online_pending: number;
    preorders_open: number;
    bags_queue: number;
    pending_transfers: number;
  };
  today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
}

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Everything waiting on the owner, most urgent first. */
export function buildNeeds(review: ReviewData | null, ov: OverviewData | null): NeedItem[] {
  const out: NeedItem[] = [];
  for (const c of review?.pending_closes ?? []) {
    const v = c.variance_ngn;
    const diff = v === 0 ? "counted exactly" : v < 0 ? `counted ${ngn(-v)} short` : `counted ${ngn(v)} over`;
    out.push({
      key: `close-${c.id}`,
      tone: v < 0 ? "bad" : "warn",
      title: "Shift close waiting for approval",
      detail: `${c.branch_name ?? "Branch"} · ${shortDay(c.business_date)} · ${diff}`,
      action: "Approve",
      to: "/owner/review",
    });
  }
  for (const t of review?.transfer_variances ?? []) {
    out.push({
      key: `xfer-${t.id}`,
      tone: "warn",
      title: `Transfer ${t.transferNumber} received with a difference`,
      detail: "Count doesn't match what the factory sent",
      action: "Settle",
      to: "/owner/review",
    });
  }
  for (const r of review?.return_approvals ?? []) {
    out.push({
      key: `ret-${r.id}`,
      tone: "warn",
      title: "Return waiting for approval",
      detail: `${r.originalSaleOrderNumber ?? "Order"} · ${ngn(r.refundAmountNgn)} refund`,
      action: "Review",
      to: "/owner/review",
    });
  }
  const pay = review?.payment_attention ?? [];
  if (pay.length > 0) {
    const total = pay.reduce((s, p) => s + p.total_ngn, 0);
    out.push({
      key: "payments",
      tone: "or",
      title: `${plural(pay.length, "payment")} to check`,
      detail: `${pay.slice(0, 2).map((p) => p.order_number).join(", ")}${pay.length > 2 ? "…" : ""} · ${ngn(total)} total`,
      action: "Check",
      to: "/owner/review",
    });
  }
  if (ov && ov.fulfilment.online_pending > 0) {
    out.push({
      key: "online",
      tone: "or",
      title: `${plural(ov.fulfilment.online_pending, "online order")} awaiting fulfilment`,
      detail: `${ov.fulfilment.online_orders_today} online today`,
      action: "Open",
      to: "/owner/online-orders",
    });
  }
  if (ov && (ov.stock.low_stock_factory > 0 || ov.stock.low_stock_branch > 0)) {
    out.push({
      key: "lowstock",
      tone: "leaf",
      title: "Stock running low",
      detail: `${ov.stock.low_stock_factory} at the factory · ${ov.stock.low_stock_branch} at the shops`,
      action: "Stock",
      to: "/owner/inventory",
    });
  }
  if (ov && ov.stock.expiring_48h > 0) {
    out.push({
      key: "expiring",
      tone: "warn",
      title: `${plural(ov.stock.expiring_48h, "batch", "batches")} expiring within 48 hours`,
      detail: "Sell or move these first",
      action: "Stock",
      to: "/owner/inventory",
    });
  }
  return out;
}

// ── Sales channels ─────────────────────────────────────────────────────────

/** Fixed order and colour per channel (validated light + dark; never re-ordered by size). */
export const CHANNELS = [
  { key: "walkup", label: "Walk-up", varName: "--ch-1" },
  { key: "online", label: "Online", varName: "--ch-2" },
  { key: "whatsapp", label: "WhatsApp", varName: "--ch-3" },
  { key: "phone", label: "Phone", varName: "--ch-4" },
  { key: "other", label: "Other", varName: "--ch-5" },
] as const;

export function channelTotals(
  rows: Array<{ channel: string; net_ngn: number }>,
): Array<{ key: string; label: string; varName: string; net: number }> {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const k = CHANNELS.some((c) => c.key === r.channel) ? r.channel : "other";
    sums.set(k, (sums.get(k) ?? 0) + r.net_ngn);
  }
  return CHANNELS.map((c) => ({ ...c, net: sums.get(c.key) ?? 0 })).filter((c) => c.net > 0);
}
