/**
 * Unified-inbox background jobs, on their own loop so a slow media or
 * recording download can never hold up the shop's jobs (outbox, payments,
 * deliveries) in the main worker loop.
 *
 * Safe with more than one worker process: each job takes a Postgres advisory
 * lock for its run, and a worker that can't get it simply skips that tick.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { runJob } from "./jobs/run-job.js";
import { retryWebhookEvents, downloadPendingMedia, sendAutoReplies, syncAllTemplates } from "./jobs/inbox-whatsapp.js";
import { processPendingRecordings, sendMissedCallFollowups } from "./jobs/inbox-voice.js";
import { claudeSummariserFromEnv } from "./jobs/inbox-summary.js";
import { sendMessagePushes } from "./jobs/inbox-push.js";
import { ensureMetaSubscriptions, refreshIdentityProfiles } from "./jobs/inbox-meta.js";
import { runCatalogueBatchCheck, runCatalogueReconcile, runCatalogueSync, runChatOrderJobs } from "./jobs/catalogue.js";

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

/**
 * Run fn only if no other worker is running the same job. The lock lives for
 * the surrounding transaction, which stays open (idle) while fn works through
 * the normal connection pool.
 */
export async function withJobLock<T>(db: DbClient, name: string, fn: () => Promise<T>): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`inbox-job:${name}`})) as got`,
    );
    const got = (rows as unknown as { got: boolean }[])[0]?.got === true;
    if (!got) return undefined;
    return fn();
  });
}

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  last: number;
}

export async function runInboxLoop(db: DbClient, logger: Logger, isStopping: () => boolean): Promise<void> {
  const summariser = claudeSummariserFromEnv();
  const jobs: Job[] = [
    { name: "inbox_push", everyMs: 5_000, last: 0, run: () => sendMessagePushes(db, logger) },
    { name: "inbox_auto_reply", everyMs: 10_000, last: 0, run: () => sendAutoReplies(db, logger) },
    { name: "inbox_media", everyMs: 10_000, last: 0, run: () => downloadPendingMedia(db, logger) },
    { name: "inbox_recordings", everyMs: 15_000, last: 0, run: () => processPendingRecordings(db, logger, { summariser }) },
    { name: "inbox_webhook_retry", everyMs: 30_000, last: 0, run: () => retryWebhookEvents(db, logger) },
    { name: "inbox_followups", everyMs: 60_000, last: 0, run: () => sendMissedCallFollowups(db, logger) },
    { name: "inbox_template_sync", everyMs: 60 * 60_000, last: 0, run: () => syncAllTemplates(db, logger) },
    { name: "inbox_identity_profiles", everyMs: 30_000, last: 0, run: () => refreshIdentityProfiles(db, logger) },
    { name: "inbox_meta_subscriptions", everyMs: 60 * 60_000, last: 0, run: () => ensureMetaSubscriptions(db, logger) },
    // Catalogue sync (suite spec 08). Nothing is sent unless the owner has switched sync on.
    { name: "catalogue_sync", everyMs: 10_000, last: 0, run: () => runCatalogueSync(db, logger) },
    { name: "catalogue_batch_check", everyMs: 20_000, last: 0, run: () => runCatalogueBatchCheck(db, logger) },
    { name: "catalogue_reconcile", everyMs: 30 * 60_000, last: 0, run: () => runCatalogueReconcile(db, logger) },
    // Automatic cart questions and order updates: each behind an owner switch, off by default.
    { name: "catalogue_chat_orders", everyMs: 10_000, last: 0, run: () => runChatOrderJobs(db, logger) },
  ];
  logger.info({ jobs: jobs.map((j) => j.name) }, "inbox loop started");
  while (!isStopping()) {
    for (const job of jobs) {
      if (isStopping()) break;
      const now = Date.now();
      if (now - job.last < job.everyMs) continue;
      job.last = now;
      await runJob(logger, job.name, () => withJobLock(db, job.name, job.run));
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
