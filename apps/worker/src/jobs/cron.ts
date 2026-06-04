import { sql } from "drizzle-orm";
import { cronRun, type DbClient } from "@ms/db";
import { fireMonthlyPnlDigest, shouldFirePnlDigestNow } from "./pnl-digest.js";
import { sweepRecurringExpenses } from "./recurring-expense-sweeper.js";

/** Take the current moment in Africa/Lagos as { year, month, day, hour }. */
export function nowLagos(d: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  // toLocaleString → "06/05/2026, 09:14:33" in en-NG ish; safer to parse parts.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
  };
}

/** Atomic claim: insert into cron_run; UNIQUE violation means another worker
 *  already ran this job for this scope. Returns true on success, false on
 *  conflict, throws on real errors. */
export async function claimCronRun(
  db: DbClient,
  jobName: string,
  runFor: string,
): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      INSERT INTO "cron_run" ("job_name", "run_for")
      VALUES (${jobName}, ${runFor})
      ON CONFLICT ON CONSTRAINT "uq_cron_job_run_for" DO NOTHING
      RETURNING id
    `);
    // Older postgres-js may not expose rowCount; use rows length.
    const rows = result as unknown as { length: number };
    if (typeof rows.length === "number") return rows.length > 0;
    // Fallback: re-select.
    const check = await db
      .select()
      .from(cronRun)
      .where(sql`${cronRun.jobName} = ${jobName} AND ${cronRun.runFor} = ${runFor}`);
    return check.length > 0;
  } catch (err) {
    // Race with another worker on the unique constraint is fine.
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique/i.test(message)) return false;
    throw err;
  }
}

/** Walk the registered jobs, run anything due. Idempotent via cron_run. */
export async function runDueCronJobs(db: DbClient): Promise<void> {
  const lagos = nowLagos();
  // Monthly P&L digest: day 1, hour >= 9.
  if (shouldFirePnlDigestNow(lagos)) {
    // run_for = previous month
    const prevMonthIso = (() => {
      const y = lagos.month === 1 ? lagos.year - 1 : lagos.year;
      const m = lagos.month === 1 ? 12 : lagos.month - 1;
      return `${y}-${String(m).padStart(2, "0")}`;
    })();
    const claimed = await claimCronRun(db, "pnl_monthly_digest", prevMonthIso);
    if (claimed) {
      await fireMonthlyPnlDigest(db, prevMonthIso);
    }
  }

  // Recurring expense sweeper: daily, fires as soon as hour >= 6 to give
  // the owner the books in their morning view.
  if (lagos.hour >= 6) {
    const todayIso = `${lagos.year}-${String(lagos.month).padStart(2, "0")}-${String(lagos.day).padStart(2, "0")}`;
    const claimed = await claimCronRun(db, "recurring_expenses", todayIso);
    if (claimed) {
      await sweepRecurringExpenses(db, todayIso, lagos);
    }
  }
}
