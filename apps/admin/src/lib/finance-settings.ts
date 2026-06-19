/**
 * Which expense categories count toward the owner's daily-profit figure.
 * Persisted per-device in localStorage; passed to GET /reports/daily as the
 * `expense_categories` query param. The `packaging` category is deliberately
 * NOT selectable here — bottle/bag bulk purchases are counted per-unit (FIFO)
 * and are always excluded from the daily expenses line.
 */
export type DailyExpenseCategory =
  | "raw_materials" | "utilities" | "transport" | "salaries" | "rent"
  | "marketing" | "equipment" | "regulatory" | "other_with_note";

export const DAILY_EXPENSE_CATEGORIES: { code: DailyExpenseCategory; label: string }[] = [
  { code: "raw_materials", label: "Raw materials" },
  { code: "utilities", label: "Utilities" },
  { code: "transport", label: "Transport" },
  { code: "salaries", label: "Salaries" },
  { code: "rent", label: "Rent" },
  { code: "marketing", label: "Marketing" },
  { code: "equipment", label: "Equipment" },
  { code: "regulatory", label: "Regulatory" },
  { code: "other_with_note", label: "Other" },
];

const KEY = "ms_daily_expense_categories";
const ALL = DAILY_EXPENSE_CATEGORIES.map((c) => c.code);

export function getIncludedExpenseCategories(): DailyExpenseCategory[] {
  if (typeof localStorage === "undefined") return [...ALL];
  const raw = localStorage.getItem(KEY);
  if (!raw) return [...ALL];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...ALL];
    const valid = parsed.filter((v): v is DailyExpenseCategory => ALL.includes(v as DailyExpenseCategory));
    return valid.length > 0 ? valid : [...ALL];
  } catch {
    return [...ALL];
  }
}

export function setIncludedExpenseCategories(codes: DailyExpenseCategory[]): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(codes));
}
