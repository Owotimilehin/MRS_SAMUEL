/**
 * Contacts background jobs (suite spec 14, Phase A, section 6):
 *   - refreshContactSummaries: every minute, recompute the Contacts list rows
 *     of customers something changed for (orders, chats, identities, merges)
 *   - rebuildContactSummaries: nightly, recompute every row (the safety net)
 *   - sendContactConsentConfirmations: answer a customer's STOP or START once
 *   - applyContactImports: save a confirmed spreadsheet import, 200 rows a tick
 *   - cleanupContactImports: after 30 days, drop the uploaded rows of imports
 *     that have ended (the counts stay)
 *
 * None of these changes or deletes a `customer` row, except applyContactImports,
 * which only inserts new customers and (when the importer asked) fills fields
 * that are empty.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appSetting, contactImport, contactImportRow, type DbClient } from "@ms/db";
import {
  applyImportBatch,
  metaConfigFromEnv,
  rebuildAllSummaries,
  refreshChangedSummaries,
  sendConsentConfirmations,
} from "@ms/domain";

interface Log {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export const CONTACT_SUMMARY_WATERMARK_KEY = "contact_summary_watermark";
export const IMPORT_APPLY_BATCH = 200;
export const IMPORT_ROWS_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

async function setWatermark(db: DbClient, at: Date): Promise<void> {
  const value = { at: at.toISOString() };
  await db
    .insert(appSetting)
    .values({ key: CONTACT_SUMMARY_WATERMARK_KEY, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: at } });
}

/**
 * Refresh what changed since the stored watermark, then move the watermark to
 * `now`. With no watermark (first run after the migration) every customer is
 * summarised once. Returns how many customers were refreshed.
 */
export async function refreshContactSummaries(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, CONTACT_SUMMARY_WATERMARK_KEY));
  const at = (row?.value as { at?: unknown } | undefined)?.at;
  const since = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
  let n: number;
  if (!since) {
    n = await rebuildAllSummaries(db);
    log.info({ customers: n }, "contact summaries built for the first time");
  } else {
    n = await refreshChangedSummaries(db, since, now);
  }
  await setWatermark(db, now);
  return n;
}

export async function rebuildContactSummaries(db: DbClient, log: Log): Promise<number> {
  const n = await rebuildAllSummaries(db);
  log.info({ customers: n }, "contact summaries rebuilt");
  return n;
}

/** Returns at once when WhatsApp is not configured on this server. */
export async function sendContactConsentConfirmations(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const cfg = metaConfigFromEnv();
  if (!cfg) return 0;
  const sent = await sendConsentConfirmations(db, cfg, opts.now ?? new Date());
  if (sent > 0) log.info({ sent }, "STOP/START confirmations sent");
  return sent;
}

/**
 * The oldest import waiting to be saved: one batch per tick. When nothing is
 * left it becomes `applied`. An error marks it `failed` with the reason; rows
 * already saved stay saved, and nothing is saved twice.
 */
export async function applyContactImports(db: DbClient, log: Log, opts: { batch?: number } = {}): Promise<number> {
  const [imp] = await db
    .select({ id: contactImport.id })
    .from(contactImport)
    .where(eq(contactImport.status, "applying"))
    .orderBy(asc(contactImport.createdAt))
    .limit(1);
  if (!imp) return 0;
  try {
    const { done, applied } = await applyImportBatch(db, imp.id, opts.batch ?? IMPORT_APPLY_BATCH);
    if (done) {
      // The counts become what really happened (a row previewed as new may have matched by now).
      await db.execute(sql`
        UPDATE contact_import i SET status = 'applied', applied_at = now(),
          new_count = (SELECT count(*) FROM contact_import_row r WHERE r.import_id = i.id AND r.applied_at IS NOT NULL AND r.outcome = 'new'),
          matched_count = (SELECT count(*) FROM contact_import_row r WHERE r.import_id = i.id AND r.applied_at IS NOT NULL AND r.outcome = 'matched')
        WHERE i.id = ${imp.id}::uuid AND i.status = 'applying'
      `);
      log.info({ importId: imp.id }, "contact import applied");
    }
    return applied;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(contactImport)
      .set({ status: "failed", error: message.slice(0, 500) })
      .where(and(eq(contactImport.id, imp.id), eq(contactImport.status, "applying")));
    log.error({ err, importId: imp.id }, "contact import failed part-way");
    return 0;
  }
}

/** Uploaded rows hold personal details: they go 30 days after the import ended. */
export async function cleanupContactImports(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - IMPORT_ROWS_KEPT_MS);
  const old = await db
    .select({ id: contactImport.id })
    .from(contactImport)
    .where(
      and(
        inArray(contactImport.status, ["applied", "failed", "cancelled"]),
        isNull(contactImport.rowsPurgedAt),
        sql`coalesce(${contactImport.appliedAt}, ${contactImport.previewedAt}, ${contactImport.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .limit(100);
  for (const imp of old) {
    await db.transaction(async (tx) => {
      await tx.delete(contactImportRow).where(eq(contactImportRow.importId, imp.id));
      await tx.update(contactImport).set({ rowsPurgedAt: now }).where(eq(contactImport.id, imp.id));
    });
  }
  if (old.length) log.info({ imports: old.length }, "old contact import rows removed");
  return old.length;
}
