import { lt } from "drizzle-orm";
import { checkoutAttemptLog, type DbClient } from "@ms/db";

const RETENTION_DAYS = 30;

/**
 * Delete checkout-attempt-log rows older than the 30-day retention window
 * (the log holds customer PII, so it is auto-pruned). Returns the number of
 * rows removed.
 */
export async function pruneCheckoutLog(db: DbClient): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000);
  const deleted = await db
    .delete(checkoutAttemptLog)
    .where(lt(checkoutAttemptLog.createdAt, cutoff))
    .returning({ id: checkoutAttemptLog.id });
  return deleted.length;
}
