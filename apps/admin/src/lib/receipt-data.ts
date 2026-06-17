/**
 * Normalized receipt model + builders. Pure and transport-agnostic: the same
 * `ReceiptData` feeds the ESC/POS composer (`receipt-escpos.ts`) for direct
 * printing and could feed an on-screen preview. Builders assemble it from the
 * POS cart (offline) or a fetched order/return (reprints).
 */

export type ReceiptStyle = "classic" | "branded" | "marketing";

export interface ReceiptLine {
  name: string;
  sizeMl: number | null;
  qty: number;
  unitNgn: number;
  lineNgn: number;
}

export interface ReceiptData {
  style: ReceiptStyle;
  kind: "sale" | "preorder" | "return";
  receiptNo: string;
  dateLabel: string;
  branchName: string;
  branchAddress: string;
  branchPhone: string;
  servedBy: string;
  channelLabel: string;
  paymentLabel: string;
  lines: ReceiptLine[];
  subtotalNgn: number;
  totalNgn: number;
  cashNgn?: number;
  changeNgn?: number;
  fulfilLabel?: string;
  /** Return slips show a refund + reason instead of a payment. */
  refundNgn?: number;
  refundReason?: string;
}

const CHANNELS: Record<string, string> = {
  walkup: "Walk-in",
  whatsapp: "WhatsApp",
  chowdeck_pickup: "Chowdeck",
  chowdeck_external: "Chowdeck",
  online: "Online",
  phone: "Phone",
};

const PAYMENTS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  transfer: "Transfer",
  online: "Online",
  prepaid: "Prepaid",
};

export function channelLabel(c: string | null | undefined): string {
  if (!c) return "—";
  return CHANNELS[c] ?? c.replace(/_/g, " ");
}

export function paymentLabel(p: string | null | undefined): string {
  if (!p) return "—";
  return PAYMENTS[p] ?? p.replace(/_/g, " ");
}

/** "16 Jun 2026 · 21:18" in Africa/Lagos. */
export function lagosDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${date} · ${time}`;
}

export function sizeMlLabel(ml: number | null): string {
  if (ml == null) return "";
  return ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`;
}

/** Sum helper so callers never hand-roll the total math. */
export function sumLines(lines: ReceiptLine[]): number {
  return lines.reduce((n, l) => n + l.lineNgn, 0);
}

// ---- Builders -------------------------------------------------------------

export interface BranchInfo {
  name: string;
  address: string | null;
  phone: string | null;
}

export interface CartLineInput {
  name: string;
  sizeMl: number | null;
  qty: number;
  unitNgn: number;
}

/** Build a sale receipt from POS cart state (offline-safe; no server needed). */
export function buildReceiptFromCart(args: {
  style: ReceiptStyle;
  receiptNo: string;
  whenIso: string;
  branch: BranchInfo;
  servedBy: string;
  channel: string;
  payment: string;
  items: CartLineInput[];
  cashNgn?: number;
  isPreorder?: boolean;
  fulfilIso?: string;
}): ReceiptData {
  const lines: ReceiptLine[] = args.items.map((i) => ({
    name: i.name,
    sizeMl: i.sizeMl,
    qty: i.qty,
    unitNgn: i.unitNgn,
    lineNgn: i.unitNgn * i.qty,
  }));
  const subtotal = sumLines(lines);
  const total = subtotal;
  const cash = args.payment === "cash" ? args.cashNgn : undefined;
  return {
    style: args.style,
    kind: args.isPreorder ? "preorder" : "sale",
    receiptNo: args.receiptNo,
    dateLabel: lagosDateLabel(args.whenIso),
    branchName: args.branch.name,
    branchAddress: args.branch.address ?? "",
    branchPhone: args.branch.phone ?? "",
    servedBy: args.servedBy,
    channelLabel: channelLabel(args.channel),
    paymentLabel: paymentLabel(args.payment),
    lines,
    subtotalNgn: subtotal,
    totalNgn: total,
    ...(cash != null ? { cashNgn: cash, changeNgn: Math.max(0, cash - total) } : {}),
    ...(args.isPreorder && args.fulfilIso
      ? { fulfilLabel: lagosDateLabel(args.fulfilIso) }
      : {}),
  };
}

export interface OrderItemInput {
  name: string;
  sizeMl: number | null;
  quantity: number;
  unitPriceNgn: number;
  lineTotalNgn: number;
}

/** Build a reprint from a fetched order (sale / online / preorder). */
export function buildReceiptFromOrder(args: {
  style: ReceiptStyle;
  orderNumber: string;
  createdAtIso: string;
  branch: BranchInfo;
  servedBy: string;
  channel: string;
  payment: string;
  items: OrderItemInput[];
  subtotalNgn: number;
  totalNgn: number;
  isPreorder?: boolean;
  fulfilIso?: string;
}): ReceiptData {
  const lines: ReceiptLine[] = args.items.map((i) => ({
    name: i.name,
    sizeMl: i.sizeMl,
    qty: i.quantity,
    unitNgn: i.unitPriceNgn,
    lineNgn: i.lineTotalNgn,
  }));
  return {
    style: args.style,
    kind: args.isPreorder ? "preorder" : "sale",
    receiptNo: args.orderNumber,
    dateLabel: lagosDateLabel(args.createdAtIso),
    branchName: args.branch.name,
    branchAddress: args.branch.address ?? "",
    branchPhone: args.branch.phone ?? "",
    servedBy: args.servedBy,
    channelLabel: channelLabel(args.channel),
    paymentLabel: paymentLabel(args.payment),
    lines,
    subtotalNgn: args.subtotalNgn,
    totalNgn: args.totalNgn,
    ...(args.isPreorder && args.fulfilIso
      ? { fulfilLabel: lagosDateLabel(args.fulfilIso) }
      : {}),
  };
}

/** Build a return/refund slip. */
export function buildReturnSlip(args: {
  style: ReceiptStyle;
  returnNumber: string;
  createdAtIso: string;
  branch: BranchInfo;
  servedBy: string;
  items: OrderItemInput[];
  refundNgn: number;
  reason: string;
}): ReceiptData {
  const lines: ReceiptLine[] = args.items.map((i) => ({
    name: i.name,
    sizeMl: i.sizeMl,
    qty: i.quantity,
    unitNgn: i.unitPriceNgn,
    lineNgn: i.lineTotalNgn,
  }));
  return {
    style: args.style,
    kind: "return",
    receiptNo: args.returnNumber,
    dateLabel: lagosDateLabel(args.createdAtIso),
    branchName: args.branch.name,
    branchAddress: args.branch.address ?? "",
    branchPhone: args.branch.phone ?? "",
    servedBy: args.servedBy,
    channelLabel: "Return",
    paymentLabel: "Refund",
    lines,
    subtotalNgn: sumLines(lines),
    totalNgn: sumLines(lines),
    refundNgn: args.refundNgn,
    refundReason: args.reason,
  };
}
