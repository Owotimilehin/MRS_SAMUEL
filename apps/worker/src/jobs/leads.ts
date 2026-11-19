/**
 * Lead-form background jobs (suite spec 13, section 6):
 *   - fetchLeads:     every 15 s, read up to 10 newly arrived leads from Meta
 *   - backfillLeads:  every 60 s, one page of earlier leads for one form that asked
 *   - syncForms:      every 6 h, the same work as "Refresh forms"
 *
 * Every job returns at once when Meta is not configured. Nothing here sends a
 * message to a person: a lead only becomes a row, a customer link and (for a
 * switched-on form) a conversation with an announcing note. The work itself is
 * in @ms/domain (meta/leads.ts), which never holds a database transaction open
 * across a call to Meta.
 */
import type { DbClient } from "@ms/db";
import { backfillLeadsPage, fetchPendingLeads, metaConfigFromEnv, syncLeadForms, type MetaConfig } from "@ms/domain";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** lead_fetch. Returns how many leads were read. */
export async function fetchLeads(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  const r = await fetchPendingLeads(db, cfg, { limit: 10, now });
  if (r.failed > 0) log.warn({ failed: r.failed }, "leads could not be read from Meta");
  if (r.retry > 0) log.info({}, "Meta is busy; the remaining leads wait for the next tick");
  return r.fetched;
}

/** lead_backfill. Returns how many earlier leads were stored. */
export async function backfillLeads(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  const r = await backfillLeadsPage(db, cfg, now);
  if (!r) return 0;
  if (r.stopped) log.warn({ formId: r.formId }, "lead back-fill stopped: Meta would not let us read this form's leads");
  else if (r.done) log.info({ formId: r.formId }, "lead back-fill finished");
  return r.stored;
}

/** lead_forms_sync. Returns how many forms Meta listed. */
export async function syncForms(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  const r = await syncLeadForms(db, cfg, now);
  // Codes only: Meta's own message can name people or IDs.
  if (r.problems.length > 0) log.warn({ codes: r.problems.map((p) => p.code) }, "lead forms could not be read for a Page");
  return r.forms;
}
