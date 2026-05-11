import pino from "pino";
import { createDbClient } from "@ms/db";
import { drainOutbox } from "./outbox.js";

const logger = pino({ base: { service: "ms-worker" } });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");

const db = createDbClient(databaseUrl);
const POLL_MS = 5000;

let stopping = false;
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, "worker shutting down");
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      const processed = await drainOutbox(db);
      if (processed > 0) {
        logger.info({ processed }, "outbox batch drained");
      }
    } catch (err) {
      logger.error({ err }, "outbox loop error");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

logger.info({ pollMs: POLL_MS }, "worker started");
await loop();
logger.info("worker exited");
