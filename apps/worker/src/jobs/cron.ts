import pino from "pino";
import { sql } from "drizzle-orm";
import { cronRun, type DbClient } from "@ms/db";
import { fireMonthlyPnlDigest, shouldFirePnlDigestNow } from "./pnl-digest.js";
import { fireMonthlyVarianceLossDigest } from "./variance-loss-digest.js";
import { sweepRecurringExpenses } from "./recurring-expense-sweeper.js";
import { sweepSubscriptionBilling, sweepPastDueCancellations } from "./subscription-billing.js";
import { runJob } from "./run-job.js";

const cronLogger = pino({ base: { service: "ms-worker", scope: "cron" } });

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
    // claimCronRun stays OUTSIDE runJob: a DB error here should propagate so
    // the caller knows the claim itself failed (not just the digest run).
    if (await claimCronRun(db, "pnl_monthly_digest", prevMonthIso)) {
      await runJob(cronLogger, "pnl_digest", () => fireMonthlyPnlDigest(db, prevMonthIso));
    }
    // Monthly stock-loss digest fires in the same day-1 window, separately
    // claimed so it never double-fires on restart.
    if (await claimCronRun(db, "variance_loss_monthly_digest", prevMonthIso)) {
      await runJob(cronLogger, "variance_loss_digest", () => fireMonthlyVarianceLossDigest(db, prevMonthIso));
    }
  }

  // Recurring expense sweeper: daily, fires as soon as hour >= 6 to give
  // the owner the books in their morning view.
  if (lagos.hour >= 6) {
    const todayIso = `${lagos.year}-${String(lagos.month).padStart(2, "0")}-${String(lagos.day).padStart(2, "0")}`;
    // claimCronRun stays OUTSIDE runJob for the same reason as above.
    if (await claimCronRun(db, "recurring_expenses", todayIso)) {
      await runJob(cronLogger, "recurring_expenses", () => sweepRecurringExpenses(db, todayIso, lagos));
    }
  }

  // Subscription billing: charge anything due, then cancel past-due grace
  // expiries. Runs every tick (charges are due at specific timestamps, not a
  // daily window); the sweep is self-claiming per row via FOR UPDATE, and
  // cancellation is an idempotent guarded UPDATE — so no cron_run claim needed.
  await runJob(cronLogger, "subscription_billing", () => sweepSubscriptionBilling(db));
  await runJob(cronLogger, "past_due_cancellations", () => sweepPastDueCancellations(db));
}
