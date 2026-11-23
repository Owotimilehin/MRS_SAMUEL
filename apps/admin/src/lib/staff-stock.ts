/**
 * Pure helpers for the owner Staff sales page and the per-size "running low"
 * level. Kept out of the components so they can be unit-tested.
 */

/** Used when a size has no level of its own (matches the API). */
export const DEFAULT_LOW_STOCK_LEVEL = 10;

export type PeriodPreset = "today" | "week" | "month" | "custom";

/**
 * The Lagos date range for a preset. `today` is a Lagos yyyy-mm-dd (see
 * lagosToday). A week starts on Monday; a month on the 1st. Both end today.
 */
export function periodRange(preset: Exclude<PeriodPreset, "custom">, today: string): { from: string; to: string } {
  if (preset === "today") return { from: today, to: today };
  if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  const d = new Date(`${today}T00:00:00Z`);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - daysSinceMonday * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: today };
}

/**
 * Read the owner's typed alert level. Empty = null (use the default of 10).
 * Whole numbers 0 and up only.
 */
export function parseLowStockLevel(input: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = input.trim();
  if (s === "") return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: "Enter a whole number, 0 or more, or leave it empty for the default of 10." };
  const n = Number(s);
  if (n > 100_000) return { ok: false, error: "That level is too high." };
  return { ok: true, value: n };
}

export interface StaffRow {
  user_id: string | null;
  name: string;
  email: string | null;
  role: string | null;
  branch_id: string;
  branch_name: string;
  orders: number;
  bottles: number;
  gross_ngn: number;
  refunds_ngn: number;
  net_ngn: number;
  avg_order_ngn: number;
  closes_submitted: number;
  short_count: number;
  short_total_ngn: number;
}

export type StaffSortKey =
  | "name"
  | "branch_name"
  | "orders"
  | "bottles"
  | "gross_ngn"
  | "refunds_ngn"
  | "net_ngn"
  | "avg_order_ngn"
  | "short_count"
  | "short_total_ngn";

export function sortStaffRows(rows: StaffRow[], key: StaffSortKey, dir: "asc" | "desc"): StaffRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return cmp * sign || a.name.localeCompare(b.name);
  });
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  branch_staff: "Branch staff",
};

export function roleLabel(role: string | null): string {
  if (!role) return "—";
  return ROLE_LABEL[role] ?? role;
}

/** Rows for the CSV export, with plain-English column names. Money in whole naira. */
export function staffCsvRows(rows: StaffRow[]): Array<Record<string, string | number>> {
  return rows.map((r) => ({
    "Staff member": r.name,
    Email: r.email ?? "",
    Role: roleLabel(r.role),
    Branch: r.branch_name,
    Orders: r.orders,
    Bottles: r.bottles,
    "Sales (₦)": r.gross_ngn,
    "Refunds (₦)": r.refunds_ngn,
    "Net sales (₦)": r.net_ngn,
    "Average sale (₦)": r.avg_order_ngn,
    "Shift-ends submitted": r.closes_submitted,
    "Shift-ends short": r.short_count,
    "Total short (₦)": r.short_total_ngn,
  }));
}
