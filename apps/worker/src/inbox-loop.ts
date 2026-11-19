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
import {
  retryWebhookEvents,
  downloadPendingMedia,
  sendAutoReplies,
  syncAllTemplates,
  refreshPendingTemplates,
  syncAllFlows,
} from "./jobs/inbox-whatsapp.js";
import { processPendingRecordings, sendMissedCallFollowups } from "./jobs/inbox-voice.js";
import { claudeSummariserFromEnv } from "./jobs/inbox-summary.js";
import { sendMessagePushes } from "./jobs/inbox-push.js";
import { ensureMetaSubscriptions, refreshIdentityProfiles } from "./jobs/inbox-meta.js";
import { backfillComments, fillCommentDetails, pollComments } from "./jobs/social-comments.js";
import { runCatalogueBatchCheck, runCatalogueReconcile, runCatalogueSync, runChatOrderJobs } from "./jobs/catalogue.js";
import { publishDuePosts, reconcileUnknownTargets } from "./jobs/social-publish.js";
import { collectInsightsIfDue } from "./jobs/insights-collect.js";

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
  /**
   * The job guards itself against a second worker and must not run inside withJobLock's
   * open transaction (a run that talks to Meta for minutes: suite spec 11).
   */
  ownLock?: true;
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
    { name: "inbox_template_pending", everyMs: 5 * 60_000, last: 0, run: () => refreshPendingTemplates(db, logger) },
    // WhatsApp forms (suite spec 07): status only; no job creates, publishes, retires or sends a form.
    { name: "wa_flow_sync", everyMs: 60 * 60_000, last: 0, run: () => syncAllFlows(db, logger) },
    { name: "inbox_identity_profiles", everyMs: 30_000, last: 0, run: () => refreshIdentityProfiles(db, logger) },
    { name: "inbox_meta_subscriptions", everyMs: 60 * 60_000, last: 0, run: () => ensureMetaSubscriptions(db, logger) },
    // Comments on Facebook and Instagram posts (suite spec 03): these only read from Meta.
    { name: "social_comment_fill", everyMs: 15_000, last: 0, run: () => fillCommentDetails(db, logger) },
    { name: "social_comment_backfill", everyMs: 60_000, last: 0, run: () => backfillComments(db, logger) },
    { name: "social_comment_poll", everyMs: 5 * 60_000, last: 0, run: () => pollComments(db, logger) },
    // Catalogue sync (suite spec 08). Nothing is sent unless the owner has switched sync on.
    { name: "catalogue_sync", everyMs: 10_000, last: 0, run: () => runCatalogueSync(db, logger) },
    { name: "catalogue_batch_check", everyMs: 20_000, last: 0, run: () => runCatalogueBatchCheck(db, logger) },
    { name: "catalogue_reconcile", everyMs: 30 * 60_000, last: 0, run: () => runCatalogueReconcile(db, logger) },
    // Automatic cart questions and order updates: each behind an owner switch, off by default.
    { name: "catalogue_chat_orders", everyMs: 10_000, last: 0, run: () => runChatOrderJobs(db, logger) },
    // Posts to Facebook and Instagram (suite spec 09). Only posts a person approved are ever sent.
    { name: "social_publish", everyMs: 30_000, last: 0, run: () => publishDuePosts(db, logger) },
    { name: "social_publish_reconcile", everyMs: 60_000, last: 0, run: () => reconcileUnknownTargets(db, logger) },
    { name: "insights_collect", everyMs: 10 * 60_000, last: 0, ownLock: true, run: () => collectInsightsIfDue(db, logger) },
  ];
  logger.info({ jobs: jobs.map((j) => j.name) }, "inbox loop started");
  while (!isStopping()) {
    for (const job of jobs) {
      if (isStopping()) break;
      const now = Date.now();
      if (now - job.last < job.everyMs) continue;
      job.last = now;
      await runJob(logger, job.name, job.ownLock ? job.run : () => withJobLock(db, job.name, job.run));
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
