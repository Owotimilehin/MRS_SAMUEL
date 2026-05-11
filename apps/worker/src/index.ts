import pino from "pino";
import { createDbClient } from "@ms/db";
import { sweepExpiredReservations } from "@ms/domain";
import { drainOutbox } from "./outbox.js";
import { checkLateCloses, isLateCloseWindow } from "./late-close.js";
import { exportAuditLog, isAuditExportWindow } from "./jobs/audit-export.js";

const logger = pino({ base: { service: "ms-worker" } });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");

const db = createDbClient(databaseUrl);
const POLL_MS = 5000;
const SWEEP_INTERVAL_MS = 60_000; // sweep expired reservations every minute
const LATE_CLOSE_INTERVAL_MS = 60 * 60 * 1000; // check hourly

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
let lastAuditExportDate: string | null = null;

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      const processed = await drainOutbox(db);
      if (processed > 0) {
        logger.info({ processed }, "outbox batch drained");
      }

      // Reservation sweeper runs on its own cadence inside the same loop.
      const now = Date.now();
      if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
        const swept = await sweepExpiredReservations(db);
        if (swept > 0) logger.info({ swept }, "expired reservations swept");
        lastSweepAt = now;
      }

      // Late-close alerts: hourly, but only during the 23:00–02:00 Lagos window.
      if (now - lastLateCheckAt > LATE_CLOSE_INTERVAL_MS && isLateCloseWindow()) {
        const emitted = await checkLateCloses(db);
        if (emitted > 0) logger.info({ emitted }, "late close alerts emitted");
        lastLateCheckAt = now;
      }

      // Nightly audit-log export to R2. Skips itself if env not configured.
      if (isAuditExportWindow(lastAuditExportDate)) {
        const result = await exportAuditLog(db);
        if (!result.skipped) {
          logger.info({ key: result.key, bytes: result.bytes }, "audit export uploaded");
        }
        lastAuditExportDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
      }
    } catch (err) {
      logger.error({ err }, "worker loop error");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

logger.info({ pollMs: POLL_MS, sweepIntervalMs: SWEEP_INTERVAL_MS }, "worker started");
await loop();
logger.info("worker exited");
