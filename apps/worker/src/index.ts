import pino from "pino";
import { createDbClient } from "@ms/db";
import { sweepExpiredReservations } from "@ms/domain";
import { drainOutbox } from "./outbox.js";
import { checkLateCloses, isLateCloseWindow } from "./late-close.js";
import { exportAuditLog, isAuditExportWindow } from "./jobs/audit-export.js";
import { queuePaymentReminders } from "./jobs/unpaid-reminder.js";
import { runDeliveryWatchdog } from "./jobs/delivery-watchdog.js";
import { runDueCronJobs } from "./jobs/cron.js";
import { sweepStuckPayazaOrders } from "./jobs/payaza-reconcile.js";
import { expireUnpaidOrders } from "./jobs/expire-unpaid-orders.js";
import { pruneCheckoutLog } from "./jobs/prune-checkout-log.js";
import { runJob } from "./jobs/run-job.js";

const logger = pino({ base: { service: "ms-worker" } });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");

const db = createDbClient(databaseUrl);
const POLL_MS = 5000;
const SWEEP_INTERVAL_MS = 60_000; // sweep expired reservations every minute
const LATE_CLOSE_INTERVAL_MS = 60 * 60 * 1000; // check hourly
const REMINDER_INTERVAL_MS = 5 * 60_000; // check for unpaid orders every 5 minutes
const DELIVERY_WATCHDOG_MS = 60_000; // delivery retry/escalation every minute
const CRON_CHECK_INTERVAL_MS = 15 * 60_000; // cron poll every 15 minutes
const PAYAZA_RECONCILE_INTERVAL_MS = 120_000; // re-fire stuck Payaza webhooks every 2 minutes
const EXPIRE_UNPAID_INTERVAL_MS = 5 * 60_000; // auto-cancel abandoned online orders every 5 minutes
const PRUNE_CHECKOUT_LOG_INTERVAL_MS = 6 * 60 * 60_000; // prune old checkout-log rows every 6h

let stopping = false;
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, "worker shutting down");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let lastSweepAt = 0;
let lastLateCheckAt = 0;
let lastReminderAt = 0;
let lastDeliveryWatchdogAt = 0;
let lastCronCheckAt = 0;
let lastPayazaReconcileAt = 0;
let lastExpireUnpaidAt = 0;
let lastPruneCheckoutLogAt = 0;
let lastAuditExportDate: string | null = null;

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      // Each job is wrapped in runJob so a failure logs and returns undefined
      // without preventing the remaining jobs in this tick from running.
      const processed = await runJob(logger, "outbox", () => drainOutbox(db));
      if ((processed ?? 0) > 0) {
        logger.info({ processed }, "outbox batch drained");
      }

      // Reservation sweeper runs on its own cadence inside the same loop.
      const now = Date.now();
      if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
        const swept = await runJob(logger, "reservation_sweep", () => sweepExpiredReservations(db));
        if ((swept ?? 0) > 0) logger.info({ swept }, "expired reservations swept");
        lastSweepAt = now;
      }

      // Late-close alerts: hourly, but only during the 23:00–02:00 Lagos window.
      if (now - lastLateCheckAt > LATE_CLOSE_INTERVAL_MS && isLateCloseWindow()) {
        const emitted = await runJob(logger, "late_close", () => checkLateCloses(db));
        if ((emitted ?? 0) > 0) logger.info({ emitted }, "late close alerts emitted");
        lastLateCheckAt = now;
      }

      // Unpaid-online-order reminders: every 5 minutes.
      if (now - lastReminderAt > REMINDER_INTERVAL_MS) {
        const queued = await runJob(logger, "payment_reminders", () => queuePaymentReminders(db));
        if ((queued ?? 0) > 0) logger.info({ queued }, "payment reminders queued");
        lastReminderAt = now;
      }

      // Delivery watchdog: retry or escalate stuck deliveries every min.
      if (now - lastDeliveryWatchdogAt > DELIVERY_WATCHDOG_MS) {
        const actions = await runJob(logger, "delivery_watchdog", () => runDeliveryWatchdog(db));
        if ((actions ?? 0) > 0) logger.info({ actions }, "delivery watchdog took action");
        lastDeliveryWatchdogAt = now;
      }

      // Payaza reconcile sweep: re-fire the api webhook for online orders
      // stuck in confirmed with a live reservation, every 2 minutes, so a
      // completed payment is never lost if the webhook didn't fire.
      if (now - lastPayazaReconcileAt > PAYAZA_RECONCILE_INTERVAL_MS) {
        const n = await runJob(logger, "payaza_reconcile", () => sweepStuckPayazaOrders(db));
        if (n && n > 0) logger.info({ reconciled: n }, "payaza reconcile sweep recovered orders");
        lastPayazaReconcileAt = now;
      }

      // Auto-cancel abandoned unpaid online orders older than 60 minutes and
      // release their stock reservations. Runs every 5 minutes.
      if (now - lastExpireUnpaidAt > EXPIRE_UNPAID_INTERVAL_MS) {
        const expired = await runJob(logger, "expire_unpaid_orders", () => expireUnpaidOrders(db));
        if ((expired ?? 0) > 0) logger.info({ expired }, "abandoned unpaid online orders cancelled");
        lastExpireUnpaidAt = now;
      }

      // Prune the checkout attempt log (PII auto-deleted after 30 days). Every 6h.
      if (now - lastPruneCheckoutLogAt > PRUNE_CHECKOUT_LOG_INTERVAL_MS) {
        const pruned = await runJob(logger, "prune_checkout_log", () => pruneCheckoutLog(db));
        if ((pruned ?? 0) > 0) logger.info({ pruned }, "old checkout-log rows pruned");
        lastPruneCheckoutLogAt = now;
      }

      // Cron jobs: monthly P&L digest + recurring expense sweep. Idempotent
      // via the cron_run table so a restart never double-fires.
      if (now - lastCronCheckAt > CRON_CHECK_INTERVAL_MS) {
        await runJob(logger, "cron", () => runDueCronJobs(db));
        lastCronCheckAt = now;
      }

      // Nightly audit-log export to R2. Skips itself if env not configured.
      if (isAuditExportWindow(lastAuditExportDate)) {
        const result = await runJob(logger, "audit_export", () => exportAuditLog(db));
        if (result && !result.skipped) {
          logger.info({ key: result.key, bytes: result.bytes }, "audit export uploaded");
        }
        lastAuditExportDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
      }
    } catch (err) {
      // Final safety net — catches anything runJob itself might miss (e.g. a
      // synchronous throw from isLateCloseWindow or interval arithmetic).
      logger.error({ err }, "worker loop error");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

logger.info({ pollMs: POLL_MS, sweepIntervalMs: SWEEP_INTERVAL_MS }, "worker started");
await loop();
logger.info("worker exited");
