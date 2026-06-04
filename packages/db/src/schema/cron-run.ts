import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Idempotency record for the worker's cron loop. One row per (job_name, run_for)
 * pair so a restart mid-day never double-fires.
 *
 * `run_for` is whatever scope makes the job idempotent: YYYY-MM for monthly
 * digest, YYYY-MM-DD for daily sweeps.
 */
export const cronRun = pgTable(
  "cron_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobName: text("job_name").notNull(),
    runFor: text("run_for").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ unq: unique("uq_cron_job_run_for").on(t.jobName, t.runFor) }),
);
