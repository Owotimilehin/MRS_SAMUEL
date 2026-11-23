/**
 * Branch spending: the small money a shop pays out during the day (ice, fuel,
 * a delivery rider, cleaning), logged from the till. Stored in business_expense
 * with branch_id set. Shared by the API (validation) and the till (form).
 */

/**
 * The expense categories a shop may log. A subset of business_expense_category:
 * salaries, rent, marketing and regulatory are head-office spending, and
 * packaging is left out because the daily report counts packaging per bottle
 * sold (a cash packaging buy at a shop would never show there).
 */
export const BRANCH_EXPENSE_CATEGORIES = [
  "transport",
  "utilities",
  "raw_materials",
  "equipment",
  "other_with_note",
] as const;
export type BranchExpenseCategory = (typeof BRANCH_EXPENSE_CATEGORIES)[number];

/** Plain-English chip labels for the till. */
export const BRANCH_EXPENSE_CATEGORY_LABEL: Record<BranchExpenseCategory, string> = {
  transport: "Transport / rider",
  utilities: "Fuel & power",
  raw_materials: "Ice & supplies",
  equipment: "Repairs & tools",
  other_with_note: "Other (cleaning etc.)",
};

/** Largest single amount a shop may log, in naira. Bigger spends go through the owner. */
export const BRANCH_EXPENSE_MAX_NGN = 500_000;
/** How far back a shop may date a spend (today minus this many days, inclusive). */
export const BRANCH_EXPENSE_MAX_AGE_DAYS = 7;
export const BRANCH_EXPENSE_DESCRIPTION_MIN = 3;
export const BRANCH_EXPENSE_DESCRIPTION_MAX = 200;

/** Lagos business date (UTC+1, no daylight saving) as YYYY-MM-DD. */
export function lagosDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD date by whole days. */
export function shiftDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isRealDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/**
 * Check a branch spend's date against "today in Lagos". Returns null when the
 * date is fine, or a plain-English reason when it is not.
 */
export function branchExpenseDateProblem(ymd: string, now: Date = new Date()): string | null {
  if (!isRealDate(ymd)) return "Pick a real date.";
  const today = lagosDate(now);
  if (ymd > today) return "The date can't be in the future.";
  if (ymd < shiftDays(today, -BRANCH_EXPENSE_MAX_AGE_DAYS)) {
    return `Only spending from the last ${BRANCH_EXPENSE_MAX_AGE_DAYS} days can be logged here. Ask the owner to add older spending in Bookkeeping.`;
  }
  return null;
}

/** Monday of the Lagos week that contains `ymd` (YYYY-MM-DD). */
export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  return shiftDays(ymd, dow === 0 ? -6 : 1 - dow);
}
